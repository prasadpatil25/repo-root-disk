// Does batch commit actually deliver the request economy the documentation implies?
//
// The paper compares the three hosts by reading their APIs and concludes that
// GitHub needs N+3 requests per sync where the others need one, so the host we
// built on is the most expensive of the three. That conclusion has never been
// run. It also carries a prediction we have never tested: that on a batch-commit
// host the binding constraint stops being request count and becomes body size,
// because one request now carries every chunk and base64 inflates it by four
// thirds.
//
// This settles both, by driving the real sync engine against a real repository.
// The decisions are all in batch.js, which is tested offline, so a run against
// your account should not discover a bug in the harness.
//
//   GITLAB_TOKEN=... node src/analysis/batch-commit.mjs gitlab owner/repo
//   GITHUB_TOKEN=... node src/analysis/batch-commit.mjs github owner/repo
//   FORGEJO_TOKEN=... FORGEJO_ENDPOINT=https://codeberg.org/api/v1 \
//     node src/analysis/batch-commit.mjs forgejo owner/repo
//
// Run it against a batch-commit host and against GitHub, and the comparison in
// the paper stops being a reading of documentation.
//
// Tunable through the environment: CHUNK_KB, DISK_MB, ROUNDS, SIZES, MAX_CHUNKS,
// RATE, CONC. The token is read from the environment, never printed, and never
// written anywhere.
//
// It writes real commits to a real repository. Use one you are willing to fill
// with junk; the branch is named at the end so you can delete it.

import { Machine } from "../core/machine.js";
import { MemoryDevice } from "../device/memory.js";
import { Governor } from "../core/governor.js";
import { createHost } from "../host/index.js";
import {
  classifyRefusal, findCeiling, latex, measure, summarise, verdict, wireBytes
} from "./batch.js";

const kind = process.argv[2];
const slug = process.argv[3];

if (!kind || !slug || !slug.includes("/")) {
  console.error("usage: node src/analysis/batch-commit.mjs <gitlab|github|forgejo> <owner/repo>");
  process.exit(2);
}

const tokenVar = `${kind.toUpperCase()}_TOKEN`;
const token = process.env[tokenVar];
if (!token) {
  console.error(`set ${tokenVar} in the environment. It is never printed or stored.`);
  process.exit(2);
}

const num = (name, fallback) => Number(process.env[name] || fallback);
const CHUNK = num("CHUNK_KB", 256) * 1024;
const DISK = num("DISK_MB", 64) * 1024 * 1024;
const ROUNDS = num("ROUNDS", 3);
const CAP = num("MAX_CHUNKS", 64);
const SIZES = (process.env.SIZES || "1,2,4,8,16").split(",").map(Number);

const [owner, repo] = slug.split("/");
const endpoint = process.env[`${kind.toUpperCase()}_ENDPOINT`] || undefined;
const branch = `batch-probe-${Date.now().toString(36)}`;

// Raising this is how the probe asks the service what it accepts rather than
// what we assumed. Without it the ceiling phase measures our own constant.
const MAX_BODY = process.env.MAX_BODY_MB ? num("MAX_BODY_MB", 0) * 1024 * 1024 : undefined;

const host = createHost(kind, {
  token, owner, repo, endpoint, maxBodyBytes: MAX_BODY,
  governor: new Governor({ ratePerMin: num("RATE", 120), concurrency: num("CONC", 4) })
});

const say = (label, value) => console.log(`  ${label.padEnd(32)} ${value}`);
const mb = (bytes) => (bytes / 1e6).toFixed(2);

try {
  const who = await host.validate();
  say("connected as", who.login);
  say("repository", `${slug} (${who.private ? "private" : "public"})`);
  if (!who.canWrite) {
    console.error("\nthe token cannot write to this repository; nothing to measure");
    process.exit(1);
  }

  const caps = host.constructor.capabilities;
  say("batchCommit", String(caps.batchCommit));
  say("predicted for 8 chunks", `${host.constructor.requestsPerCommit(8)} requests`);
  say("our body ceiling", `${mb(host.maxBodyBytes)} MB` +
      (MAX_BODY ? " (raised)" : " (our figure, not the service's)"));
  say("geometry", `${DISK / 1024 / 1024} MB disk, ${CHUNK / 1024} KB chunks`);
  say("branch", branch);
  console.log();

  const device = new MemoryDevice({ diskSize: DISK });
  const machine = new Machine({ host, device, branch, governor: host.governor });
  await machine.load({ diskSize: DISK, chunkSize: CHUNK, base: "blank", baseIsBlank: true });
  machine.markHydrated();

  // The establishing commit is not a measurement: it creates the branch and
  // carries the manifest and geometry rather than a representative payload.
  const established = await machine.sync({ message: "batch probe: establish" });
  say("established", `${established.requests} requests, ${established.seconds.toFixed(2)}s`);

  console.log("\n  chunks   requests   seconds   uploaded      wire");
  console.log("  " + "-".repeat(54));

  const trials = await measure({
    machine, device, chunkSize: CHUNK, sizes: SIZES, rounds: ROUNDS,
    onTrial: (row) => console.log(
      `  ${String(row.size).padStart(6)}   ${String(row.requests).padStart(8)}   ` +
      `${row.seconds.toFixed(2).padStart(7)}   ${mb(row.bytes).padStart(6)} MB   ` +
      `${mb(row.wire).padStart(6)} MB` + (row.warmup ? "   (warm-up)" : "")
    )
  });

  console.log("\n  where does it break?");
  console.log("  " + "-".repeat(54));

  const { largestOk, refusal } = await findCeiling({
    machine, device, chunkSize: CHUNK, from: Math.max(...SIZES), cap: CAP,
    onStep: (step) => console.log(step.ok
      ? `  ${String(step.n).padStart(6)} chunks  ok, ${mb(step.wire)} MB on the wire, ` +
        `${step.seconds.toFixed(2)}s`
      // Not truncated. The reason a host refused is the whole point of this
      // phase, and the first run of this harness cut the message short exactly
      // where it started to say why.
      : `  ${String(step.n).padStart(6)} chunks  REFUSED  ${step.status || ""}\n` +
        `          ${step.message}`)
  });

  const rows = summarise(trials, SIZES);

  console.log(`\n  summary (medians over ${ROUNDS} rounds)`);
  console.log("  " + "-".repeat(54));
  console.log("  chunks   req/sync   req/chunk   seconds    MB/s");
  for (const r of rows) {
    console.log(
      `  ${String(r.size).padStart(6)}   ${String(r.requests).padStart(8)}   ` +
      `${r.perChunk.toFixed(2).padStart(9)}   ${r.seconds.toFixed(2).padStart(7)}   ` +
      `${r.mbs.toFixed(2).padStart(5)}`
    );
  }

  console.log();
  const call = verdict(rows);
  console.log(call === "flat"
    ? "  VERDICT: request count does not grow with the number of dirty chunks.\n" +
      "  The batch endpoint delivers what the documentation implies, and the\n" +
      "  request budget stops being the binding constraint on this host."
    : call === "grows"
      ? "  VERDICT: request count grows with the number of dirty chunks. The\n" +
        "  per-chunk column is the cost the paper's comparison turns on."
      : "  VERDICT: inconclusive; not enough sizes completed to compare.");

  const why = classifyRefusal(refusal, {
    maxBodyBytes: host.maxBodyBytes, batchCommit: caps.batchCommit
  });
  if (why === "client-guard") {
    console.log(`\n  stopped by our own guard at ${refusal.n} chunks ` +
                `(${mb(refusal.wire)} MB against the ${mb(host.maxBodyBytes)} MB we set), ` +
                `having committed ${largestOk}.`);
    console.log("  This says nothing about the service: the request was never sent.");
    console.log(`  The largest body ${kind} actually accepted here is ` +
                `${mb(wireBytes(largestOk * CHUNK))} MB.`);
    console.log(`  To find the real limit, raise it:  MAX_BODY_MB=256 ...`);
  } else if (why === "body-size") {
    console.log(`\n  the body is bounded: ${largestOk} chunks committed, ` +
                `${refusal.n} refused with ${refusal.status || "an error"} at ` +
                `${mb(refusal.wire)} MB against a declared ${mb(caps.maxBodyBytes)} MB.`);
    console.log("  That is the constraint moving from request count to body size,");
    console.log("  which the paper predicts and had not measured.");
  } else if (refusal) {
    console.log(`\n  refused at ${refusal.n} chunks with ` +
                `${refusal.status || "an error"}, having committed ${largestOk}.`);
    console.log(`  This is NOT a body-size ceiling: the payload was ` +
                `${mb(refusal.wire)} MB against a declared ` +
                `${caps.maxBodyBytes ? mb(caps.maxBodyBytes) + " MB" : "unstated"} ` +
                `limit, and on a host that sends one object per request no single`);
    console.log("  body is ever large. Read the message above for the real reason.");
  } else {
    console.log(`\n  no refusal up to ${largestOk} chunks ` +
                `(${mb(wireBytes(largestOk * CHUNK))} MB on the wire). ` +
                `Raise MAX_CHUNKS to push further.`);
  }

  console.log("\n% ---- for the paper ----");
  console.log(latex(rows, {
    host: kind, diskMb: DISK / 1024 / 1024, chunkKb: CHUNK / 1024, rounds: ROUNDS
  }));

  console.log(`\n  delete the probe branch by hand when you are done: ${branch}`);
} catch (err) {
  console.error(`\nharness failed: ${err.message}`);
  console.error(`the branch ${branch} may need deleting by hand`);
  process.exit(1);
}
