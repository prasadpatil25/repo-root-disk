// The sync engine: a machine's state, committed and restored.
//
// Implements the eight-phase protocol. Three of its steps exist because of
// something measured rather than something assumed, and each is marked below:
// the flush in P1, reading chunks through the device in P3, and restoring onto
// the base image rather than onto zeros.

import { blobId, objectPath, sha256Hex } from "./objectid.js";
import { dirtyChunks, chunkExtent, chunkCount } from "./chunker.js";
import * as manifestModule from "./manifest.js";
import { plaintextCipher } from "./crypto.js";
import { Governor } from "./governor.js";

export class ConflictError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ConflictError";
    Object.assign(this, details);
  }
}

export class Machine {
  /**
   * @param {Object} options
   * @param {import("../host/adapter.js").Host} options.host
   * @param {import("../device/memory.js").Device} options.device
   * @param {string} options.branch
   * @param {Object} [options.cipher] from deriveCipher(), or omitted for plaintext
   * @param {Governor} [options.governor]
   * @param {(event: Object) => void} [options.onEvent]
   */
  constructor({ host, device, branch, cipher, governor, onEvent }) {
    this.host = host;
    this.device = device;
    this.branch = branch;
    this.cipher = cipher || plaintextCipher;
    this.governor = governor || new Governor();
    this.onEvent = onEvent || (() => {});
    if (!host.governor) host.governor = this.governor;

    this.manifest = null;
    this.head = null;
    /** Whether load() found an existing machine, and whether it was put back. */
    this._attachedExisting = false;
    this._hydrated = false;
    /** Object ids the repository is known to hold, so P4 costs nothing. */
    this.known = new Set();
  }

  get chunkSize() { return this.manifest.chunkSize; }

  /**
   * Attach to an existing machine, or start a new one.
   * @returns {Promise<{existing: boolean}>}
   */
  async load({ diskSize, chunkSize, base, baseIsBlank, machineId } = {}) {
    const ref = await this.host.resolveRef(this.branch);
    if (!ref) {
      if (!diskSize || !chunkSize || !base) {
        throw new Error(
          `branch ${this.branch} does not exist; pass diskSize, chunkSize and base to create it`
        );
      }
      this.manifest = manifestModule.create({
        diskSize, chunkSize, base, baseIsBlank,
        encryption: this.cipher.saltHex ? { salt: this.cipher.saltHex } : null,
        machine: machineId || null
      });
      this.head = null;
      return { existing: false };
    }

    this.head = ref.commit;
    const entries = await this.host.readTree(ref.tree);
    const manifestEntry = entries.find((e) => e.path === manifestModule.MANIFEST_PATH);
    if (!manifestEntry) throw new Error(`commit ${ref.commit} has no manifest`);
    this._manifestObjectId = manifestEntry.id;
    this.manifest = manifestModule.parse(await this.host.readObject(manifestEntry.id));

    // Attaching to an existing machine takes its geometry from the manifest and
    // ignores whatever the caller asked for, so a device built to a different
    // size is a silent corruption: chunks would be hashed from the wrong extent,
    // and reads past the smaller device would be clamped or refused. Refuse the
    // attach instead, and say what the machine actually is.
    if (this.device && this.device.diskSize !== this.manifest.diskSize) {
      throw new Error(
        `${this.branch} is a ${fmtMb(this.manifest.diskSize)} machine with ` +
        `${fmtKb(this.manifest.chunkSize)} chunks, but the device given to it is ` +
        `${fmtMb(this.device.diskSize)}. Attach a device built to the machine's own ` +
        `geometry; the manifest is the authority once a branch exists.`
      );
    }

    // Everything reachable from this commit is already in the repository, which
    // is the whole of the dedup probe: no round trip needed to know it.
    for (const entry of entries) this.known.add(entry.id);
    this._attachedExisting = true;
    return { existing: true, chunks: manifestModule.indices(this.manifest).length };
  }

  /**
   * Put the machine's state back onto the device.
   *
   * Attaching to a branch reads its manifest; it does not touch the disk. A
   * device created from the base image is therefore blank, and a guest booted
   * against it sees an empty machine no matter what the repository holds. This
   * is the step that makes a reboot show the user's files.
   *
   * Only the chunks the manifest names are fetched. Everything else already
   * comes from the base image the device reads through, so a machine that has
   * written 1 MB costs 1 MB to put back, not the size of the disk.
   *
   * Must run before capture is armed. It writes through writeRaw for that
   * reason: hydration is not the guest's work and must never be re-uploaded.
   */
  async hydrate({ onProgress = () => {} } = {}) {
    if (!this.manifest) throw new Error("load() before hydrate()");
    if (typeof this.device.writeRaw !== "function") {
      throw new Error(
        "this device cannot be hydrated: it has no writeRaw. Without it a machine " +
        "can be committed but never put back."
      );
    }

    const indices = manifestModule.indices(this.manifest);
    let applied = 0;
    for (const index of indices) {
      const id = this.manifest.chunks[String(index)];
      const stored = await this.host.readObject(id);
      await verifyChunk(stored, this.manifest, index, id);
      const plaintext = await this.cipher.decrypt(stored);
      const { offset, length } = chunkExtent(index, this.chunkSize, this.manifest.diskSize);
      await this.device.writeRaw(offset, plaintext.subarray(0, length));
      applied++;
      onProgress({ applied, total: indices.length });
    }

    this._hydrated = true;
    this.onEvent({ type: "hydrated", chunks: applied });
    return { chunks: applied };
  }

  /**
   * Declare the device already carries this machine's state, for a caller that
   * built the disk itself rather than hydrating in place.
   */
  markHydrated() { this._hydrated = true; }

  /**
   * Name the machine's current state so it can be booted later by that name.
   *
   * This needs nothing from the sync protocol. A commit already describes the
   * whole disk, so a snapshot is a reference that never moves, and it costs one
   * request and no storage. What it buys is the difference between "the machine
   * as it was for the experiment in Section V" being a sentence and being
   * something a reader can boot.
   */
  /**
   * The SHA-256 digest of this machine's committed manifest.
   *
   * Recorded out of band, it is a root of trust that does not run through a
   * SHA-1 object: restore checks the manifest against it, and the manifest
   * carries a digest for every chunk. It also pins freshness, since an older
   * commit carries an older manifest and so a different digest.
   */
  get manifestDigest() { return this._manifestDigest || null; }

  async snapshot(name) {
    if (!this.head) {
      throw new Error(
        `${this.branch} has no commit to name yet. Sync first; a snapshot points ` +
        `at a state, and this machine does not have one in the repository.`
      );
    }
    if (typeof this.host.createRef !== "function") {
      throw new Error("this host cannot create a reference, so it cannot name a state");
    }
    if (!/^[A-Za-z0-9._-]+$/.test(name || "")) {
      throw new Error(`"${name}" is not usable as a reference name`);
    }
    const ref = await this.host.createRef(`refs/tags/${name}`, this.head);
    this.onEvent({ type: "snapshot", name, commit: this.head });
    // The digest travels with the name because a name alone is only as
    // trustworthy as the host resolving it.
    return { name, commit: this.head, ref, manifestDigest: this.manifestDigest };
  }

  /**
   * One sync. Returns what it cost, which is the shape the evaluation reports.
   */
  async sync({ message, retryOnConflict = true } = {}) {
    const started = Date.now();
    const requestsBefore = this.host.requestCount;

    // Committing from a device that was never hydrated would write blank-derived
    // chunks over a real machine, while the manifest kept the old ids for every
    // untouched index. The result restores as a mix of two disks, so refuse.
    if (this._attachedExisting && !this._hydrated) {
      throw new Error(
        `${this.branch} holds a machine that has not been put back onto this device. ` +
        `Call hydrate() before syncing, or markHydrated() if the device was built ` +
        `from that state already. Syncing now would commit a blank disk over it.`
      );
    }

    // P1 Quiesce. The flush is not hygiene. A guest that has written a file but
    // not flushed has produced zero disk writes, so sealing first would commit a
    // machine missing the user's most recent work.
    await this.device.flush();
    const sealed = this.device.seal();

    // P2 Snapshot, P3 chunk and hash.
    const indices = dirtyChunks(sealed, this.chunkSize, this.manifest.diskSize);

    // A machine that has never been committed must be written out even with
    // nothing dirty. load() creates the manifest in memory only, so until this
    // commit lands the branch does not exist, and the disk geometry, the base
    // image and the encryption salt live nowhere but this tab. Skipping here
    // would lose a machine the user was told they had.
    const establishing = this.head === null;

    if (indices.length === 0 && !establishing) {
      this.onEvent({ type: "sync-skipped", reason: "nothing dirty" });
      return {
        commit: this.head, chunks: 0, uploaded: 0, reused: 0,
        requests: 0, bytesUploaded: 0, seconds: 0, skipped: true
      };
    }

    const prepared = [];
    for (const index of indices) {
      // P3: read through the device so the base image is merged in. A local
      // shadow initialised to zeros is correct only for a blank base.
      const plaintext = await this.device.readChunk(index, this.chunkSize);
      const stored = await this.cipher.encrypt(plaintext);
      // The git object id addresses the chunk; the digest is what proves the
      // bytes at that address are the ones we put there.
      prepared.push({
        index,
        bytes: stored,
        id: await blobId(stored),
        digest: await sha256Hex(stored)
      });
    }

    // P4 Dedup probe, entirely local.
    const fresh = [];
    const seenThisSync = new Set();
    let reused = 0;
    for (const chunk of prepared) {
      if (this.known.has(chunk.id) || seenThisSync.has(chunk.id)) { reused++; continue; }
      seenThisSync.add(chunk.id);
      fresh.push(chunk);
    }

    const result = await this._commit({
      fresh, prepared,
      message: message || (establishing && indices.length === 0
        ? `create machine on ${this.branch}`
        : `sync ${this.manifest.sync + 1}: ${indices.length} chunks`),
      retryOnConflict
    });

    const bytesUploaded = fresh.reduce((sum, c) => sum + c.bytes.length, 0);
    return {
      commit: result.commit,
      chunks: indices.length,
      uploaded: fresh.length,
      reused,
      bytesUploaded,
      requests: this.host.requestCount - requestsBefore,
      seconds: (Date.now() - started) / 1000,
      skipped: false
    };
  }

  async _commit({ fresh, prepared, message, retryOnConflict }) {
    // The manifest is cumulative: every chunk the disk needs, not only this
    // epoch's. That is what keeps restore cost constant in machine age.
    const next = { ...this.manifest, chunks: { ...this.manifest.chunks } };
    next.digests = { ...(this.manifest.digests || {}) };
    for (const chunk of prepared) {
      next.chunks[String(chunk.index)] = chunk.id;
      next.digests[String(chunk.index)] = chunk.digest;
    }
    next.sync = this.manifest.sync + 1;

    const manifestBytes = manifestModule.serialize(next);
    // Digested here because this is the only place the exact committed bytes
    // exist. Recomputing it later would mean fetching the object back and
    // trusting the address we fetched it by, which is the thing being avoided.
    const manifestDigest = await sha256Hex(manifestBytes);
    const files = fresh.map((chunk) => ({
      path: objectPath(chunk.id), bytes: chunk.bytes, id: chunk.id
    }));
    // Objects already in the repository still belong in the tree, referenced
    // rather than re-uploaded.
    for (const id of new Set(Object.values(next.chunks))) {
      if (!fresh.some((c) => c.id === id)) {
        files.push({ path: objectPath(id), bytes: new Uint8Array(0), id, skipUpload: true });
      }
    }
    files.push({
      path: manifestModule.MANIFEST_PATH,
      bytes: manifestBytes,
      id: await blobId(manifestBytes),
      replaces: this._manifestObjectId
    });

    try {
      // P5, P6, P7 all happen inside the host adapter, because how they divide
      // is the one thing that differs between hosts.
      const committed = await this.host.commit({
        branch: this.branch, message, files,
        parent: this.head, branchExists: this.head !== null
      });

      // P8 Prune.
      this.manifest = next;
      this.head = committed.commit;
      this._manifestObjectId = files[files.length - 1].id;
      // Only after the commit succeeded. A digest for a manifest the host
      // rejected would name a state that does not exist.
      this._manifestDigest = manifestDigest;
      for (const chunk of fresh) this.known.add(chunk.id);
      this.known.add(this._manifestObjectId);
      return committed;
    } catch (err) {
      const lost = err.status === 422 || /not a fast forward/i.test(err.message || "");
      if (!lost || !retryOnConflict) throw err;
      return this._resolveConflict({ fresh, prepared, message });
    }
  }

  /**
   * Another writer moved the reference first. If the two epochs touched
   * disjoint chunks the histories can be combined; if they overlap they cannot,
   * because two divergent filesystem states do not merge.
   */
  async _resolveConflict({ fresh, prepared, message }) {
    this.onEvent({ type: "conflict-detected", branch: this.branch });

    const previous = this.manifest;
    const ours = new Set(prepared.map((c) => String(c.index)));
    await this.load();
    const theirs = this.manifest;

    const changedByThem = new Set(
      Object.keys(theirs.chunks).filter((i) => theirs.chunks[i] !== previous.chunks[i])
    );
    const overlap = [...ours].filter((i) => changedByThem.has(i));

    if (overlap.length > 0) {
      throw new ConflictError(
        `another writer changed ${overlap.length} of the same chunks; ` +
        `these states cannot be merged, fork to a new branch instead`,
        { branch: this.branch, overlappingChunks: overlap.map(Number), head: this.head }
      );
    }

    this.onEvent({ type: "conflict-rebased", disjointChunks: ours.size });
    return this._commit({ fresh, prepared, message, retryOnConflict: false });
  }

  /**
   * Re-baseline: snapshot the whole disk into one commit and drop history.
   *
   * Cost is content, not disk size. A 94%-full 256 MB machine snapshots to 941
   * distinct objects, and at the enforced write rate that is minutes rather than
   * seconds, so this is the one operation a rate limit actually bounds. It is
   * also read bound rather than write bound: reading the disk back is the slow
   * part, and it gets faster as the disk fills, because written chunks are
   * already local while unwritten ones must be fetched from the base.
   */
  async compact({ message } = {}) {
    const caps = this.host.constructor.capabilities;
    if (!caps.orphanCommit) {
      throw new Error(
        `${this.host.constructor.name} cannot create a parentless commit, so history ` +
        `cannot be dropped atomically. Delete and recreate the branch instead.`
      );
    }

    const started = Date.now();
    const requestsBefore = this.host.requestCount;
    await this.device.flush();
    this.device.seal();

    const total = chunkCount(this.manifest.diskSize, this.chunkSize);
    const chunks = {};
    const byId = new Map();
    for (let index = 0; index < total; index++) {
      const plaintext = await this.device.readChunk(index, this.chunkSize);
      const stored = await this.cipher.encrypt(plaintext);
      const id = await blobId(stored);
      chunks[String(index)] = id;
      if (!byId.has(id)) byId.set(id, stored);
    }
    const readSeconds = (Date.now() - started) / 1000;

    const next = { ...this.manifest, chunks, sync: this.manifest.sync + 1, compacted: true };
    const manifestBytes = manifestModule.serialize(next);

    const files = [...byId.entries()].map(([id, bytes]) => ({
      path: objectPath(id), bytes, id, skipUpload: this.known.has(id)
    }));
    files.push({
      path: manifestModule.MANIFEST_PATH,
      bytes: manifestBytes,
      id: await blobId(manifestBytes)
    });

    // What compaction actually reclaims is objects the old history referenced
    // and the new commit does not: superseded chunk versions and every manifest
    // written along the way. A size difference would undercount, because the
    // snapshot also introduces objects that were never separately known.
    const nowUnreachable = [...this.known].filter((id) => !byId.has(id));
    const committed = await this.host.commit({
      branch: this.branch, message: message || `compaction: ${total} chunks, history dropped`,
      files, parent: null, orphan: true, branchExists: this.head !== null
    });

    this.manifest = next;
    this.head = committed.commit;
    this._manifestObjectId = files[files.length - 1].id;
    this.known = new Set(byId.keys());

    return {
      commit: committed.commit,
      chunksRead: total,
      distinctObjects: byId.size,
      uploaded: files.filter((f) => !f.skipUpload).length,
      storedBytes: [...byId.values()].reduce((s, b) => s + b.length, 0),
      unreachableAfter: nowUnreachable.length,
      readSeconds,
      requests: this.host.requestCount - requestsBefore,
      seconds: (Date.now() - started) / 1000
    };
  }

  stats() {
    return manifestModule.stats(this.manifest);
  }
}

/**
 * Rebuild a disk from a commit alone.
 *
 * Restoration is base plus written chunks, never blank plus written chunks. The
 * distinction is invisible while the base image is empty and silently corrupts
 * the disk once it is not.
 *
 * @param {Object} options
 * @param {import("../host/adapter.js").Host} options.host
 * @param {string} options.branch
 * @param {Object} [options.cipher]
 * @param {(url: string) => Promise<Uint8Array>} [options.fetchBase] how to load the base image
 * @param {(id: string) => Promise<Uint8Array|null>} [options.cdn] optional fast path for objects
 */
export async function restore({
  host, branch, commit, tree, cipher = plaintextCipher, fetchBase, cdn,
  manifestDigest = null, onEvent = () => {}
}) {
  // A branch names the newest state; a commit names any of them. Bisect needs
  // the second, and it is the same work once the tree is known.
  let ref;
  if (commit) {
    ref = { commit, tree: tree || (await host.readCommit(commit)).tree };
  } else {
    ref = await host.resolveRef(branch);
    if (!ref) throw new Error(`branch ${branch} does not exist`);
  }

  const entries = await host.readTree(ref.tree);
  const manifestEntry = entries.find((e) => e.path === manifestModule.MANIFEST_PATH);
  if (!manifestEntry) throw new Error(`commit ${ref.commit} has no manifest`);
  const manifestObject = await host.readObject(manifestEntry.id);
  if (manifestDigest) {
    // The one check that does not run through a SHA-1 address. Everything below
    // it is verified against digests this manifest carries, so if the manifest
    // is the one the user pinned, the whole restore is SHA-256 rooted. It also
    // refuses a stale state: an older commit carries an older manifest.
    const actual = await sha256Hex(manifestObject);
    if (actual !== manifestDigest) {
      throw new Error(
        `the manifest at ${ref.commit} digests to ${actual}, not the pinned ` +
        `${manifestDigest}. This is either a different state than the one pinned ` +
        `or a substituted one; nothing has been written to the disk.`
      );
    }
  }
  const manifest = manifestModule.parse(manifestObject);

  const disk = await loadBase(manifest, fetchBase, onEvent);

  let fromCdn = 0, fromApi = 0;
  const indices = manifestModule.indices(manifest);
  for (const index of indices) {
    const id = manifest.chunks[String(index)];
    let stored = null;
    if (cdn) {
      // Read-your-writes: the CDN can lag a commit it has not seen, so a miss
      // falls back to the object API rather than failing the boot.
      try { stored = await cdn(id); } catch { stored = null; }
      if (stored) fromCdn++;
    }
    if (!stored) { stored = await host.readObject(id); fromApi++; }
    await verifyChunk(stored, manifest, index, id);
    const plaintext = await cipher.decrypt(stored);
    const { offset } = chunkExtent(index, manifest.chunkSize, manifest.diskSize);
    disk.set(plaintext, offset);
  }

  return {
    manifest,
    disk,
    commit: ref.commit,
    chunksApplied: indices.length,
    fromCdn,
    fromApi
  };
}

/**
 * Check a chunk against the digest the manifest recorded for it.
 *
 * Silent on a manifest that has no digest for this chunk, because one written
 * before digests existed is still readable and refusing it would strand those
 * machines. A caller that needs the guarantee asks verifiable() first.
 */
async function verifyChunk(stored, manifest, index, id) {
  const expected = (manifest.digests || {})[String(index)];
  if (!expected) return;
  const actual = await sha256Hex(stored);
  if (actual !== expected) {
    throw new Error(
      `chunk ${index} does not match the digest recorded for it. The object at ` +
      `${id} is ${actual.slice(0, 12)} where the manifest expects ` +
      `${expected.slice(0, 12)}. Object ids are git SHA-1, so a collision or a ` +
      `rewritten object reaches this point; the disk was not modified.`
    );
  }
}

function fmtMb(bytes) {
  const mb = bytes / 1048576;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

function fmtKb(bytes) {
  return `${Math.round(bytes / 1024)} KB`;
}

async function loadBase(manifest, fetchBase, onEvent) {
  if (manifest.baseIsBlank) {
    onEvent({ type: "base-blank" });
    return new Uint8Array(manifest.diskSize);
  }
  if (!fetchBase) {
    throw new Error(
      `manifest declares a non-blank base (${manifest.base}) but no fetchBase was ` +
      `provided. Restoring onto zeros would corrupt the disk.`
    );
  }
  onEvent({ type: "base-loading", url: manifest.base });
  const bytes = await fetchBase(manifest.base);
  const disk = new Uint8Array(manifest.diskSize);
  disk.set(bytes.subarray(0, Math.min(bytes.length, manifest.diskSize)));
  onEvent({ type: "base-loaded", bytes: bytes.length });
  return disk;
}
