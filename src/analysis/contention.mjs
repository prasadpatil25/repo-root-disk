// How Algorithm 3 behaves with more than two writers.
//
// Run with: node src/analysis/contention.mjs [rounds]
//
//   default 50 rounds per configuration. The plans are seeded; the order in which
//   writers reach the reference depends on asynchronous hashing, so the tallies
//   move by about a point between runs, as a race does.
//
// Writers 2, 4 and 8 race to sync one machine from one parent, with disjoint
// chunk sets and with a quarter of writes landing in a shared hot region, under
// the single rebase the engine shipped with and under a budget of N-1. Every
// attempt is classified: landed first try, landed after rebasing, refused for
// overlap, or aborted after losing more races than the budget allowed. Costs
// are read off per-writer host instances sharing one repository.

import { mkdirSync, writeFileSync } from "node:fs";
import { simulate } from "./contention.js";

const ROUNDS = Number(process.argv[2] || 50);
const grid = [];
for (const writers of [2, 4, 8]) {
  for (const overlapChance of [0, 0.25]) {
    for (const retries of new Set([1, writers - 1])) {
      grid.push({ writers, overlapChance, retries });
    }
  }
}

console.log(`\n${ROUNDS} rounds per configuration, 4 chunks per writer per round, 64 MB disk\n`);
console.log("  writers  overlap  rebases   first  rebased  refused  aborted   req/landed   wasted");
const rows = [];
for (const cfg of grid) {
  const r = await simulate({ ...cfg, rounds: ROUNDS });
  const t = r.tally;
  const pct = (n) => `${(100 * n / t.attempts).toFixed(0)}%`.padStart(6);
  console.log(`  ${String(cfg.writers).padStart(7)}  ${String(cfg.overlapChance).padStart(7)}  ${String(cfg.retries).padStart(7)}` +
    `  ${pct(t.first)}  ${pct(t.rebased)}  ${pct(t.refused)}  ${pct(t.aborted)}` +
    `  ${(r.requestsPerLanded ?? 0).toFixed(1).padStart(11)}  ${String(r.wasted).padStart(7)}`);
  rows.push({ ...cfg, ...t, landed: r.landed, requests: r.requests, wasted: r.wasted,
    requestsPerLanded: r.requestsPerLanded, headCommits: r.headCommits });
}

console.log("\n  LaTeX rows (writers & overlap & budget & first & rebased & refused & aborted & requests per landed sync):");
for (const r of rows) {
  const pct = (n) => `${(100 * n / r.attempts).toFixed(0)}\\%`;
  console.log(`    ${r.writers} & ${r.overlapChance} & ${r.retries} & ${pct(r.first)} & ${pct(r.rebased)} & ${pct(r.refused)} & ${pct(r.aborted)} & ${(r.requestsPerLanded ?? 0).toFixed(1)} \\\\`);
}

mkdirSync("traces", { recursive: true });
const cols = ["writers", "overlapChance", "retries", "attempts", "first", "rebased", "refused", "aborted",
  "rebases", "landed", "requests", "wasted", "requestsPerLanded", "headCommits"];
writeFileSync("traces/contention.csv", [cols.join(",")].concat(rows.map((r) => cols.map((c) => r[c] ?? "").join(","))).join("\n") + "\n");
console.log("\n  wrote traces/contention.csv");
