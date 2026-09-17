// The four stores on a real machine history.
//
// Run with: node src/analysis/replay-history.mjs [traces/history]
//
// compare-baselines.mjs and restic-baseline.mjs run a seeded synthetic plan,
// which is what lets them go to a thousand syncs. This replays a history that
// a real guest wrote, captured by app/demo-history.js: format, Alpine, vim,
// and a forty-step working session, one commit's worth of writes per phase,
// with the bytes. The three commit shapes run in process against the counting
// host exactly as before; restic runs as the released binary if it is
// installed, and is skipped with a note if it is not.
//
// history.json alone carries every phase's chunk indices, which is all the
// in-process shapes need. The phase-*.bin files carry the chunk contents, and
// restic needs those, since content-defined chunking sees content.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WholeImage, DeltaPack, ChunkExploded, run, cumulative } from "./baselines.js";
import { runRestic, toCsv } from "./restic-run.js";
import { planFrom } from "./history.js";

const K = 1024;
const DIR = process.argv[2] || "traces/history";
const mb = (b) => (b / K / K).toFixed(1);

// ------------------------------------------------------------ the history

const history = JSON.parse(readFileSync(join(DIR, "history.json"), "utf8"));
const { diskSize, chunkSize } = history;
if (!history.complete) console.log("  note: history.json says the capture did not complete");

const { plan, labels, skipped, haveBytes } = planFrom(history, (file) => {
  const path = join(DIR, file);
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
});
const phases = labels.map((label) => ({ label }));
const SYNCS = plan.length;

console.log(`\nfour stores on a captured history: ${history.label}`);
console.log(`  ${history.guest}; ${history.diskSize / K / K} MB disk, ${chunkSize / K} KB chunks`);
console.log(`  ${SYNCS} syncs with writes (${skipped} empty phase(s) skipped), ` +
            `${haveBytes ? "with" : "WITHOUT"} chunk contents\n`);

// ------------------------------------------------------------ the shapes

const shapes = [["whole image", WholeImage], ["delta pack", DeltaPack], ["chunk exploded", ChunkExploded]];
const results = {};
for (const [name, Shape] of shapes) {
  process.stdout.write(`  running ${name.padEnd(16)}`);
  const t0 = Date.now();
  results[name] = await run(Shape, { plan, diskSize, chunkSize });
  console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

let restic = null;
if (haveBytes) {
  process.stdout.write(`  running restic          `);
  const t0 = Date.now();
  try {
    restic = await runRestic({
      plan, diskSize, chunkSize, measureAt: plan.map((s) => s.sync),
      port: Number(process.env.PORT || 8766)
    });
    console.log(`${((Date.now() - t0) / 60000).toFixed(1)} min  (${restic.versions.restic})`);
  } catch (err) {
    console.log(`skipped: ${err.message.split("\n")[0]}`);
  }
} else {
  console.log("  restic needs the phase-*.bin files; skipped");
}

// ------------------------------------------------------------ report

const ours = results["chunk exploded"];
const row = (rows, n) => rows.find((r) => r.sync === n);
const marks = [...new Set([1, 2, 3, 8, 13, 18, 23, 28, 33, 38, SYNCS])].filter((n) => n <= SYNCS);

console.log("\n  what each sync wrote");
console.log("  sync  chunks  live   phase");
for (const s of plan) {
  if (!marks.includes(s.sync)) continue;
  console.log(`  ${String(s.sync).padStart(4)}  ${String(s.writes.length).padStart(6)}  ` +
    `${String(row(ours, s.sync).liveChunks).padStart(4)}   ${phases[s.sync - 1].label}`);
}

console.log("\n  restore cost against history (requests / MB fetched)");
const cols = [...shapes.map(([n]) => n), ...(restic ? ["restic"] : [])];
console.log("  sync  " + cols.map((c) => c.padStart(16)).join(""));
const cell = (r) => r && r.restoreRequests !== null ? `${r.restoreRequests} / ${mb(r.restoreBytes)}` : "";
for (const n of marks) {
  const cells = shapes.map(([name]) => cell(row(results[name], n)));
  if (restic) cells.push(cell(restic.rows.find((r) => r.sync === n && r.phase === "backup")));
  console.log(`  ${String(n).padStart(4)}  ` + cells.map((c) => c.padStart(16)).join(""));
}
if (restic) {
  const a = restic.after;
  console.log(`  ${"compacted".padStart(4)}  ` + "".padStart(48) + cell(a).padStart(16) +
    `   (repair index: ${restic.repair.requests} requests)`);
}

console.log("\n  at the last sync");
const last = (rows) => rows[rows.length - 1];
const summary = shapes.map(([name]) => {
  const rows = results[name];
  return [name, last(rows).storageBytes, cumulative(rows, "uploadRequests").pop()];
});
if (restic) {
  const lastBackup = restic.rows.findLast((r) => r.phase === "backup");
  summary.push(["restic", lastBackup.storageBytes, lastBackup.uploadRequestsCumulative]);
}
console.log("  store            storage MB   upload requests");
for (const [name, bytes, reqs] of summary) {
  console.log(`  ${name.padEnd(16)} ${mb(bytes).padStart(10)}   ${String(reqs).padStart(15)}`);
}

console.log("\n  LaTeX rows (requests / MB) for a table with the same columns:");
for (const n of marks) {
  const cells = shapes.map(([name]) => cell(row(results[name], n)));
  if (restic) cells.push(cell(restic.rows.find((r) => r.sync === n && r.phase === "backup")));
  console.log(`    ${n} & ${cells.join(" & ")} \\\\`);
}

// ------------------------------------------------------------ CSV

const out = ["sync,label,dirtyChunks,liveChunks,shape,restoreRequests,restoreBytes,storageBytes,uploadRequestsCumulative"];
for (const [name] of shapes) {
  const cum = cumulative(results[name], "uploadRequests");
  results[name].forEach((r, i) => {
    out.push([r.sync, JSON.stringify(phases[i].label), plan[i].writes.length, row(ours, r.sync).liveChunks,
      name.replace(" ", "-"), r.restoreRequests, r.restoreBytes, r.storageBytes, cum[i]].join(","));
  });
}
if (restic) {
  for (const r of restic.rows) {
    const i = r.sync - 1;
    out.push([r.sync, JSON.stringify(r.phase === "repaired" ? "after repair index" : phases[i].label),
      plan[i].writes.length, row(ours, r.sync).liveChunks,
      "restic" + (r.phase === "repaired" ? "-compacted" : ""),
      r.restoreRequests, r.restoreBytes, r.storageBytes, r.uploadRequestsCumulative].join(","));
  }
  mkdirSync("traces", { recursive: true });
  writeFileSync("traces/history-restic.csv", toCsv(restic.rows));
}
writeFileSync("traces/history-replay.csv", out.join("\n") + "\n");
console.log(`\n  wrote traces/history-replay.csv${restic ? " and traces/history-restic.csv" : ""}`);
