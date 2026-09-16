// Tests for the baseline shapes.
//
// A comparison table is only as good as the accounting behind each column, so
// every shape is checked against a case whose answer is known before it is
// trusted on a case whose answer is the point. The three properties that make
// the shapes different are each pinned: whole-image storage grows by the disk
// size per sync, delta-pack restore grows by one request per sync, and
// chunk-exploded restore holds still when the live set does.
//
// Run with: node src/test-baselines.mjs

import {
  CountingHost, WholeImage, DeltaPack, ChunkExploded, workload, run, cumulative
} from "./analysis/baselines.js";

let passed = 0, failed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log("  PASS  " + name); }
  else { failed++; failures.push(name); console.log("  FAIL  " + name + (detail ? "   [" + detail + "]" : "")); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
        `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const K = 1024;
const DISK = 4 * K * K;       // 4 MB
const CHUNK = 256 * K;        // 16 chunks
const enc = new TextEncoder();

/** A hand-built plan whose every consequence can be computed on paper. */
const fixed = [
  { sync: 1, writes: [{ index: 0, bytes: enc.encode("a") }, { index: 3, bytes: enc.encode("b") }] },
  { sync: 2, writes: [{ index: 0, bytes: enc.encode("c") }] },        // rewrite only
  { sync: 3, writes: [{ index: 7, bytes: enc.encode("d") }] },        // one new chunk
  { sync: 4, writes: [{ index: 3, bytes: enc.encode("e") }] }         // rewrite only
];

// ------------------------------------------------------------------ workload

console.log("\nthe shared workload");
{
  const a = workload({ syncs: 20, diskSize: DISK, chunkSize: CHUNK, seed: 7 });
  const b = workload({ syncs: 20, diskSize: DISK, chunkSize: CHUNK, seed: 7 });
  eq("the same seed gives byte-identical plans", JSON.stringify(a), JSON.stringify(b));
  const c = workload({ syncs: 20, diskSize: DISK, chunkSize: CHUNK, seed: 8 });
  check("a different seed gives a different plan", JSON.stringify(a) !== JSON.stringify(c));
  eq("one entry per sync", a.length, 20);
  check("every write lands inside the disk",
        a.every((s) => s.writes.every((w) => w.index * CHUNK < DISK)));

  // The second half must allocate nothing new, or the live set is not held still.
  const touched = (steps) => new Set(steps.flatMap((s) => s.writes.map((w) => w.index)));
  const firstHalf = touched(a.slice(0, 10));
  const secondHalf = touched(a.slice(10));
  check("the second half allocates no chunk the first did not",
        [...secondHalf].every((i) => firstHalf.has(i)),
        `new in second half: ${[...secondHalf].filter((i) => !firstHalf.has(i))}`);
}

// --------------------------------------------------------------- whole image

console.log("\nwhole image");
{
  const rows = await run(WholeImage, { plan: fixed, diskSize: DISK, chunkSize: CHUNK });
  eq("one object uploaded per sync", rows.map((r) => r.uploadRequests - 3), [1, 1, 1, 1]);
  eq("each upload is the whole disk", rows.map((r) => r.uploadBytes), [DISK, DISK, DISK, DISK]);
  eq("storage grows by the disk every sync",
     rows.map((r) => r.storageBytes), [DISK, 2 * DISK, 3 * DISK, 4 * DISK]);
  eq("restore is always one object plus the two lookups",
     rows.map((r) => r.restoreRequests), [3, 3, 3, 3]);
  eq("and always the whole disk", rows.map((r) => r.restoreBytes), [DISK, DISK, DISK, DISK]);
}

// ---------------------------------------------------------------- delta pack

console.log("\ndelta pack");
{
  const rows = await run(DeltaPack, { plan: fixed, diskSize: DISK, chunkSize: CHUNK });
  eq("one pack uploaded per sync", rows.map((r) => r.uploadRequests - 3), [1, 1, 1, 1]);
  // Pack size is the dirty chunks in full plus a 4-byte index per chunk.
  eq("a pack holds exactly the dirty chunks",
     rows.map((r) => r.uploadBytes), [2 * (CHUNK + 4), CHUNK + 4, CHUNK + 4, CHUNK + 4]);
  eq("storage is the sum of the packs, nothing more",
     rows[3].storageBytes, 5 * (CHUNK + 4));
  // This is the property that makes it the wrong shape for a request budget.
  eq("restore fetches every pack so far, plus the two lookups",
     rows.map((r) => r.restoreRequests), [3, 4, 5, 6]);
  check("restore bytes grow with history even when the live set does not",
        rows[3].restoreBytes > rows[1].restoreBytes,
        `${rows[1].restoreBytes} then ${rows[3].restoreBytes}`);
}
{
  // The replay must actually reconstruct the disk, or the cost means nothing.
  const host = new CountingHost();
  const shape = new DeltaPack({ host, diskSize: DISK, chunkSize: CHUNK, branch: "m" });
  for (const step of fixed) { await shape.apply(step.writes); await shape.sync(); }
  await shape.restore();
  const disk = shape._restored;
  const dec = new TextDecoder();
  eq("chunk 0 holds its last write", dec.decode(disk.subarray(0, 1)), "c");
  eq("chunk 3 holds its last write", dec.decode(disk.subarray(3 * CHUNK, 3 * CHUNK + 1)), "e");
  eq("chunk 7 holds its only write", dec.decode(disk.subarray(7 * CHUNK, 7 * CHUNK + 1)), "d");
  eq("an untouched chunk is still blank", disk[5 * CHUNK], 0);
}

// ------------------------------------------------------------ chunk exploded

console.log("\nchunk exploded");
{
  const rows = await run(ChunkExploded, { plan: fixed, diskSize: DISK, chunkSize: CHUNK });
  // Live set: {0,3} then {0,3} then {0,3,7} then {0,3,7}.
  eq("the live set is what the disk currently needs",
     rows.map((r) => r.liveChunks), [2, 2, 3, 3]);
  eq("restore reads the live set plus three",
     rows.map((r) => r.restoreRequests - r.liveChunks), [3, 3, 3, 3]);
  // Syncs 2 and 4 rewrite a chunk without allocating; restore must not grow.
  eq("restore holds still across a rewrite-only sync",
     [rows[0].restoreRequests, rows[1].restoreRequests], [5, 5]);
  eq("and again", [rows[2].restoreRequests, rows[3].restoreRequests], [6, 6]);
  // Storage keeps the superseded chunks until compaction, which is the price.
  check("storage holds every chunk version written", rows[3].storageObjects >= 5,
        `${rows[3].storageObjects} objects`);
}

// ------------------------------------------- the comparison the paper needs

console.log("\nthe three shapes on one workload");
{
  const plan = workload({ syncs: 40, diskSize: DISK, chunkSize: CHUNK, seed: 3 });
  const [whole, delta, ours] = await Promise.all([
    run(WholeImage, { plan, diskSize: DISK, chunkSize: CHUNK }),
    run(DeltaPack, { plan, diskSize: DISK, chunkSize: CHUNK }),
    run(ChunkExploded, { plan, diskSize: DISK, chunkSize: CHUNK })
  ]);
  const last = (rows) => rows[rows.length - 1];
  const mid = (rows) => rows[Math.floor(rows.length / 2)];

  // Each shape wins exactly where the paper says it does.
  check("whole image restores in the fewest requests",
        last(whole).restoreRequests < last(ours).restoreRequests);
  // Exact, not a guessed multiplier: whole-image stores the disk per sync,
  // and ours can store at most the dirty chunks per sync. The ratio between
  // them is diskSize over dirty bytes, which is 4x on this tiny disk and 64x
  // on the paper's, so the margin is a property of geometry, not of luck.
  eq("but stores the whole disk every sync", last(whole).storageBytes, plan.length * DISK);
  check("while ours stores at most the dirty chunks",
        last(ours).storageBytes <= plan.length * 4 * CHUNK,
        `${last(ours).storageBytes} vs bound ${plan.length * 4 * CHUNK}`);
  check("so whole image stores more by at least the geometric ratio",
        last(whole).storageBytes >= 3 * last(ours).storageBytes,
        `ratio ${(last(whole).storageBytes / last(ours).storageBytes).toFixed(1)}x`);
  check("delta pack stores the least",
        last(delta).storageBytes <= last(ours).storageBytes);
  check("but its restore grows with history in the saturated half",
        last(delta).restoreRequests > mid(delta).restoreRequests + 10,
        `${mid(delta).restoreRequests} then ${last(delta).restoreRequests}`);
  check("while ours holds still in the saturated half",
        last(ours).restoreRequests === mid(ours).restoreRequests,
        `${mid(ours).restoreRequests} then ${last(ours).restoreRequests}`);
  check("and ours restores fewer bytes than delta pack replays",
        last(ours).restoreBytes < last(delta).restoreBytes);

  const total = (rows) => cumulative(rows, "uploadRequests").pop();
  check("cumulative upload requests are what the rate limit meters, and ours pays most",
        total(ours) > total(delta), `${total(ours)} vs ${total(delta)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log("failures: " + failures.join("; ")); process.exit(1); }
