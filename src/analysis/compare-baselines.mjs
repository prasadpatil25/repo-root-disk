// The quantitative comparison the review asked for.
//
// Three commit shapes run as working systems on byte-identical workloads, with
// storage, upload and restore measured by one accounting. Whole-image is what
// image-saving systems do; delta-pack is the incremental-backup shape; chunk-
// exploded is ours. Each is best at exactly one thing, and the table shows
// which, against history length rather than at a single point.
//
// Run with: node src/analysis/compare-baselines.mjs [syncs] [diskMB]
//
//   default 120 syncs on a 64 MB disk, the paper's geometry.
//
// Emits a readable table, a LaTeX table for the paper, and a CSV for plotting.
// No network, no credentials; seeded, so every number here reproduces.

import { writeFileSync } from "node:fs";
import {
  WholeImage, DeltaPack, ChunkExploded, workload, run, cumulative
} from "./baselines.js";

const K = 1024;
const SYNCS = Number(process.argv[2] || 120);
const DISK = Number(process.argv[3] || 64) * K * K;
const CHUNK = 256 * K;

const plan = workload({ syncs: SYNCS, diskSize: DISK, chunkSize: CHUNK });

console.log(`\ncommit shapes compared, ${SYNCS} syncs on a ${DISK / K / K} MB disk ` +
            `with ${CHUNK / K} KB chunks\n`);

const shapes = [
  ["whole image", WholeImage],
  ["delta pack", DeltaPack],
  ["chunk exploded", ChunkExploded]
];

const results = {};
for (const [name, Shape] of shapes) {
  process.stdout.write(`  running ${name.padEnd(16)}`);
  const t0 = Date.now();
  results[name] = await run(Shape, { plan, diskSize: DISK, chunkSize: CHUNK });
  console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// --------------------------------------------------------------- readable

const mb = (b) => (b / K / K).toFixed(1);
const at = (name, n) => results[name][n - 1];
const checkpoints = [1, 10, 30, 60, 90, SYNCS].filter((n, i, a) => n <= SYNCS && a.indexOf(n) === i);

console.log("\n  restore cost against history (requests / MB fetched)\n");
console.log("  sync   " + shapes.map(([n]) => n.padStart(18)).join(""));
for (const n of checkpoints) {
  const cells = shapes.map(([name]) => {
    const r = at(name, n);
    return `${r.restoreRequests} / ${mb(r.restoreBytes)}`.padStart(18);
  });
  console.log(`  ${String(n).padStart(4)}   ${cells.join("")}`);
}

console.log("\n  storage held in the repository (MB)\n");
console.log("  sync   " + shapes.map(([n]) => n.padStart(18)).join(""));
for (const n of checkpoints) {
  const cells = shapes.map(([name]) => mb(at(name, n).storageBytes).padStart(18));
  console.log(`  ${String(n).padStart(4)}   ${cells.join("")}`);
}

console.log("\n  cumulative upload requests, which is what the rate limit meters\n");
console.log("  sync   " + shapes.map(([n]) => n.padStart(18)).join(""));
for (const n of checkpoints) {
  const cells = shapes.map(([name]) =>
    String(cumulative(results[name], "uploadRequests")[n - 1]).padStart(18));
  console.log(`  ${String(n).padStart(4)}   ${cells.join("")}`);
}

// ---------------------------------------------------------------- verdict

const mid = Math.floor(SYNCS / 2);
const last = SYNCS;
const growth = (name) =>
  at(name, last).restoreRequests - at(name, mid).restoreRequests;

console.log(`\n  restore requests, sync ${mid} to ${last} (live set held still):`);
for (const [name] of shapes) {
  const g = growth(name);
  console.log(`    ${name.padEnd(16)} ${String(at(name, mid).restoreRequests).padStart(5)} -> ` +
              `${String(at(name, last).restoreRequests).padStart(5)}   ` +
              (g === 0 ? "flat" : `+${g}`));
}

const ours = results["chunk exploded"];
const delta = results["delta pack"];
const whole = results["whole image"];
console.log(`\n  at sync ${last}:`);
console.log(`    whole image stores ${(at("whole image", last).storageBytes /
              at("chunk exploded", last).storageBytes).toFixed(0)}x what ours does`);
console.log(`    delta pack restores ${(at("delta pack", last).restoreBytes /
              at("chunk exploded", last).restoreBytes).toFixed(1)}x the bytes ours does, ` +
            `in ${(at("delta pack", last).restoreRequests /
              at("chunk exploded", last).restoreRequests).toFixed(1)}x the requests`);
console.log(`    ours spent ${(cumulative(ours, "uploadRequests").pop() /
              cumulative(delta, "uploadRequests").pop()).toFixed(1)}x delta pack's ` +
            `upload requests to buy that`);

// ------------------------------------------------------------------ LaTeX

const tex = [];
tex.push(`% commit shapes compared: ${SYNCS} syncs, ${DISK / K / K} MB disk, ${CHUNK / K} KB chunks`);
tex.push(`% restore = requests / MB fetched; storage = MB held; upload = cumulative requests`);
tex.push(`% bold marks the lowest value in each group; requests and MB are judged separately`);
tex.push(`\\begin{tabular}{@{}r rrr rrr rrr@{}}`);
tex.push(`\\toprule`);
tex.push(`& \\multicolumn{3}{c}{restore (req / MB)} & \\multicolumn{3}{c}{storage (MB)} & \\multicolumn{3}{c}{upload (req)} \\\\`);
tex.push(`\\cmidrule(lr){2-4}\\cmidrule(lr){5-7}\\cmidrule(lr){8-10}`);
tex.push(`sync & whole & delta & ours & whole & delta & ours & whole & delta & ours \\\\`);
tex.push(`\\midrule`);
// Bold marks the lowest value in each group of three, whichever shape it is.
// Bolding a fixed column would claim a win in cells where ours does not win,
// and the honest story is that each shape is best somewhere.
const best = (vals, fmt) => {
  const min = Math.min(...vals);
  return vals.map((v) => (v === min ? `\\textbf{${fmt(v)}}` : fmt(v)));
};
for (const n of checkpoints) {
  const w = at("whole image", n), d = at("delta pack", n), o = at("chunk exploded", n);
  const up = (name) => cumulative(results[name], "uploadRequests")[n - 1];
  const req = best([w.restoreRequests, d.restoreRequests, o.restoreRequests], String);
  const rb = best([w.restoreBytes, d.restoreBytes, o.restoreBytes], mb);
  const sto = best([w.storageBytes, d.storageBytes, o.storageBytes], mb);
  const upl = best([up("whole image"), up("delta pack"), up("chunk exploded")], String);
  tex.push(
    `${n} & ${req[0]}/${rb[0]} & ${req[1]}/${rb[1]} & ${req[2]}/${rb[2]} ` +
    `& ${sto[0]} & ${sto[1]} & ${sto[2]} & ${upl[0]} & ${upl[1]} & ${upl[2]} \\\\`
  );
}
tex.push(`\\bottomrule`);
tex.push(`\\end{tabular}`);

console.log("\n% ---- for the paper ----");
console.log(tex.join("\n"));

// -------------------------------------------------------------------- CSV

const csv = ["sync,shape,restoreRequests,restoreBytes,storageBytes,uploadRequestsCumulative"];
for (const [name] of shapes) {
  const cum = cumulative(results[name], "uploadRequests");
  results[name].forEach((r, i) => {
    csv.push(`${r.sync},${name.replace(" ", "-")},${r.restoreRequests},${r.restoreBytes},` +
             `${r.storageBytes},${cum[i]}`);
  });
}
const out = `traces/baselines-${SYNCS}x${DISK / K / K}mb.csv`;
writeFileSync(out, csv.join("\n") + "\n");
console.log(`\n  per-sync data for plotting: ${out}`);
