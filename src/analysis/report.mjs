// Turn a recorded trace into the chunk-size table the paper prints.
//
// Run with: node src/analysis/report.mjs traces/alpine-vim.json
//
// Emitting the LaTeX from the measurement rather than transcribing it by hand
// removes the step where a number changes in one place and not the other.

import { readFileSync } from "node:fs";
import { sweep, timeAt, best, bytesTouched, bytesWritten, table } from "./sweep.js";

const K = 1024;
const SIZES = [32 * K, 64 * K, 128 * K, 256 * K, 512 * K, 1024 * K];

// A fast link and the forge's enforced write ceiling: the regime this system
// actually runs in. The paper measured 180 writes per minute as enforced.
const LIMITS = { mbps: 50, writesPerMinute: 180 };

const path = process.argv[2];
if (!path) {
  console.error("usage: node src/analysis/report.mjs <trace.json>");
  process.exit(1);
}

const trace = JSON.parse(readFileSync(path, "utf8"));
const rows = sweep(trace, SIZES).map((c) => timeAt(c, LIMITS));
const chosen = best(trace, SIZES, LIMITS);

console.log(`trace: ${trace.label}`);
console.log(`  disk        ${trace.diskSize / 1048576} MB`);
console.log(`  ranges      ${trace.ranges.length}`);
console.log(`  written     ${(bytesWritten(trace.ranges) / 1048576).toFixed(2)} MB`);
console.log(`  touched     ${(bytesTouched(trace.ranges, trace.diskSize) / 1048576).toFixed(2)} MB distinct`);
if (trace.phases) {
  console.log("  phases      " + trace.phases.map((p) => `${p.label} (${p.ranges})`).join(", "));
}
console.log();
console.log(table(rows));
console.log();
console.log(`under ${LIMITS.mbps} Mbps and ${LIMITS.writesPerMinute} writes/min, ` +
            `the cheapest is ${chosen.chunkSize / 1024}K at ${chosen.seconds.toFixed(1)}s ` +
            `(bound by ${chosen.boundBy})`);

// --- LaTeX ------------------------------------------------------------------

const body = rows.map((r) =>
  `${r.chunkSize / 1024}\\,K & ${r.chunks} & ` +
  `${(r.uploadedBytes / 1048576).toFixed(1)} & ` +
  `${r.amplification.toFixed(2)} & ${r.requests} & ` +
  `${r.seconds.toFixed(0)} & ${r.boundBy} \\\\`
).join("\n");

console.log("\n--- LaTeX ---\n");
console.log(`\\begin{tabular}{lrrrrrl}
\\toprule
chunk & dirty & uploaded & amplif. & requests & seconds & bound by \\\\
\\midrule
${body}
\\bottomrule
\\end{tabular}`);
