// Does compare-and-swap port to the batch-commit hosts?
//
// The paper claims fast-forward-only reference updates give us a compare-and-swap
// that phase P7 depends on, and that the batch-commit hosts offer something that
// is not obviously the same guarantee. It then says we have not established
// which. That hedge is the open item; this settles it.
//
// The question is narrow and answerable. Two writers attach to the same machine
// at the same commit. Both prepare a commit whose parent is that commit. The
// first wins. If the second is also accepted, the second writer's history has
// silently replaced the first writer's work, concurrent use is unsafe on that
// host, and the design must say so rather than assume the guarantee travels.
//
// The token is read from the environment and never written anywhere. Nothing
// here prints it, and the branches it creates are deleted at the end.
//
//   GITLAB_TOKEN=... node src/analysis/cas-probe.mjs gitlab owner/repo
//   FORGEJO_TOKEN=... FORGEJO_ENDPOINT=https://codeberg.org/api/v1 \
//     node src/analysis/cas-probe.mjs forgejo owner/repo

import { createHost } from "../host/index.js";
import { Governor } from "../core/governor.js";

const kind = process.argv[2];
const slug = process.argv[3];

if (!kind || !slug || !slug.includes("/")) {
  console.error("usage: node src/analysis/cas-probe.mjs <gitlab|forgejo|github> <owner/repo>");
  process.exit(2);
}

const tokenVar = `${kind.toUpperCase()}_TOKEN`;
const token = process.env[tokenVar];
if (!token) {
  console.error(`set ${tokenVar} in the environment. It is never printed or stored.`);
  process.exit(2);
}

const [owner, repo] = slug.split("/");
const endpoint = process.env[`${kind.toUpperCase()}_ENDPOINT`] || undefined;
const branch = `cas-probe-${Date.now().toString(36)}`;
const encoder = new TextEncoder();

const host = createHost(kind, {
  token, owner, repo, endpoint,
  governor: new Governor({ ratePerMin: 60, concurrency: 2 })
});

const file = (name, text) => ({
  path: name,
  bytes: encoder.encode(text),
  id: null
});

function say(label, value) {
  console.log(`  ${label.padEnd(38)} ${value}`);
}

try {
  const who = await host.validate();
  say("connected as", who.login);
  say("repository", `${slug} (${who.private ? "private" : "public"})`);
  say("can write", String(who.canWrite));
  if (!who.canWrite) {
    console.error("\nthe token cannot write to this repository; nothing to probe");
    process.exit(1);
  }

  const caps = host.constructor.capabilities;
  say("host declares casRef", String(caps.casRef));
  console.log();

  // --- establish the machine ------------------------------------------------
  const first = await host.commit({
    branch, message: "cas probe: base",
    files: [file("probe.txt", "base")],
    parent: null, branchExists: false
  });
  say("base commit", String(first.commit).slice(0, 12));

  // --- writer A advances the branch ----------------------------------------
  const writerA = await host.commit({
    branch, message: "cas probe: writer A",
    files: [file("probe.txt", "written by A")],
    parent: first.commit, branchExists: true
  });
  say("writer A committed", String(writerA.commit).slice(0, 12));

  // --- writer B commits from the same, now stale, parent -------------------
  // This is the whole experiment. Writer B still believes the branch is at the
  // base commit. A host with a real compare-and-swap refuses; one without it
  // accepts, and writer A's work is gone.
  let accepted = false;
  let refusal = "";
  let writerB = null;
  try {
    writerB = await host.commit({
      branch, message: "cas probe: writer B from a stale parent",
      files: [file("probe.txt", "written by B")],
      parent: first.commit, branchExists: true
    });
    accepted = true;
  } catch (err) {
    refusal = `${err.status || ""} ${err.message}`.trim();
  }

  console.log();
  if (accepted) {
    say("stale write was", "ACCEPTED");
    say("writer B commit", String(writerB.commit).slice(0, 12));
  } else {
    say("stale write was", "REFUSED");
    say("refusal", refusal.slice(0, 90));
  }

  // --- what does the branch actually hold now? -----------------------------
  const head = await host.resolveRef(branch);
  const entries = await host.readTree(head.tree);
  const probe = entries.find((e) => e.path === "probe.txt");
  const contents = probe
    ? new TextDecoder().decode(await host.readObject(probe.id))
    : "(probe.txt not found)";

  console.log();
  say("branch head", String(head.commit).slice(0, 12));
  say("probe.txt now reads", JSON.stringify(contents.trim()));

  const lostA = accepted && contents.trim() === "written by B";
  console.log();
  console.log(lostA
    ? "  VERDICT: no compare-and-swap. A stale write was accepted and writer A's\n" +
      "  work is gone. Concurrent use of one machine is unsafe on this host, and\n" +
      "  the design must serialise writers by some other means."
    : accepted
      ? "  VERDICT: the stale write was accepted but did not clobber writer A.\n" +
        "  The host merged or re-parented it; this is not a compare-and-swap and\n" +
        "  needs reading carefully before it is relied on."
      : "  VERDICT: compare-and-swap holds. A stale parent is refused, which is the\n" +
        "  guarantee phase P7 depends on.");

  // --- clean up -------------------------------------------------------------
  if (typeof host.deleteBranch === "function") {
    try { await host.deleteBranch(branch); say("\n  cleaned up branch", branch); }
    catch { console.log(`\n  could not delete ${branch}; remove it by hand`); }
  } else {
    console.log(`\n  remove the probe branch by hand: ${branch}`);
  }
} catch (err) {
  console.error(`\nprobe failed: ${err.message}`);
  console.error(`the branch ${branch} may need deleting by hand`);
  process.exit(1);
}
