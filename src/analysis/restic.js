// What the restic harness needs that does not need restic.
//
// The comparison in compare-baselines.mjs runs three commit shapes as our own
// implementations against a counting host. A reviewer can fairly say that a
// shape we wrote is not prior work. restic is prior work: a content-addressed,
// chunked, deduplicating store with a per-snapshot index, which is the shape we
// argued sits beside ours. Measuring it means driving the real binary against
// a real backend and reading its costs off something restic does not control.
//
// That something is rest-server's access log. Every request restic makes to
// the repository appears there as one line in combined log format, with the
// method, the path and the bytes served. Requests are counted from the log and
// storage is measured on disk, so restic reports nothing about itself, the
// same rule the counting host applies to our shapes.
//
// This module holds the parts that are pure: log parsing, request
// classification, and materialising a write plan into an image file. They are
// tested in test-restic.mjs; the harness that spawns processes is
// restic-baseline.mjs.

import { readdirSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

// ----------------------------------------------------------------- the log

// One combined-log line: host ident user [time] "METHOD path PROTO" status size
const LINE = /^(\S+) \S+ \S+ \[[^\]]*\] "(\S+) (\S+)[^"]*" (\d{3}) (\d+|-)/;

/** Parse an access log into requests. Lines that are not requests are skipped. */
export function parseCombinedLog(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    out.push({
      method: m[2],
      path: m[3],
      status: Number(m[4]),
      bytes: m[5] === "-" ? 0 : Number(m[5])
    });
  }
  return out;
}

/**
 * Which part of the repository a request touches.
 *
 * The REST layout mirrors restic's on-disk one: /config, and one directory
 * each for data, index, keys, locks and snapshots. A path ending in "/" is a
 * listing. Anything else, including the "/" rest-server answers on startup
 * probes, is "other".
 */
export function classify(path) {
  const p = path.split("?")[0];
  if (p === "/config") return "config";
  const m = /^\/(data|index|keys|locks|snapshots)(\/|$)/.exec(p);
  return m ? m[1] : "other";
}

export function isListing(path) {
  const p = path.split("?")[0];
  return p.length > 1 && p.endsWith("/");
}

/**
 * Requests and bytes, in total and by part of the repository.
 *
 * Bytes are the response sizes the log records, which for a Range read of a
 * pack is the slice served, not the pack. That is the right number: it is what
 * crosses the network.
 */
export function tally(entries) {
  const byType = {};
  let requests = 0, bytes = 0, listings = 0;
  for (const e of entries) {
    const t = classify(e.path);
    byType[t] ??= { requests: 0, bytes: 0, listings: 0 };
    byType[t].requests++;
    byType[t].bytes += e.bytes;
    requests++;
    bytes += e.bytes;
    if (isListing(e.path)) { byType[t].listings++; listings++; }
  }
  return { requests, bytes, listings, byType };
}

/** The entries added to a log since a byte offset, and the new offset. */
export function sinceOffset(text, offset) {
  const fresh = text.slice(offset);
  const complete = fresh.endsWith("\n") ? fresh : fresh.slice(0, fresh.lastIndexOf("\n") + 1);
  return { entries: parseCombinedLog(complete), offset: offset + complete.length };
}

// --------------------------------------------------------------- the image

/**
 * Apply one sync's writes to an open image file.
 *
 * Each write lands at its chunk's offset, exactly as MemoryDevice.write does
 * for the in-process shapes, so the file restic backs up is the disk the other
 * shapes committed. `write` is injectable for the tests.
 */
export function materialise(fd, writes, chunkSize, write = writeSync) {
  let total = 0;
  for (const w of writes) {
    const bytes = w.bytes;
    write(fd, bytes, 0, bytes.length, w.index * chunkSize);
    total += bytes.length;
  }
  return total;
}

/** Bytes held by regular files under a directory, which is what a store costs. */
export function dirBytes(root) {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) stack.push(p);
      else total += st.size;
    }
  }
  return total;
}

/** The first file with this name under a directory, or null. */
export function findFile(root, name) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) stack.push(p);
      else if (entry === name) return p;
    }
  }
  return null;
}

/**
 * The snapshot id from `restic backup --json`, which prints one JSON object per
 * line and ends with a summary carrying the id.
 */
export function snapshotIdFrom(stdout) {
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const o = JSON.parse(line);
      if (o.message_type === "summary" && o.snapshot_id) return o.snapshot_id;
    } catch { /* not JSON; restic also prints progress lines */ }
  }
  return null;
}
