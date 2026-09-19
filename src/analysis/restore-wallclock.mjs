// Restore a real machine from a real service, and time it.
//
//   GITHUB_TOKEN=... node src/analysis/restore-wallclock.mjs github owner/repo [traces/history]
//   GITLAB_TOKEN=... node src/analysis/restore-wallclock.mjs gitlab owner/repo [traces/history]
//
// Every restore number so far is a request count from an in-process host,
// which is exact and is what the budget meters. A reader comparing against a
// snapshot loaded from IndexedDB will still ask how long it takes. This
// commits the machine the captured history ends at (318 live chunks, 80 MB)
// to a throwaway branch, then restores it from the object API serially and at
// width, several times each, and reports medians. The branch is deleted at
// the end; the objects it created are left for the host's garbage collector.
//
// Reads are paced through the governor at RATE per minute, below the
// service's 900 points per minute, and retried on a refusal the way writes
// are. The token comes from the environment and is never printed.
//
// Needs the phase-*.bin files (app/demo-history.js records them), since the
// machine is committed with its real bytes.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHost } from "../host/index.js";
import { Machine, restore } from "../core/machine.js";
import { MemoryDevice } from "../device/memory.js";
import { Governor } from "../core/governor.js";
import { planFrom } from "./history.js";
import { blobId } from "../core/objectid.js";
import { createHash } from "node:crypto";

const kind = process.argv[2];
const slug = process.argv[3];
const DIR = process.argv[4] || "traces/history";
if (!kind || !slug || !slug.includes("/")) {
  console.error("usage: <KIND>_TOKEN=... node src/analysis/restore-wallclock.mjs <github|gitlab|forgejo> owner/repo [traces/history]");
  process.exit(2);
}
const tokenVar = `${kind.toUpperCase()}_TOKEN`;
const token = process.env[tokenVar];
if (!token) { console.error(`set ${tokenVar} in the environment. It is never printed or stored.`); process.exit(2); }
const endpoint = process.env[`${kind.toUpperCase()}_ENDPOINT`] || undefined;

const num = (name, fallback) => Number(process.env[name] || fallback);
const RATE = num("RATE", 150);            // writes per minute while committing
const READ_RATE = num("READ_RATE", 800);  // reads per minute while restoring
const ROUNDS = num("ROUNDS", 3);
const WIDTHS = (process.env.WIDTHS || "1,8").split(",").map(Number);
const K = 1024;
const mb = (b) => (b / K / K).toFixed(1);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// ------------------------------------------------------------ the machine

const history = JSON.parse(readFileSync(join(DIR, "history.json"), "utf8"));
const { diskSize, chunkSize } = history;
const { plan, haveBytes } = planFrom(history, (file) => {
  const path = join(DIR, file);
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
});
if (!haveBytes) { console.error(`${DIR} lacks the phase-*.bin files; the machine needs its bytes`); process.exit(2); }

const device = new MemoryDevice({ diskSize });
for (const step of plan) for (const w of step.writes) device.write(w.index * chunkSize, w.bytes);
await device.flush();

const [owner, repo] = slug.split("/");
// BRANCH=<name> restores from a branch an earlier run kept, skipping the upload.
const REUSE = process.env.BRANCH || null;
const branch = REUSE || `wallclock-${Date.now().toString(36)}`;
// A machine of thousands of chunks is a long upload, and an hourly ceiling
// met halfway through is worth waiting out rather than starting over.
const governor = new Governor({ ratePerMin: RATE, concurrency: 8, retries: num("RETRIES", 30) });
const host = createHost(kind, { token, owner, repo, endpoint, governor });
const reads = new Governor({ ratePerMin: READ_RATE, concurrency: 8, minConcurrency: 1 });
const rawRead = host.readObject.bind(host);
host.readObject = (id) => reads.write(() => rawRead(id));

const say = (label, value) => console.log(`  ${label.padEnd(30)} ${value}`);
const sha256 = (b) => createHash("sha256").update(b).digest("hex").slice(0, 12);

/**
 * When a restore fails a digest check, say exactly what disagreed: what the
 * manifest on the service names for that index, what the local disk holds
 * there, what the service returned for the object, and whether the
 * manifest's id is the id of any chunk content anywhere in the local history.
 */
async function diagnose(err) {
  const m = /chunk (\d+) does not match/.exec(err.message || "");
  if (!m) return;
  const index = Number(m[1]);
  say("diagnosing index", String(index));
  const ref = await host.resolveRef(branch);
  const entries = await host.readTree(ref.tree);
  const manifestEntry = entries.find((e) => e.path === "manifest.json");
  say("tree entries", `${entries.length}, manifest ${manifestEntry ? manifestEntry.id.slice(0, 12) : "missing"}`);
  const { parse } = await import("../core/manifest.js");
  const manifest = parse(await host.readObject(manifestEntry.id));
  const named = manifest.chunks[String(index)];
  say("manifest names", `${named} digest ${(manifest.digests || {})[String(index)]}`);
  say("manifest sync counter", `${manifest.sync}, ${Object.keys(manifest.chunks).length} chunks`);
  const local = await device.readChunk(index, chunkSize);
  say("local chunk", `${await blobId(local)} digest ${sha256(local)}`);
  const remote = await host.readObject(named);
  say("remote object", `${remote.length} bytes, digest ${sha256(remote)}`);
  for (const step of plan) {
    for (const w of step.writes) {
      if (await blobId(w.bytes) === named) { say("manifest's id is", `sync ${step.sync} chunk ${w.index}`); return; }
    }
  }
  say("manifest's id is", "no chunk content in the local history");
}
console.log(`\nrestore wall clock on ${kind}: ${history.label}\n`);

let created = false;
try {
  const who = await host.validate();
  say("connected as", who.login);
  say("repository", `${slug} (${who.private ? "private" : "public"})`);
  if (!who.canWrite) throw new Error("the token cannot write to this repository");

  const machine = new Machine({ host, device, branch, governor });
  await machine.load({ diskSize, chunkSize, base: "blank", baseIsBlank: true });

  // ---------------------------------------------------------- commit
  const r0 = host.requestCount;
  let t0 = Date.now();
  let synced;
  if (REUSE) {
    const ref = await host.resolveRef(branch);
    if (!ref) throw new Error(`${branch} does not exist`);
    synced = { commit: ref.commit, uploaded: 0 };
    say("reusing branch", branch);
  } else {
    synced = await machine.sync({ message: "the captured history's machine, in one sync" });
    created = true;
  }
  const uploadMs = Date.now() - t0;
  if (!REUSE) say("committed", `${synced.uploaded} chunks in ${host.requestCount - r0} requests, ` +
      `${(uploadMs / 1000).toFixed(0)} s at ${RATE}/min`);

  // A just-created reference can take a few seconds to become readable. Wait
  // for it here rather than inside the timed restore.
  for (let waited = 0; ; waited += 2) {
    const ref = await host.resolveRef(branch);
    if (ref && ref.commit === synced.commit) break;
    if (waited >= 120) throw new Error(`the branch ${branch} did not become readable within two minutes`);
    if (waited === 0) say("waiting for the reference", "not yet readable");
    await new Promise((r) => setTimeout(r, 2000));
  }

  // ---------------------------------------------------------- restore
  const live = device.snapshot();
  const results = { slug, branch, live: synced.uploaded, liveBytes: synced.uploaded * chunkSize,
    uploadRequests: host.requestCount - r0, uploadMs, rounds: {} };
  for (const width of WIDTHS) {
    const rows = [];
    for (let i = 0; i < ROUNDS; i++) {
      const before = host.requestCount;
      t0 = Date.now();
      let res;
      try {
        res = await restore({ host, branch, concurrency: width });
      } catch (err) {
        await diagnose(err);
        throw err;
      }
      const ms = Date.now() - t0;
      const same = res.disk.length === live.length && Buffer.compare(res.disk, live) === 0;
      if (!same) throw new Error(`restore at width ${width} did not reproduce the machine`);
      rows.push({ ms, requests: host.requestCount - before, chunks: res.chunksApplied });
      say(`restore, width ${width}, round ${i + 1}`,
          `${rows.at(-1).requests} requests, ${res.chunksApplied} chunks, ${(ms / 1000).toFixed(1)} s`);
    }
    results.rounds[width] = {
      rows, medianMs: median(rows.map((r) => r.ms)), requests: rows[0].requests
    };
  }

  const liveChunks = results.rounds[WIDTHS[0]].rows[0].chunks;
  results.live = liveChunks;
  results.liveBytes = liveChunks * chunkSize;
  results.uploaded = synced.uploaded;
  console.log("\n  the machine: %d live chunks, %s MB; %d uploaded, the rest deduplicated",
              liveChunks, mb(liveChunks * chunkSize), synced.uploaded);
  for (const width of WIDTHS) {
    const r = results.rounds[width];
    say(`restore at width ${width}`, `${r.requests} requests, median ${(r.medianMs / 1000).toFixed(1)} s over ${ROUNDS}`);
  }
  results.governor = { refused: reads.stats.refused, backoffs: reads.stats.backoffs };
  say("read refusals", `${reads.stats.refused}`);
  const out = `traces/restore-wallclock-${kind}-${history.diskSize / K / K}mb.json`;
  writeFileSync(out, JSON.stringify({ kind, ...results }, null, 1) + "\n");
  console.log(`\n  wrote ${out}`);
} catch (err) {
  if (process.env.KEEP_BRANCH === "1") { created = false; say("branch kept for inspection", branch); }
  if (err.status === 404 && !created) {
    console.error(`\n  ${kind} cannot see ${slug} with this token: the repository does not exist under ` +
      `that name, or the token is not scoped to it. Use the repository the batch-commit run used.`);
    process.exit(2);
  }
  throw err;
} finally {
  if (REUSE && process.env.DELETE_BRANCH === "1") created = true;
  if (created) {
    try { await host.deleteBranch(branch); say("deleted branch", branch); } catch (e) { say("branch not deleted", e.message); }
  }
}
