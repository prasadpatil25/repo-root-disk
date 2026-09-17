// Three commit shapes, run as real systems on one workload.
//
// The paper argued that its commit shape gives restore cost independent of a
// machine's age, and supported that with a counterfactual: the number of writes
// a replaying design *would* have to reapply. A counted hypothetical is not a
// comparison. This module makes each shape a working implementation against
// the same counting host, so that storage, upload and restore are measured for
// all of them by the same accounting, on byte-identical workloads.
//
// The shapes:
//
//   whole-image     One blob per sync holding the entire disk. This is what a
//                   system that saves a machine image to the user's drive does
//                   (OnWorks). Restore is one object; storage is the disk size
//                   times the number of syncs, because every sync differs.
//
//   delta-pack      One blob per sync holding only that sync's dirty chunks.
//                   Restore replays every pack since the base. This is the
//                   incremental-backup shape, and the one we initially preferred
//                   on request economy. Storage is minimal; restore grows with
//                   history.
//
//   chunk-exploded  Ours. One object per chunk, and every commit's tree names
//                   every live chunk. Restore reads the live set. This is the
//                   real Machine, not a model of it.
//
// A fourth shape is worth naming because it is what restic, Borg and bup
// actually do: content-addressed chunks with a per-snapshot index, which is
// chunk-exploded in restore behaviour and delta-pack-like in that a snapshot
// references rather than re-uploads unchanged chunks. Our shape is that one
// carried onto a git tree. The comparison below therefore brackets it from both
// sides rather than pretending those systems sit at one extreme.

import { Machine, restore } from "../core/machine.js";
import { MemoryDevice } from "../device/memory.js";
import { Governor } from "../core/governor.js";
import { chunkExtent } from "../core/chunker.js";
import { blobId } from "../core/objectid.js";
import * as manifestModule from "../core/manifest.js";

// ---------------------------------------------------------------- workload

/** Seeded generator, so a reported number can be reproduced. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * The write plan, generated once and replayed to every shape.
 *
 * Two halves: the disk grows for the first, and is only rewritten in the
 * second. That holds the live set still while history keeps growing, which is
 * the only condition under which "restore cost tracks history" and "restore
 * cost tracks the live set" make different predictions.
 *
 * Generated up front rather than during each run, so the shapes see identical
 * bytes in identical order and nothing about the comparison depends on which
 * one ran first.
 */
export function workload({
  syncs, diskSize, chunkSize, seed = 20260830,
  hotChunks = 12, writesPerSync = 4, newChunkChance = 0.25, fullChunks = false
}) {
  const random = rng(seed);
  const encoder = new TextEncoder();
  const totalChunks = Math.ceil(diskSize / chunkSize);
  const allocated = [];
  const plan = [];

  for (let n = 1; n <= syncs; n++) {
    const growing = n <= Math.floor(syncs / 2);
    const writes = [];
    for (let w = 0; w < writesPerSync; w++) {
      let index;
      if (allocated.length < hotChunks || (growing && random() < newChunkChance)) {
        index = Math.floor(random() * totalChunks);
        if (!allocated.includes(index)) allocated.push(index);
      } else {
        index = allocated[Math.floor(random() * allocated.length)];
      }
      // Content differs on every write, so nothing deduplicates by accident.
      const tag = `sync ${n} write ${w} ${random()}`;
      writes.push(fullChunks
        ? lazyChunk(index, tag, chunkSize)
        : { index, bytes: encoder.encode(tag) });
    }
    plan.push({ sync: n, writes });
  }
  return plan;
}

/**
 * A write that fills its whole chunk with seeded random bytes.
 *
 * The default payload is a short string, which is all the in-process shapes
 * need: they commit whole chunks and count them, so content never enters a
 * number. A content-defined chunker sees content, and to it a 30-byte string
 * inside 256 KB of zeros is a zero-filled file; restic would split and
 * deduplicate it like one. `fullChunks` gives every write a chunk's worth of
 * entropy instead, which is what an occupied block looks like on a real disk.
 *
 * The bytes are regenerated on each access from the write's tag, so a plan of
 * a thousand syncs costs kilobytes to hold rather than a gigabyte.
 */
function lazyChunk(index, tag, chunkSize) {
  let seed = 2166136261;
  for (let i = 0; i < tag.length; i++) seed = Math.imul(seed ^ tag.charCodeAt(i), 16777619);
  return {
    index,
    tag,
    get bytes() {
      const out = new Uint8Array(chunkSize);
      const words = new Uint32Array(out.buffer, 0, chunkSize >>> 2);
      let s = seed >>> 0;
      for (let i = 0; i < words.length; i++) {
        s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
        words[i] = s;
      }
      return out;
    }
  };
}

// -------------------------------------------------------------------- host

/**
 * A host that counts every request and every uploaded byte.
 *
 * Objects are stored by id. A caller may store a size-only stand-in, an object
 * with a numeric `length` and no bytes, when materialising the content would
 * cost memory without changing any count; whole-image does this, because 120
 * copies of a 64 MB disk is not something to hold in a Map to learn that
 * restoring one costs one request.
 */
export class CountingHost {
  static get capabilities() {
    return { orphanCommit: true, casRef: true, batchCommit: false, maxBodyBytes: 1e12 };
  }
  constructor() {
    this.objects = new Map();
    this.trees = new Map();
    this.commits = new Map();
    this.branches = new Map();
    this.requestCount = 0;
    this.uploadedBytes = 0;
    this.downloadedBytes = 0;
    this.storedBytes = 0;
    this.governor = null;
    this._n = 0;
  }
  async resolveRef(branch) {
    this.requestCount++;
    const head = this.branches.get(branch);
    return head ? { commit: head, tree: this.commits.get(head).tree } : null;
  }
  async readTree(tree) {
    this.requestCount++;
    return this.trees.get(tree).map((e) => ({ path: e.path, id: e.id, size: 0 }));
  }
  async readObject(id) {
    this.requestCount++;
    if (!this.objects.has(id)) throw new Error(`object ${id} missing`);
    const obj = this.objects.get(id);
    this.downloadedBytes += obj.length;
    return obj;
  }
  async commit({ branch, files, parent = null, orphan = false }) {
    let requests = 0;
    for (const f of files) {
      if (f.skipUpload) continue;
      if (!this.objects.has(f.id)) this.storedBytes += f.bytes.length;
      this.objects.set(f.id, f.bytes);
      this.uploadedBytes += f.bytes.length;
      requests++;
    }
    const tree = `t${++this._n}`;
    this.trees.set(tree, files.map((f) => ({ path: f.path, id: f.id })));
    const commit = `c${++this._n}`;
    this.commits.set(commit, { tree, parents: orphan || !parent ? [] : [parent] });
    const current = this.branches.get(branch) || null;
    if (!orphan && current !== parent) {
      const err = new Error("not a fast forward");
      err.status = 422;
      throw err;
    }
    this.branches.set(branch, commit);
    requests += 3;
    this.requestCount += requests;
    return { commit, requests };
  }
  /** What the repository holds, which is what the user pays to store. */
  storage() {
    return { objects: this.objects.size, bytes: this.storedBytes };
  }
}

// ------------------------------------------------------------------ shapes

/**
 * What every shape exposes. `applied(writes)` is called after the writes are
 * on the device; `sync()` commits; `restore()` reconstructs and reports what it
 * cost. Costs are read off the host, so no shape can flatter itself.
 */
class Shape {
  constructor({ host, diskSize, chunkSize, branch }) {
    this.host = host;
    this.diskSize = diskSize;
    this.chunkSize = chunkSize;
    this.branch = branch;
    this.device = new MemoryDevice({ diskSize });
    this.head = null;
    this.syncs = 0;
  }
  async apply(writes) {
    for (const w of writes) this.device.write(w.index * this.chunkSize, w.bytes);
    await this.device.flush();
  }
  /** Both costs read off the host, so a shape cannot report its own. */
  async measureRestore() {
    const r0 = this.host.requestCount, b0 = this.host.downloadedBytes;
    await this.restore();
    return {
      requests: this.host.requestCount - r0,
      bytes: this.host.downloadedBytes - b0
    };
  }
}

/**
 * Whole image: the disk, as one object, every sync.
 *
 * The blob is a size-only stand-in. Its id changes every sync because the
 * content does, so nothing deduplicates, which is the honest outcome for a
 * system that saves whole images.
 */
export class WholeImage extends Shape {
  async sync() {
    this.syncs++;
    // Stand-in with the disk's length and a per-sync id; see CountingHost.
    const image = { length: this.diskSize, sync: this.syncs };
    const files = [{ path: "disk.img", bytes: image, id: `img-${this.syncs}` }];
    const r = await this.host.commit({
      branch: this.branch, message: `image ${this.syncs}`, files, parent: this.head
    });
    this.head = r.commit;
    return r;
  }
  async restore() {
    const ref = await this.host.resolveRef(this.branch);
    const entries = await this.host.readTree(ref.tree);
    await this.host.readObject(entries[0].id);
  }
}

/**
 * Delta pack: one object per sync holding that sync's dirty chunks.
 *
 * Restore replays every pack in order onto a blank disk. That is the whole
 * point of the shape and also its cost: the number of objects to fetch is the
 * number of syncs since the base, however small the live set has stayed.
 */
export class DeltaPack extends Shape {
  constructor(opts) {
    super(opts);
    this.packs = [];          // ids, in order; the tree carries them too
  }
  async sync() {
    this.syncs++;
    const ranges = this.device.seal();
    const dirty = new Set(ranges.map((r) => Math.floor(r.offset / this.chunkSize)));
    // The pack: each dirty chunk in full, with its index, so replay knows where
    // it goes. Index as a 4-byte prefix per chunk.
    const parts = [];
    for (const index of [...dirty].sort((a, b) => a - b)) {
      const { offset, length } = chunkExtent(index, this.chunkSize, this.diskSize);
      const chunk = await this.device.readChunk(index, this.chunkSize);
      const header = new Uint8Array(4);
      new DataView(header.buffer).setUint32(0, index);
      parts.push(header, chunk.subarray(0, length));
    }
    const size = parts.reduce((n, p) => n + p.length, 0);
    const pack = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { pack.set(p, at); at += p.length; }

    const id = await blobId(pack);
    this.packs.push(id);
    // The tree names every pack, in order, so a restorer can find them all
    // from the head commit. Earlier packs are referenced, not re-uploaded.
    const files = this.packs.map((pid, i) => ({
      path: `packs/${String(i).padStart(6, "0")}`,
      bytes: pid === id ? pack : new Uint8Array(0),
      id: pid,
      skipUpload: pid !== id
    }));
    const r = await this.host.commit({
      branch: this.branch, message: `pack ${this.syncs}`, files, parent: this.head
    });
    this.head = r.commit;
    return r;
  }
  async restore() {
    const ref = await this.host.resolveRef(this.branch);
    const entries = await this.host.readTree(ref.tree);
    const disk = new Uint8Array(this.diskSize);
    for (const entry of entries.sort((a, b) => a.path.localeCompare(b.path))) {
      const pack = await this.host.readObject(entry.id);
      let at = 0;
      while (at < pack.length) {
        const index = new DataView(pack.buffer, pack.byteOffset + at).getUint32(0);
        const { offset, length } = chunkExtent(index, this.chunkSize, this.diskSize);
        disk.set(pack.subarray(at + 4, at + 4 + length), offset);
        at += 4 + length;
      }
    }
    this._restored = disk;
  }
}

/** Chunk exploded: the real engine, unchanged. */
export class ChunkExploded extends Shape {
  constructor(opts) {
    super(opts);
    this.machine = new Machine({
      host: this.host, device: this.device, branch: this.branch,
      governor: new Governor({ ratePerMin: 6e6, concurrency: 8 })
    });
  }
  async init() {
    await this.machine.load({
      diskSize: this.diskSize, chunkSize: this.chunkSize,
      base: "base.img", baseIsBlank: true
    });
  }
  async apply(writes) {
    // The machine flushes the device itself during sync; writes stay pending.
    for (const w of writes) this.device.write(w.index * this.chunkSize, w.bytes);
  }
  async sync() {
    this.syncs++;
    const r = await this.machine.sync({ message: `sync ${this.syncs}` });
    this.head = this.machine.head;
    return r;
  }
  async restore() {
    const r = await restore({ host: this.host, branch: this.branch });
    this._restored = r.disk;
  }
  get liveChunks() {
    return manifestModule.indices(this.machine.manifest).length;
  }
}

// --------------------------------------------------------------- the run

/**
 * Run one shape over the plan, measuring after every sync.
 *
 * Each shape gets its own host, so its counts are its own. The plan is shared,
 * so the writes are byte-identical across shapes.
 */
export async function run(ShapeClass, {
  plan, diskSize, chunkSize, onSync = () => {}, measureAt = null
}) {
  // Restore is measured after every sync unless told which syncs matter.
  // Storage and upload are always recorded: the host tracks them for free.
  const measure = measureAt ? new Set(measureAt) : null;
  const host = new CountingHost();
  const shape = new ShapeClass({ host, diskSize, chunkSize, branch: "m" });
  if (shape.init) await shape.init();

  const rows = [];
  for (const step of plan) {
    await shape.apply(step.writes);
    const r0 = host.requestCount, b0 = host.uploadedBytes;
    await shape.sync();
    const uploadRequests = host.requestCount - r0;
    const uploadBytes = host.uploadedBytes - b0;

    const restored = (!measure || measure.has(step.sync))
      ? await shape.measureRestore()
      : { requests: null, bytes: null };
    const storage = host.storage();

    const row = {
      sync: step.sync,
      uploadRequests, uploadBytes,
      restoreRequests: restored.requests, restoreBytes: restored.bytes,
      storageObjects: storage.objects, storageBytes: storage.bytes,
      liveChunks: shape.liveChunks !== undefined ? shape.liveChunks : null
    };
    rows.push(row);
    onSync(row);
  }
  return rows;
}

/**
 * Where restore is measured. The paper's six for a 120-sync run, and a spread
 * that still straddles the two halves for longer ones. Shared by every harness
 * so their tables line up sync for sync.
 */
export function checkpoints(syncs) {
  const mid = Math.floor(syncs / 2);
  const at = syncs <= 120
    ? [1, 10, 30, 60, 90, syncs]
    : [1, 10, Math.floor(mid / 5), mid, Math.floor(mid * 1.5), syncs];
  return [...new Set(at)].filter((n) => n >= 1 && n <= syncs).sort((a, b) => a - b);
}

/** Cumulative upload requests, which is what the rate limit meters. */
export function cumulative(rows, key) {
  let total = 0;
  return rows.map((r) => (total += r[key]));
}
