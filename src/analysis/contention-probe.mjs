// The same race against a real service.
//
//   GITHUB_TOKEN=... node src/analysis/contention-probe.mjs github owner/repo
//   GITLAB_TOKEN=... node src/analysis/contention-probe.mjs gitlab owner/repo
//   FORGEJO_TOKEN=... FORGEJO_ENDPOINT=https://codeberg.org/api/v1 \
//     node src/analysis/contention-probe.mjs forgejo owner/repo
//
// contention.mjs runs the race in process. This runs it where the
// compare-and-swap is the service's own: N writers in one process, each with
// its own host instance and request counter, all attached to one throwaway
// branch, syncing at the same moment. Round trips of hundreds of milliseconds
// make the race real rather than a matter of microtask order. Writers 2, 4
// and 8, disjoint chunk sets, under a single rebase and under a budget of
// N-1, ROUNDS rounds each. The branch is deleted at the end.
//
// One governor is shared by every writer, so the sum of their traffic stays
// under the service's enforced write ceiling. The token comes from the
// environment and is never printed.

import { mkdirSync, writeFileSync } from "node:fs";
import { createHost } from "../host/index.js";
import { Machine } from "../core/machine.js";
import { MemoryDevice } from "../device/memory.js";
import { Governor } from "../core/governor.js";
import { rng } from "./baselines.js";
import { roundPlan, race, tallyOutcomes, emptyTally } from "./contention.js";
import { parse as parseManifest, MANIFEST_PATH } from "../core/manifest.js";

const kind = process.argv[2];
const slug = process.argv[3];
if (!kind || !slug || !slug.includes("/")) {
  console.error("usage: node src/analysis/contention-probe.mjs <github|gitlab|forgejo> <owner/repo>");
  process.exit(2);
}
const tokenVar = `${kind.toUpperCase()}_TOKEN`;
const token = process.env[tokenVar];
if (!token) { console.error(`set ${tokenVar} in the environment. It is never printed or stored.`); process.exit(2); }

const num = (name, fallback) => Number(process.env[name] || fallback);
const ROUNDS = num("ROUNDS", 3);
const RATE = num("RATE", 150);
const WRITERS = (process.env.WRITERS || "2,4,8").split(",").map(Number);
const CHUNKS = num("CHUNKS", 2);           // per writer per round
const K = 1024;
const DISK = 16 * K * K;
const CHUNK = 256 * K;
const [owner, repo] = slug.split("/");
const endpoint = process.env[`${kind.toUpperCase()}_ENDPOINT`] || undefined;
const branch = `contention-${Date.now().toString(36)}`;
const governor = new Governor({ ratePerMin: RATE, concurrency: 8, retries: num("RETRIES", 10) });
const encoder = new TextEncoder();
const say = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);

const newHost = () => createHost(kind, { token, owner, repo, endpoint, governor });

// A reference written a moment ago can take seconds to become readable, and a
// writer that loads before then would think the branch missing. Wait for the
// head every writer is about to attach to.
async function waitForRef(host, expectCommit = null) {
  for (let waited = 0; ; waited += 2) {
    const ref = await host.resolveRef(branch);
    if (ref && (!expectCommit || ref.commit === expectCommit)) return ref;
    if (waited >= 120) throw new Error(`the branch ${branch} did not become readable within two minutes`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

console.log(`\ncontention on ${kind}: ${slug}, branch ${branch}\n`);
const probe = newHost();
const who = await probe.validate();
say("connected as", who.login);
if (!who.canWrite) { console.error("the token cannot write to this repository"); process.exit(2); }

// One writer establishes the machine.
{
  const device = new MemoryDevice({ diskSize: DISK });
  const machine = new Machine({ host: probe, device, branch, governor });
  await machine.load({ diskSize: DISK, chunkSize: CHUNK, base: "blank", baseIsBlank: true });
  device.write(0, encoder.encode("seed"));
  const seeded = await machine.sync({ message: "seed" });
  await waitForRef(probe, seeded.commit);
  say("machine created", `${DISK / K / K} MB, ${CHUNK / K} KB chunks`);
}

const results = [];
const lostUpdates = [];
let created = true;
try {
  const random = rng(11);
  for (const writers of WRITERS) {
    for (const retries of new Set([1, writers - 1])) {
      const team = Array.from({ length: writers }, (_, i) => {
        const host = newHost();
        const device = new MemoryDevice({ diskSize: DISK });
        const events = [];
        const machine = new Machine({ host, device, branch, governor, onEvent: (e) => events.push(e.type) });
        return { i, host, device, machine, events };
      });
      const tally = emptyTally();
      const times = [];
      for (let r = 1; r <= ROUNDS; r++) {
        await waitForRef(probe);
        for (const w of team) { await w.machine.load(); w.machine.markHydrated(); }
        const plan = roundPlan({ writers, chunksPerWriter: CHUNKS, totalChunks: DISK / CHUNK, overlapChance: 0, random });
        plan.forEach((indices, i) => {
          for (const index of indices) {
            team[i].device.write(index * CHUNK, encoder.encode(`round ${r} writer ${i} chunk ${index} ${random()}`));
          }
        });
        const t0 = Date.now();
        const outcomes = await race(team, { round: r, retries });
        times.push(Date.now() - t0);
        tallyOutcomes(tally, outcomes);
        // A landed sync's chunks must be in the head manifest. If the service
        // accepted a stale writer, another's writes are gone, and that is a
        // lost update the tally alone would not show.
        const head = await waitForRef(probe);
        const tree = await probe.readTree(head.tree);
        const manifest = parseManifest(await probe.readObject(tree.find((e) => e.path === MANIFEST_PATH).id));
        const lost = outcomes.filter((o) => o.commit).flatMap((o) =>
          plan[o.writer].filter((index) => !manifest.chunks[String(index)]).map((index) => `writer ${o.writer} chunk ${index}`));
        if (lost.length) { lostUpdates.push({ writers, retries, round: r, lost }); say("  LOST UPDATE", lost.join(", ")); }
        say(`${writers} writers, budget ${retries}, round ${r}`,
            outcomes.map((o) => o.outcome[0]).join("") +
            `  ${outcomes.reduce((a, o) => a + o.requests, 0)} requests, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      }
      const landed = tally.first + tally.rebased;
      results.push({ writers, retries, ...tally, landed,
        requestsPerLanded: landed ? tally.requests / landed : null,
        roundSeconds: times.reduce((a, b) => a + b, 0) / times.length / 1000 });
    }
  }
} finally {
  if (created) {
    try { await probe.deleteBranch(branch); say("deleted branch", branch); } catch (e) { say("branch not deleted", e.message); }
  }
}

console.log("\n  writers  budget   first  rebased  refused  aborted   req/landed   wasted   s/round");
for (const r of results) {
  const pct = (n) => `${(100 * n / r.attempts).toFixed(0)}%`.padStart(6);
  console.log(`  ${String(r.writers).padStart(7)}  ${String(r.retries).padStart(6)}  ${pct(r.first)}  ${pct(r.rebased)}` +
    `  ${pct(r.refused)}  ${pct(r.aborted)}  ${(r.requestsPerLanded ?? 0).toFixed(1).padStart(11)}` +
    `  ${String(r.wasted).padStart(7)}  ${r.roundSeconds.toFixed(0).padStart(8)}`);
}
mkdirSync("traces", { recursive: true });
const out = `traces/contention-${kind}.json`;
say("lost updates", lostUpdates.length ? JSON.stringify(lostUpdates) : "none");
writeFileSync(out, JSON.stringify({ kind, slug, rounds: ROUNDS, chunksPerWriter: CHUNKS, results, lostUpdates }, null, 1) + "\n");
console.log(`\n  wrote ${out}`);
