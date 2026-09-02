// What chunk size costs, computed from one recorded write trace.
//
// The obvious way to measure this is to install a distribution five times at
// five chunk sizes. That is slow and it is also worse: each run writes slightly
// differently, so the comparison carries run-to-run variation that has nothing
// to do with chunk size.
//
// Nothing about the guest depends on chunk size. It writes the same bytes to the
// same offsets whatever the sync engine later does with them, and dirtyChunks is
// a pure function of the trace. So one real run gives a trace, and every chunk
// size is computed from it exactly. Same workload, no variance, and the whole
// sweep takes milliseconds.
//
// What this does not capture is content deduplication between chunks, which
// depends on the bytes rather than the ranges. That is measured separately and,
// on these machines, is close to nothing.

import { dirtyChunks, chunkCount, chunkExtent } from "../core/chunker.js";

/**
 * @typedef {{offset: number, length: number}} Range
 * @typedef {Object} Trace
 * @property {string} label
 * @property {number} diskSize
 * @property {Range[]} ranges  the epoch, as the device recorded it
 */

/** Bytes the guest actually wrote, counting a rewritten byte once per write. */
export function bytesWritten(ranges) {
  return ranges.reduce((sum, r) => sum + r.length, 0);
}

/** Distinct bytes touched, so a range rewritten twice is counted once. */
export function bytesTouched(ranges, diskSize) {
  const sorted = [...ranges].sort((a, b) => a.offset - b.offset);
  let total = 0;
  let end = -1;
  for (const range of sorted) {
    const from = Math.max(range.offset, end);
    const to = Math.min(range.offset + range.length, diskSize);
    if (to > from) { total += to - from; end = to; }
    else if (to > end) end = to;
  }
  return total;
}

/**
 * What one chunk size would cost for a trace.
 *
 * `uploadedBytes` is what the protocol actually sends: every dirty chunk in
 * full, because a chunk is the unit of content addressing. That is the number
 * the rate budget and the transfer time both follow from.
 */
export function costAt(trace, chunkSize) {
  const { ranges, diskSize } = trace;
  const indices = dirtyChunks(ranges, chunkSize, diskSize);

  let uploadedBytes = 0;
  for (const index of indices) {
    uploadedBytes += chunkExtent(index, chunkSize, diskSize).length;
  }

  const touched = bytesTouched(ranges, diskSize);
  return {
    chunkSize,
    chunks: indices.length,
    totalChunks: chunkCount(diskSize, chunkSize),
    uploadedBytes,
    touchedBytes: touched,
    // The cost of chunking: bytes sent for each distinct byte the guest wrote.
    amplification: touched === 0 ? 0 : uploadedBytes / touched,
    // Requests matter as much as bytes on a forge with a write-rate ceiling.
    requests: indices.length + 3
  };
}

/** The same trace at every chunk size, for the curve. */
export function sweep(trace, chunkSizes) {
  return chunkSizes.map((size) => costAt(trace, size));
}

/**
 * Where the two costs cross.
 *
 * Smaller chunks send fewer bytes and cost more requests; larger chunks the
 * reverse. Which one binds depends on the link and on the forge's write rate,
 * so the useful output is the size that minimises wall-clock time under a stated
 * pair of limits rather than a single recommended number.
 *
 * @param {number} options.mbps link throughput
 * @param {number} options.writesPerMinute the forge's enforced write ceiling
 */
export function timeAt(cost, { mbps = 50, writesPerMinute = 180 } = {}) {
  const transferSeconds = (cost.uploadedBytes * 8) / (mbps * 1e6);
  const requestSeconds = (cost.requests / writesPerMinute) * 60;
  // The two overlap: uploads are in flight while the rate limiter meters them,
  // so the binding constraint is whichever is larger, not their sum.
  return {
    ...cost,
    transferSeconds,
    requestSeconds,
    seconds: Math.max(transferSeconds, requestSeconds),
    boundBy: requestSeconds > transferSeconds ? "requests" : "transfer"
  };
}

export function best(trace, chunkSizes, limits) {
  const rows = sweep(trace, chunkSizes).map((c) => timeAt(c, limits));
  return rows.reduce((a, b) => (b.seconds < a.seconds ? b : a));
}

/** A fixed-width table, for pasting into a write-up. */
export function table(rows) {
  const head = "  chunk    chunks   uploaded    amplif.  requests   bound by     seconds";
  const lines = rows.map((r) =>
    `  ${String(r.chunkSize / 1024).padStart(5)}K ` +
    `${String(r.chunks).padStart(9)} ` +
    `${(r.uploadedBytes / 1048576).toFixed(1).padStart(8)}M ` +
    `${r.amplification.toFixed(2).padStart(9)}x ` +
    `${String(r.requests).padStart(9)} ` +
    `${(r.boundBy || "").padStart(10)} ` +
    `${(r.seconds ?? 0).toFixed(1).padStart(11)}`
  );
  return [head, ...lines].join("\n");
}
