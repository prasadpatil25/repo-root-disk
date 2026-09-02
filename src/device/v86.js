// The Device contract, implemented against a v86 emulator.
//
// v86 needs no modification. Its public configuration exposes no hook for a
// custom buffer, but the constructed device is reachable and the IDE write path
// funnels through a single buffer.set(offset, data, callback). Wrapping that one
// method captures every write, on both the in-memory buffer and the streamed
// one, with no other changes.
//
// The path is ide.primary.master.buffer. There is no ide.master: the controller
// holds primary and secondary channels, each with a master and a slave.
//
// This wrapper records byte ranges, not payloads. The sync engine reads chunk
// contents back through the device when it needs them, so keeping copies of
// every write would duplicate the disk in the tab for no benefit. Filling a
// 256 MB disk moves hundreds of megabytes through this path; the range log for
// it is a few kilobytes.

const ALIGNMENT = 256; // the async buffer asserts 256-byte alignment on get and set

/** Candidate paths, most likely first. Confirmed by walking a live emulator. */
const BUFFER_PATHS = [
  "v86.cpu.devices.ide.primary.master.buffer",
  "v86.cpu.devices.ide.primary.slave.buffer",
  "v86.cpu.devices.ide.secondary.master.buffer"
];

export class V86Device {
  /**
   * @param {Object} options
   * @param {Object} options.emulator a started V86 instance
   * @param {number} options.diskSize
   * @param {() => Promise<void>} options.flush how to make the guest write out its cache
   * @param {(event: Object) => void} [options.onEvent]
   */
  constructor({ emulator, diskSize, flush, onEvent }) {
    if (!emulator) throw new Error("an emulator is required");
    if (!Number.isInteger(diskSize) || diskSize <= 0) throw new RangeError("diskSize");
    if (diskSize % ALIGNMENT !== 0) {
      throw new RangeError(
        `diskSize must be a multiple of ${ALIGNMENT}; v86's streamed buffer asserts that alignment`
      );
    }
    if (typeof flush !== "function") {
      throw new Error(
        "a flush strategy is required. A guest that has written a file but not " +
        "flushed has produced no disk writes at all, so syncing without one commits " +
        "a machine missing the user's most recent work. Use serialFlush() or supply " +
        "one suited to the guest."
      );
    }

    this.emulator = emulator;
    this.diskSize = diskSize;
    this._flush = flush;
    this.onEvent = onEvent || (() => {});

    this.buffer = null;
    this.bufferPath = null;
    this.streamed = false;
    this._original = null;
    this._epoch = [];
    this.capturing = false;
    this.stats = { writes: 0, bytes: 0, flushes: 0 };
  }

  /**
   * Find and wrap the block device. Safe to call repeatedly; the device only
   * appears once the emulator has finished starting.
   * @returns {boolean} whether the device is now wrapped
   */
  attach() {
    if (this.buffer) return true;

    let found = null;
    for (const path of BUFFER_PATHS) {
      const candidate = resolve(this.emulator, path);
      if (isBlockBuffer(candidate)) { found = { buffer: candidate, path }; break; }
    }
    if (!found) found = search(this.emulator);
    if (!found) return false;

    const buffer = found.buffer;
    if (buffer.__machineDevice) {
      this.buffer = buffer;
      this.bufferPath = found.path;
      return true;
    }

    const original = buffer.set.bind(buffer);
    buffer.set = (offset, data, callback) => {
      if (this.capturing) this._record(offset, data.length);
      return original(offset, data, callback);
    };
    buffer.__machineDevice = true;

    this.buffer = buffer;
    this.bufferPath = found.path;
    this._original = original;
    this.streamed = !!buffer.block_cache;
    this.onEvent({ type: "attached", path: found.path, streamed: this.streamed });
    return true;
  }

  /** Wait for the emulator to construct its device, then wrap it. */
  async waitForDevice(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.attach()) return;
      if (Date.now() > deadline) {
        throw new Error(
          `no block device appeared within ${timeoutMs}ms. Was the emulator started ` +
          `with an hda image?`
        );
      }
      await sleep(100);
    }
  }

  detach() {
    if (this.buffer && this._original) {
      this.buffer.set = this._original;
      delete this.buffer.__machineDevice;
    }
    this.buffer = null;
    this._original = null;
  }

  /** Begin recording. Boot writes nothing to disk, so start before the guest does. */
  start() { this.capturing = true; }
  stop() { this.capturing = false; }

  _record(offset, length) {
    if (length <= 0) return;
    this.stats.writes++;
    this.stats.bytes += length;
    // Coalesce against the previous range when they touch. Captured writes
    // arrive as wide transfers rather than sectors, averaging about 79 KB, and
    // consecutive ones are frequently adjacent.
    const last = this._epoch[this._epoch.length - 1];
    if (last && offset <= last.offset + last.length && offset >= last.offset) {
      last.length = Math.max(last.length, offset + length - last.offset);
      return;
    }
    this._epoch.push({ offset, length });
  }

  async flush() {
    this.stats.flushes++;
    await this._flush();
  }

  seal() {
    const sealed = this._epoch;
    this._epoch = [];
    return sealed;
  }

  pending() {
    return this._epoch.map((r) => ({ ...r }));
  }

  /**
   * Write bytes to the device without recording them.
   *
   * This is how a machine is put back onto a disk before the guest runs. It must
   * bypass capture: hydration is not the guest's work, and recording it would
   * mark the entire restored disk dirty and re-upload it on the next sync.
   */
  writeRaw(offset, bytes) {
    if (!this.buffer) throw new Error("device is not attached");
    if (offset % ALIGNMENT !== 0) {
      throw new RangeError(`offset must be a multiple of ${ALIGNMENT}`);
    }
    if (offset + bytes.length > this.diskSize) {
      throw new RangeError("write runs past the device end");
    }
    // Prefer the unwrapped setter. Suppressing capture as well covers the case
    // where this wrapper attached to a buffer another wrapper had already wound.
    const write = this._original || this.buffer.set.bind(this.buffer);
    const wasCapturing = this.capturing;
    this.capturing = false;
    return new Promise((resolve_, reject) => {
      let settled = false;
      try {
        write(offset, bytes, () => {
          if (settled) return;
          settled = true;
          this.capturing = wasCapturing;
          resolve_();
        });
      } catch (err) {
        this.capturing = wasCapturing;
        if (!settled) { settled = true; reject(err); }
      }
    });
  }

  /**
   * Read a chunk back through the device, which merges the read-only base image
   * with everything written on top of it.
   */
  readChunk(index, chunkSize) {
    if (!this.buffer) throw new Error("device is not attached");
    if (chunkSize % ALIGNMENT !== 0) {
      throw new RangeError(`chunkSize must be a multiple of ${ALIGNMENT}`);
    }
    const offset = index * chunkSize;
    if (offset >= this.diskSize) throw new RangeError(`chunk ${index} is past the device end`);
    const length = Math.min(chunkSize, this.diskSize - offset);

    return new Promise((resolve_, reject) => {
      let settled = false;
      try {
        this.buffer.get(offset, length, (data) => {
          if (settled) return;
          settled = true;
          // Copy: the emulator may hand back a view onto memory it reuses.
          resolve_(new Uint8Array(data));
        });
      } catch (err) {
        if (!settled) { settled = true; reject(err); }
      }
    });
  }
}

/**
 * Flush by asking the guest to do it over the serial console.
 *
 * This is the strategy that works for a Linux guest sitting at a shell. It is
 * separate from the device because how a guest is made to flush depends
 * entirely on what the guest is.
 *
 * @param {Object} emulator
 * @param {Object} [options]
 * @param {string} [options.command] defaults to "sync"
 * @param {RegExp} [options.prompt] shells vary; Buildroot prompts with "~%"
 * @param {number} [options.timeoutMs]
 */
export function serialFlush(emulator, { command = "sync", prompt = /[#$%>]\s*$/, timeoutMs = 60000 } = {}) {
  let tail = "";
  emulator.add_listener("serial0-output-byte", (byte) => {
    // Strip escapes before matching. A guest that colours its prompt sends
    // ESC[1;32m~%ESC[m, which ends in "m " rather than in the prompt character,
    // so a raw match would never fire and every sync would fail the flush.
    tail = stripEscapes(tail + String.fromCharCode(byte)).slice(-400);
  });

  return async function flush() {
    tail = "";
    // Ask for the exit status rather than watching for a prompt. Spotting a
    // prompt is a guess about what the guest's output means, and this is the one
    // call where guessing wrong loses the user's work: a flush that reports
    // success without flushing commits a machine missing its most recent writes,
    // and one that never returns hangs the sync. The marker cannot appear in the
    // command that produces it, so neither failure is possible.
    emulator.serial0_send(`${command}; echo flushed=$?\n`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = tail.match(/flushed=(\d+)/);
      if (status) {
        if (status[1] !== "0") {
          throw new Error(
            `"${command}" failed in the guest with status ${status[1]}. Syncing now ` +
            `would commit a machine whose most recent writes are still in page cache.`
          );
        }
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `"${command}" did not report back within ${timeoutMs}ms. Syncing now would ` +
          `commit a machine missing unflushed writes.`
        );
      }
      await sleep(120);
    }
  };
}

// --- internals ---------------------------------------------------------------

function resolve(root, path) {
  let node = root;
  for (const key of path.split(".")) {
    if (node === null || node === undefined) return null;
    try { node = node[key]; } catch { return null; }
  }
  return node;
}

function isBlockBuffer(o) {
  return !!o && typeof o === "object" &&
    typeof o.get === "function" && typeof o.set === "function" &&
    typeof o.load === "function";
}

/**
 * Fall back to searching the object graph. Collects every match rather than
 * taking the first, because the sound card also owns a buffer of this shape and
 * a breadth-first search reaches it early. Wrapping that would capture nothing.
 */
function search(root, maxDepth = 6) {
  const seen = new Set();
  const queue = [{ node: root, path: "emulator", depth: 0 }];
  const hits = [];
  let visited = 0;

  while (queue.length && visited < 6000) {
    const { node, path, depth } = queue.shift();
    if (!node || typeof node !== "object") continue;
    if (node instanceof ArrayBuffer || ArrayBuffer.isView(node)) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    visited++;

    if (isBlockBuffer(node)) { hits.push({ buffer: node, path }); continue; }
    if (depth >= maxDepth) continue;
    let keys;
    try { keys = Object.keys(node); } catch { continue; }
    for (const key of keys.slice(0, 300)) {
      try { queue.push({ node: node[key], path: `${path}.${key}`, depth: depth + 1 }); } catch { /* getter threw */ }
    }
  }

  return hits.find((h) => h.path.includes(".ide.")) || null;
}

/**
 * Remove terminal escape sequences and control bytes, leaving the text a reader
 * would see. Only complete sequences are removed, so a sequence still arriving
 * byte by byte is left alone until its final byte lands.
 *
 * Whitespace is kept: prompt patterns end in \s*$ and need it.
 */
function stripEscapes(text) {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")            // CSI, including colour
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")  // OSC, such as a title
    // Charset designators and the other short forms. The lookahead matters: an
    // ESC still waiting for the rest of its CSI would otherwise be eaten here,
    // leaving the parameters behind as text.
    .replace(/\x1b(?![[\]])[ -/]*[0-~]/g, "")
    // Controls, keeping \t \n \r. ESC is kept too: this runs byte by byte, and
    // deleting a lone ESC would break up the sequence still arriving behind it,
    // leaving its parameters as text. An incomplete sequence is removed on the
    // pass after its final byte lands.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, "");
}

function sleep(ms) {
  return new Promise((resolve_) => setTimeout(resolve_, ms));
}
