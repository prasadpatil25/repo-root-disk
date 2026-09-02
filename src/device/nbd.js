// A device backed by a real kernel block device, over NBD.
//
// This is the same sync engine driving /dev/nbd0 instead of an emulator. The
// point is not that Linux is a better guest than v86; it is that the Device
// contract is five members wide, and nothing above it knows what a browser is.
// Three implementations of that contract, one of them a real kernel, is a
// stronger generality claim than a second emulator would have been.
//
// One finding came out of writing it and belongs in the paper. The flush
// requirement is not an emulator quirk. A kernel holds writes in its page cache
// exactly as v86 does, and this device cannot make it let go: NBD gives the
// server no way to ask. So flush() has to reach outside the protocol, ask the
// operating system to sync, and then wait for the kernel's own flush command to
// arrive. The awkwardness is the same awkwardness as in the browser, which is
// evidence that it is inherent to writing back a block device rather than
// something we imposed.

import { chunkExtent } from "../core/chunker.js";
import { CMD, ERR, FLAG, OPT, exportReply, greeting, parseOption, parseRequest, reply, validate }
  from "./nbd-protocol.js";

const FLUSH_TIMEOUT_MS = 15000;

export class NbdDevice {
  /**
   * @param {Object} options
   * @param {number} options.diskSize
   * @param {Uint8Array} [options.base] starting contents; absent means zeros
   * @param {() => Promise<void>} [options.requestFlush]
   *   Ask the operating system to write its cache out, typically by running
   *   sync(1) against the mount. Without it flush() cannot be honest, so it
   *   refuses rather than returning a half-written disk.
   * @param {(range: {offset: number, length: number}) => void} [options.onDiscard]
   */
  constructor({ diskSize, base = null, requestFlush = null, onDiscard = null }) {
    this.diskSize = diskSize;
    this._bytes = new Uint8Array(diskSize);
    if (base) this._bytes.set(base.subarray(0, Math.min(base.length, diskSize)));
    this._epoch = [];
    this._discarded = [];
    this._flushes = 0;
    this._requestFlush = requestFlush;
    this._onDiscard = onDiscard;
    this._waiters = [];
  }

  // ----------------------------------------------------------- Device contract

  /**
   * Make the kernel write out its cache, then wait until it has.
   *
   * Syncing is asynchronous: sync(1) returning means the kernel has issued the
   * writes, and they reach us as ordinary NBD writes followed by a flush.
   * Waiting for that flush is what makes the epoch complete. Returning early
   * here is the same failure the browser implementation had, and it loses the
   * user's most recent work at every sync rather than failing loudly.
   */
  async flush({ timeoutMs = FLUSH_TIMEOUT_MS } = {}) {
    if (!this._requestFlush) {
      throw new Error(
        "no way to make the kernel flush: pass requestFlush, or the sync will " +
        "commit a disk missing whatever is still in the page cache"
      );
    }
    const before = this._flushes;
    const arrived = this._awaitFlush(before, timeoutMs);
    await this._requestFlush();
    await arrived;
  }

  seal() {
    const sealed = this._epoch;
    this._epoch = [];
    return sealed;
  }

  pending() {
    return [...this._epoch];
  }

  async readChunk(index, chunkSize) {
    const { offset, length } = chunkExtent(index, chunkSize, this.diskSize);
    return this._bytes.slice(offset, offset + length);
  }

  /** Hydration, which is not the guest's work and must not enter the epoch. */
  async writeRaw(offset, bytes) {
    if (offset < 0 || offset + bytes.length > this.diskSize) {
      throw new RangeError("write runs past the device end");
    }
    this._bytes.set(bytes, offset);
  }

  // ----------------------------------------------------------------- NBD side

  /**
   * Answer one request. Separated from the socket so the whole command set is
   * testable without a kernel; the server below is only framing around this.
   */
  async handle(request) {
    const error = validate(request, this.diskSize);
    if (error !== ERR.NONE) return { error, data: null, disconnect: false };

    switch (request.type) {
      case CMD.READ:
        return {
          error: ERR.NONE,
          data: this._bytes.slice(request.offset, request.offset + request.length),
          disconnect: false
        };

      case CMD.WRITE:
        this._bytes.set(request.data, request.offset);
        this._epoch.push({ offset: request.offset, length: request.length });
        return { error: ERR.NONE, data: null, disconnect: false };

      case CMD.FLUSH:
        this._flushes++;
        this._wake();
        return { error: ERR.NONE, data: null, disconnect: false };

      case CMD.TRIM: {
        // What the browser device cannot see. The kernel is telling us these
        // blocks are free, which is the only way a version-controlled disk could
        // forget anything: without it, a secret written once stays legible in
        // the commit that carried it. Recorded, not yet acted on. Dropping
        // chunks from past commits means rewriting history, and that trade is
        // discussed in the paper rather than decided here.
        const range = { offset: request.offset, length: request.length };
        this._discarded.push(range);
        if (this._onDiscard) this._onDiscard(range);
        return { error: ERR.NONE, data: null, disconnect: false };
      }

      case CMD.DISCONNECT:
        return { error: ERR.NONE, data: null, disconnect: true };

      default:
        return { error: ERR.INVALID, data: null, disconnect: false };
    }
  }

  /**
   * Serve one client on a duplex stream. Takes any socket-like object, which is
   * what lets the tests speak the client half in-process.
   */
  serve(socket, { onError = () => {} } = {}) {
    let buffer = Buffer.alloc(0);
    let negotiated = false;
    let busy = Promise.resolve();

    let clientFlags = null;

    const drain = async () => {
      for (;;) {
        if (!negotiated) {
          // Four client flags precede the first option. Among them is whether
          // the client wants the 124 legacy pad bytes omitted, and the answer
          // has to be honoured rather than assumed: guessing wrong desynchronises
          // the stream by exactly 124 bytes and every later request is garbage.
          if (clientFlags === null) {
            if (buffer.length < 4) return;
            clientFlags = buffer.readUInt32BE(0);
            buffer = buffer.subarray(4);
          }
          const option = parseOption(buffer);
          if (!option) return;
          buffer = buffer.subarray(option.consumed);
          if (option.option !== OPT.EXPORT_NAME) {
            socket.end();
            return;
          }
          socket.write(exportReply(this.diskSize, {
            noZeroes: (clientFlags & FLAG.NO_ZEROES) !== 0
          }));
          negotiated = true;
          continue;
        }

        const request = parseRequest(buffer);
        if (!request) return;
        buffer = buffer.subarray(request.consumed);

        const result = await this.handle(request);
        socket.write(reply(request.handle, result.error));
        if (result.data && result.error === ERR.NONE) socket.write(Buffer.from(result.data));
        if (result.disconnect) { socket.end(); return; }
      }
    };

    socket.write(greeting());
    socket.on("data", (incoming) => {
      buffer = Buffer.concat([buffer, incoming]);
      // Requests are answered in order. NBD permits replying out of order, which
      // is what the handle field is for, but ordering costs nothing here and a
      // reordered reply stream is a miserable thing to debug.
      busy = busy.then(drain).catch(onError);
    });

    return this;
  }

  // ---------------------------------------------------------------- internals

  _wake() {
    const waiting = this._waiters;
    this._waiters = [];
    for (const resolve of waiting) resolve();
  }

  _awaitFlush(before, timeoutMs) {
    if (this._flushes > before) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onFlush = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        this._waiters = this._waiters.filter((w) => w !== onFlush);
        reject(new Error(`the kernel did not flush within ${timeoutMs}ms`));
      }, timeoutMs);
      this._waiters.push(onFlush);
    });
  }

  /** Ranges the kernel has told us are free since the last call. */
  takeDiscarded() {
    const out = this._discarded;
    this._discarded = [];
    return out;
  }

  get flushCount() {
    return this._flushes;
  }

  snapshot() {
    return this._bytes.slice();
  }
}
