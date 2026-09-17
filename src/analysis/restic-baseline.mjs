// restic on the same workload as the three commit shapes.
//
// Run with: node src/analysis/restic-baseline.mjs [syncs] [diskMB]
//
//   default 120 syncs on a 64 MB disk, matching compare-baselines.mjs.
//
// Needs two binaries on PATH, or named by RESTIC_BIN and REST_SERVER_BIN:
//
//   restic       https://github.com/restic/restic/releases
//   rest-server  https://github.com/restic/rest-server/releases
//
// What it does. A disk image is written by the same seeded plan the other
// shapes replay, with full-chunk payloads so restic's content-defined chunker
// sees an occupied block rather than zeros. After every sync the image is
// backed up; at every checkpoint the latest snapshot is restored to an empty
// directory by a client with no cache, which is what a machine rebuilt
// elsewhere has. Requests come from rest-server's access log and storage from
// the repository directory, so nothing here is reported by restic about
// itself. Compression is off, because the other shapes count logical bytes and
// this is a comparison of commit shapes, not of compressors. At the end the
// index is compacted, which is restic's answer to a history of many small
// index files, and restore is measured once more.
//
// No network beyond the loopback, no credentials. RESTIC_PASSWORD is set to a
// fixed string for a throwaway repository under the OS temporary directory.
// Set KEEP=1 to leave the repository behind for inspection.

import { mkdirSync, writeFileSync } from "node:fs";
import { workload, checkpoints } from "./baselines.js";
import { runRestic, toCsv } from "./restic-run.js";

const K = 1024;
const SYNCS = Number(process.argv[2] || 120);
const DISK_MB = Number(process.argv[3] || 64);
const DISK = DISK_MB * K * K;
const CHUNK = 256 * K;

const plan = workload({ syncs: SYNCS, diskSize: DISK, chunkSize: CHUNK, fullChunks: true });
const at = new Set(checkpoints(SYNCS));
const started = Date.now();
const mb = (b) => (b / K / K).toFixed(1);

console.log(`\nrestic on the shape workload, ${SYNCS} syncs on a ${DISK_MB} MB disk ` +
            `with ${CHUNK / K} KB chunks\n`);

let result;
try {
  result = await runRestic({
    plan, diskSize: DISK, chunkSize: CHUNK, measureAt: at,
    onSync: (row) => {
      if (row.sync % 50 === 0 || at.has(row.sync)) {
        const el = ((Date.now() - started) / 60000).toFixed(1);
        process.stdout.write(`  sync ${String(row.sync).padStart(5)}  ` +
          `${mb(row.storageBytes).padStart(8)} MB stored  ` +
          `${String(row.uploadRequestsCumulative).padStart(6)} upload requests` +
          (row.restoreRequests !== null
            ? `  restore ${row.restoreRequests} req / ${mb(row.restoreBytes)} MB`
            : "") +
          `  (${el} min)\n`);
      }
    }
  });
} catch (err) {
  console.error("\n" + err.message);
  process.exit(err.code === "ENOBIN" ? 2 : 1);
}

const { rows, repair, after, versions } = result;
console.log(`\n  ${versions.restic}\n  ${versions.restServer}`);

// ------------------------------------------------------------ report

const marks = rows.filter((r) => r.restoreRequests !== null);
console.log("\n  restore cost against history (requests / MB fetched), by part of the repository");
console.log("  sync           total       index   data  other   seconds");
for (const r of marks) {
  const label = r.phase === "repaired" ? `${r.sync}*` : String(r.sync);
  console.log(`  ${label.padStart(6)}  ${String(r.restoreRequests).padStart(6)} / ${mb(r.restoreBytes).padStart(7)}` +
    `  ${String(r.restoreIndex).padStart(6)} ${String(r.restoreData).padStart(6)} ${String(r.restoreOther).padStart(6)}` +
    `  ${r.restoreSeconds.toFixed(1).padStart(8)}`);
}
console.log("  * after `repair index`, restic's index compaction, every snapshot kept");

const last = rows.findLast((r) => r.phase === "backup");
console.log(`\n  storage at sync ${SYNCS}: ${mb(last.storageBytes)} MB, ${mb(after.storageBytes)} MB after repair`);
console.log(`  cumulative upload requests: ${last.uploadRequestsCumulative}` +
  ` (${(last.uploadRequestsCumulative / SYNCS).toFixed(1)} per sync)`);
console.log(`  index repair: ${repair.requests} requests, ${repair.seconds.toFixed(1)} s`);
console.log(`  backup wall time: ${(rows.filter((r) => r.phase === "backup")
  .reduce((a, r) => a + r.uploadSeconds, 0) / 60).toFixed(1)} min over ${SYNCS} syncs`);

console.log("\n  LaTeX column for tab:scaling (requests / MB):");
for (const r of marks.filter((r) => r.phase === "backup")) {
  console.log(`    ${r.sync} & ${r.restoreRequests} / ${mb(r.restoreBytes)} \\\\`);
}
console.log(`    after repair & ${after.restoreRequests} / ${mb(after.restoreBytes)} \\\\`);

mkdirSync("traces", { recursive: true });
const out = `traces/restic-${SYNCS}x${DISK_MB}mb.csv`;
writeFileSync(out, toCsv(rows));
console.log(`\n  wrote ${out}`);
if (process.env.KEEP === "1") console.log(`  kept ${result.work}`);
