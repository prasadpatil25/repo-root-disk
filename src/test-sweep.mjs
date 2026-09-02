// Tests for the chunk-size sweep.
//
// The sweep replaces five guest runs with one recorded trace and arithmetic, so
// the arithmetic has to be right. These use traces whose answers can be worked
// out by hand.
//
// Run with: node src/test-sweep.mjs

import { costAt, sweep, timeAt, best, bytesWritten, bytesTouched, table } from "./analysis/sweep.js";

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
const MB = 1024 * K;

// ------------------------------------------------------------------ counting

console.log("\ncounting what the guest wrote");
{
  const ranges = [{ offset: 0, length: 100 }, { offset: 500, length: 50 }];
  eq("bytes written is the sum of the ranges", bytesWritten(ranges), 150);
  eq("and so is bytes touched when they do not overlap",
     bytesTouched(ranges, 1 * MB), 150);
}
{
  // A rewritten region is written twice but occupies one place on the disk, and
  // only the second matters for what has to be uploaded.
  const ranges = [{ offset: 0, length: 100 }, { offset: 50, length: 100 }];
  eq("a rewrite counts twice in bytes written", bytesWritten(ranges), 200);
  eq("but once in bytes touched", bytesTouched(ranges, 1 * MB), 150);
}
{
  const ranges = [{ offset: 0, length: 100 }, { offset: 0, length: 100 }];
  eq("an exact rewrite touches the same bytes", bytesTouched(ranges, 1 * MB), 100);
}
{
  const ranges = [{ offset: 900, length: 500 }];
  eq("a range running past the disk end is clipped", bytesTouched(ranges, 1000), 100);
}

// ------------------------------------------------------------------- costing

console.log("\nwhat a chunk size costs");
{
  // One byte at offset zero dirties exactly one chunk, whatever its size, so
  // amplification is the chunk size itself.
  const trace = { diskSize: 4 * MB, ranges: [{ offset: 0, length: 1 }] };
  const small = costAt(trace, 64 * K);
  const large = costAt(trace, 1 * MB);
  eq("one byte dirties one chunk at any size", [small.chunks, large.chunks], [1, 1]);
  eq("and the upload is that chunk in full",
     [small.uploadedBytes, large.uploadedBytes], [64 * K, 1 * MB]);
  check("so a bigger chunk amplifies more",
        large.amplification > small.amplification,
        `${small.amplification} vs ${large.amplification}`);
  eq("the smaller one is exactly the chunk size", small.amplification, 64 * K);
}
{
  // Writes spread one per chunk: halving the chunk size halves the upload,
  // because each write still dirties exactly one chunk.
  const ranges = [];
  for (let i = 0; i < 8; i++) ranges.push({ offset: i * 256 * K, length: 4 * K });
  const trace = { diskSize: 4 * MB, ranges };
  const at256 = costAt(trace, 256 * K);
  const at128 = costAt(trace, 128 * K);
  eq("scattered writes dirty one chunk each", at256.chunks, 8);
  eq("and still one each when the chunk halves", at128.chunks, 8);
  eq("so the upload halves", at128.uploadedBytes, at256.uploadedBytes / 2);
}
{
  // A contiguous write fills whole chunks, so chunk size barely matters: this is
  // the sequential case, and it is why bulk writes amplify far less.
  const trace = { diskSize: 4 * MB, ranges: [{ offset: 0, length: 2 * MB }] };
  const at256 = costAt(trace, 256 * K);
  const at64 = costAt(trace, 64 * K);
  eq("a full sequential write uploads what it wrote", at256.uploadedBytes, 2 * MB);
  eq("at any chunk size", at64.uploadedBytes, 2 * MB);
  eq("with no amplification at all", at256.amplification, 1);
  check("but the request count rises as chunks shrink",
        at64.requests > at256.requests, `${at256.requests} vs ${at64.requests}`);
}
{
  // The last chunk of a disk that is not a whole number of chunks is short, and
  // charging a full chunk for it would overstate the cost.
  const trace = { diskSize: 300 * K, ranges: [{ offset: 290 * K, length: 10 }] };
  const cost = costAt(trace, 256 * K);
  eq("the final short chunk is charged at its real length",
     cost.uploadedBytes, 44 * K);
}

// -------------------------------------------------------------- the tradeoff

console.log("\nwhich cost binds");
{
  const ranges = [];
  for (let i = 0; i < 200; i++) ranges.push({ offset: i * 512 * K, length: 8 * K });
  const trace = { diskSize: 256 * MB, ranges };
  const rows = sweep(trace, [64 * K, 256 * K, 1024 * K]).map((c) => timeAt(c));

  check("smaller chunks send fewer bytes",
        rows[0].uploadedBytes < rows[2].uploadedBytes);
  check("and cost more requests", rows[0].requests > rows[2].requests);
  check("every row says which limit binds it",
        rows.every((r) => r.boundBy === "requests" || r.boundBy === "transfer"));
}
{
  // On a fast link with a hard write ceiling, requests bind and larger chunks
  // win. That is the forge's regime, and it is why the default is not tiny.
  const ranges = [];
  for (let i = 0; i < 400; i++) ranges.push({ offset: i * 128 * K, length: 4 * K });
  const trace = { diskSize: 256 * MB, ranges };
  const fastLink = best(trace, [64 * K, 128 * K, 256 * K, 512 * K], { mbps: 500, writesPerMinute: 180 });
  check("a fast link with a write ceiling prefers larger chunks",
        fastLink.chunkSize >= 256 * K, `${fastLink.chunkSize / 1024}K`);
  eq("and says so", fastLink.boundBy, "requests");

  // On a slow link with no ceiling worth speaking of, bytes bind and the
  // preference reverses. The point is that there is no single right answer.
  const slowLink = best(trace, [64 * K, 128 * K, 256 * K, 512 * K], { mbps: 2, writesPerMinute: 100000 });
  check("a slow link with no ceiling prefers smaller chunks",
        slowLink.chunkSize <= 128 * K, `${slowLink.chunkSize / 1024}K`);
  eq("bound by transfer", slowLink.boundBy, "transfer");
}
{
  const trace = { diskSize: 4 * MB, ranges: [{ offset: 0, length: 1 }] };
  const rendered = table(sweep(trace, [64 * K, 256 * K]).map((c) => timeAt(c)));
  check("the table renders both rows", rendered.split("\n").length === 3, rendered);
  check("with the chunk size in KB", /64K/.test(rendered) && /256K/.test(rendered));
}
{
  const empty = { diskSize: 4 * MB, ranges: [] };
  const cost = costAt(empty, 256 * K);
  eq("a trace with no writes costs nothing", [cost.chunks, cost.uploadedBytes], [0, 0]);
  eq("and does not divide by zero", cost.amplification, 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log("failures: " + failures.join("; ")); process.exit(1); }
