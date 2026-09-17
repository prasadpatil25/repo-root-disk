// Tests for the restic harness's pure parts.
//
// The harness reads every number off rest-server's access log and the
// repository directory, so what must be right is the reading: that a log line
// parses to the request it records, that a request is attributed to the right
// part of the repository, that incremental reads never count a line twice or
// split one, and that the image the plan materialises is the disk the other
// shapes committed. None of this needs restic installed.
//
// Run with: node src/test-restic.mjs

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCombinedLog, classify, isListing, tally, sinceOffset, materialise,
  dirBytes, findFile, snapshotIdFrom
} from "./analysis/restic.js";
import { workload, checkpoints } from "./analysis/baselines.js";
import { packPhase, readPhase, planFrom } from "./analysis/history.js";

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

// ------------------------------------------------------------ the log

console.log("\nparsing the access log");
{
  const UA = '"" "restic/0.18.0 (windows amd64) go1.24"';
  const lines = [
    `127.0.0.1 - - [17/Sep/2026:10:00:00 +0530] "GET /config HTTP/1.1" 200 155 ${UA}`,
    `127.0.0.1 - - [17/Sep/2026:10:00:00 +0530] "GET /index/ HTTP/1.1" 200 4096 ${UA}`,
    `127.0.0.1 - - [17/Sep/2026:10:00:01 +0530] "POST /data/0a1b2c HTTP/1.1" 200 - ${UA}`,
    `127.0.0.1 - - [17/Sep/2026:10:00:01 +0530] "GET /data/0a1b2c HTTP/1.1" 206 262144 ${UA}`,
    `127.0.0.1 - - [17/Sep/2026:10:00:01 +0530] "DELETE /locks/ff HTTP/1.1" 200 0 ${UA}`,
    `rest-server: listening on 127.0.0.1:8765`,
    ``
  ];
  const got = parseCombinedLog(lines.join("\n"));
  eq("five requests parse, the server's own line is skipped", got.length, 5);
  eq("method, path, status and bytes are read",
     got[0], { method: "GET", path: "/config", status: 200, bytes: 155 });
  eq("a dash for size is zero bytes", got[2].bytes, 0);
  eq("a partial content response keeps its served size", got[3], { method: "GET", path: "/data/0a1b2c", status: 206, bytes: 262144 });
  eq("DELETE parses like any other method", got[4].method, "DELETE");
}

console.log("\nattributing requests");
{
  eq("config", classify("/config"), "config");
  eq("a data object", classify("/data/0a1b2c"), "data");
  eq("a data listing", classify("/data/"), "data");
  eq("an index file", classify("/index/abc"), "index");
  eq("a snapshot", classify("/snapshots/abc"), "snapshots");
  eq("a lock", classify("/locks/abc"), "locks");
  eq("a key", classify("/keys/abc"), "keys");
  eq("the root is other", classify("/"), "other");
  eq("init's create query is other", classify("/?create=true"), "other");
  eq("a query string does not change the part", classify("/data/abc?x=1"), "data");
  check("a directory path is a listing", isListing("/index/"));
  check("an object path is not", !isListing("/index/abc"));
  check("the root is not a listing", !isListing("/"));
}

console.log("\ntallying");
{
  const entries = parseCombinedLog([
    `h - - [t] "GET /config HTTP/1.1" 200 100 "" ""`,
    `h - - [t] "GET /index/ HTTP/1.1" 200 50 "" ""`,
    `h - - [t] "GET /index/a HTTP/1.1" 200 1000 "" ""`,
    `h - - [t] "GET /index/b HTTP/1.1" 200 1000 "" ""`,
    `h - - [t] "GET /data/x HTTP/1.1" 206 300 "" ""`,
    `h - - [t] "GET /data/x HTTP/1.1" 206 300 "" ""`
  ].join("\n"));
  const t = tally(entries);
  eq("total requests", t.requests, 6);
  eq("total bytes", t.bytes, 2750);
  eq("one listing", t.listings, 1);
  eq("index: three requests including the listing", t.byType.index, { requests: 3, bytes: 2050, listings: 1 });
  eq("data: two range reads", t.byType.data, { requests: 2, bytes: 600, listings: 0 });
  eq("config: one", t.byType.config.requests, 1);
  eq("an empty log tallies to zero", tally([]), { requests: 0, bytes: 0, listings: 0, byType: {} });
}

console.log("\nreading the log incrementally");
{
  const l1 = `h - - [t] "GET /config HTTP/1.1" 200 100 "" ""\n`;
  const l2 = `h - - [t] "GET /index/ HTTP/1.1" 200 50 "" ""\n`;
  const half = `h - - [t] "GET /data/x HTTP`;
  let r = sinceOffset(l1, 0);
  eq("first read sees the first line", r.entries.length, 1);
  eq("and advances past it", r.offset, l1.length);
  r = sinceOffset(l1 + l2 + half, r.offset);
  eq("second read sees only the new complete line", r.entries.map((e) => e.path), ["/index/"]);
  eq("a line still being written is not consumed", r.offset, l1.length + l2.length);
  r = sinceOffset(l1 + l2 + half + `/1.1" 206 7 "" ""\n`, r.offset);
  eq("and is read whole once complete", r.entries[0].bytes, 7);
  eq("nothing new reads as nothing", sinceOffset(l1, l1.length).entries, []);
}

// ------------------------------------------------------------ the image

console.log("\nmaterialising the plan");
{
  const CHUNK = 256 * K;
  const calls = [];
  const write = (fd, buf, off, len, pos) => { calls.push({ fd, off, len, pos }); };
  const plan = workload({ syncs: 4, diskSize: 4 * K * K, chunkSize: CHUNK, fullChunks: true });
  const total = materialise(7, plan[0].writes, CHUNK, write);
  eq("one write per plan entry", calls.length, plan[0].writes.length);
  check("every write is a full chunk", calls.every((c) => c.len === CHUNK), JSON.stringify(calls.map((c) => c.len)));
  check("every write lands at its chunk's offset",
        calls.every((c, i) => c.pos === plan[0].writes[i].index * CHUNK && c.off === 0));
  eq("the total is what was written", total, calls.length * CHUNK);

  const w = plan[0].writes[0];
  const a = w.bytes, b = w.bytes;
  check("a full-chunk payload is deterministic across accesses", Buffer.compare(a, b) === 0);
  check("and is not the same object twice", a !== b);
  check("and is not zeros", a.some((x) => x !== 0));
  const other = plan[0].writes[1].bytes;
  check("two writes in one sync differ", Buffer.compare(a, other) !== 0);

  const plain = workload({ syncs: 4, diskSize: 4 * K * K, chunkSize: CHUNK });
  eq("the full-chunk plan dirties the same chunks in the same order as the plain one",
     plan.map((s) => s.writes.map((w) => w.index)),
     plain.map((s) => s.writes.map((w) => w.index)));
  check("the plain plan's payloads stay small", plain[0].writes[0].bytes.length < 64);
}

console.log("\ncheckpoints");
{
  eq("the paper's six at 120", checkpoints(120), [1, 10, 30, 60, 90, 120]);
  eq("a spread over both halves at 1,000", checkpoints(1000), [1, 10, 100, 500, 750, 1000]);
  eq("a short run keeps only what it reaches", checkpoints(20), [1, 10, 20]);
  eq("one sync is one checkpoint", checkpoints(1), [1]);
  check("every checkpoint is within the run", checkpoints(300).every((n) => n >= 1 && n <= 300));
}

console.log("\nthe repository on disk");
{
  const dir = mkdtempSync(join(tmpdir(), "restic-test-"));
  mkdirSync(join(dir, "data", "0a"), { recursive: true });
  mkdirSync(join(dir, "index"));
  writeFileSync(join(dir, "config"), "x".repeat(10));
  writeFileSync(join(dir, "data", "0a", "0a1b"), "y".repeat(1000));
  writeFileSync(join(dir, "index", "aa"), "z".repeat(100));
  eq("bytes are summed over every regular file", dirBytes(dir), 1110);
  eq("a file is found at any depth", findFile(dir, "0a1b"), join(dir, "data", "0a", "0a1b"));
  eq("a missing file is null", findFile(dir, "nope"), null);
  rmSync(dir, { recursive: true, force: true });
}

console.log("\nthe snapshot id");
{
  const out = [
    `{"message_type":"status","percent_done":0.5}`,
    `{"message_type":"summary","files_new":0,"snapshot_id":"abc123"}`
  ].join("\n") + "\n";
  eq("read from the summary line", snapshotIdFrom(out), "abc123");
  eq("absent when there is no summary", snapshotIdFrom(`{"message_type":"status"}\n`), null);
  eq("noise around the JSON is tolerated", snapshotIdFrom("warning: x\n" + out + "\n"), "abc123");
}

console.log("\na captured history");
{
  const CHUNK = 1024;
  const a = new Uint8Array(CHUNK).fill(1), b = new Uint8Array(CHUNK).fill(2);
  const packed = packPhase({ label: "two chunks", chunkSize: CHUNK, chunks: [3, 9] }, [a, b]);
  eq("a phase file is a header length, the header, then the chunks", packed.length, 4 + packed.subarray(4).indexOf(0x7d) + 1 + 2 * CHUNK);
  const { header, writes } = readPhase(packed);
  eq("the header round-trips", header, { label: "two chunks", chunkSize: CHUNK, chunks: [3, 9] });
  eq("each chunk lands at its index", writes.map((w) => w.index), [3, 9]);
  check("with its bytes", writes[0].bytes.every((x) => x === 1) && writes[1].bytes.every((x) => x === 2));
  eq("an explicit chunk size overrides the header's", readPhase(packed, CHUNK).writes.length, 2);
  let threw = null;
  try { readPhase(packed.subarray(0, packed.length - 1)); } catch (e) { threw = e.message; }
  check("a truncated file is refused, not read short", /truncated/.test(threw || ""), threw);

  const history = {
    chunkSize: CHUNK,
    phases: [
      { index: 0, label: "format", chunks: [0, 1], file: "phase-000.bin" },
      { index: 1, label: "nothing", chunks: [], file: "phase-001.bin" },
      { index: 2, label: "work", chunks: [1], file: "phase-002.bin" }
    ]
  };
  const files = {
    "phase-000.bin": packPhase({ chunks: [0, 1] }, [a, b]),
    "phase-002.bin": packPhase({ chunks: [1] }, [a])
  };
  const full = planFrom(history, (f) => files[f] || null);
  eq("a phase that wrote nothing is not a sync", full.plan.length, 2);
  eq("and is counted as skipped", full.skipped, 1);
  eq("syncs are renumbered contiguously", full.plan.map((s) => s.sync), [1, 2]);
  eq("labels follow the kept phases", full.labels, ["format", "work"]);
  check("every phase had its bytes", full.haveBytes);
  check("and the plan carries them", full.plan[1].writes[0].bytes.every((x) => x === 1));

  const bare = planFrom(history, () => null);
  check("without phase files the plan still exists", bare.plan.length === 2 && !bare.haveBytes);
  eq("with the same chunk indices", bare.plan[0].writes.map((w) => w.index), [0, 1]);
  check("and distinct small payloads so nothing deduplicates by accident",
        Buffer.compare(bare.plan[0].writes[0].bytes, bare.plan[0].writes[1].bytes) !== 0
        && bare.plan[0].writes[0].bytes.length < 64);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log("failures: " + failures.join("; ")); process.exit(1); }
