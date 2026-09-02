// The device contract, and an in-memory implementation of it.
//
// A Device is whatever the sync engine reads chunks from and captures writes
// against. The real one wraps an emulator's block device; this one is backed by
// a plain buffer so the engine can be tested without a virtual machine.
//
// Two parts of the contract are correctness requirements rather than
// conveniences, and both were learned the hard way.
//
// flush() must actually make the guest write. Measured on a real guest, creating
// a file produced zero disk writes; all of them landed later at sync and
// unmount. An implementation that returns without flushing will silently lose
// the user's most recent work at every sync.
//
// readChunk() must read through the device, so that it merges the read-only base
// image with everything written on top of it. Reading from a locally maintained
// shadow buffer is correct only while the base is empty, and corrupts the disk
// the moment it is not.

/**
 * @typedef {{offset: number, length: number}} Range
 *
 * @typedef {Object} Device
 * @property {number} diskSize
 * @property {() => Promise<void>} flush        make the guest write out its cache
 * @property {() => Range[]} seal               close the current epoch, return its writes
 * @property {() => Range[]} pending            writes in the open epoch, without sealing
 * @property {(index: number, chunkSize: number) => Promise<Uint8Array>} readChunk
 * @property {(offset: number, bytes: Uint8Array) => Promise<void>} writeRaw
 *   put bytes on the disk without recording them, for putting a machine back
 *   before the guest runs; recording it would mark the whole disk dirty
 */

import { chunkExtent } from "../core/chunker.js";

export class MemoryDevice {
  /**
   * @param {Object} options
   * @param {number} options.diskSize
   * @param {Uint8Array} [options.base] read-only base image; absent means all zeros
   */
  constructor({ diskSize, base = null }) {
    this.diskSize = diskSize;
    this._bytes = new Uint8Array(diskSize);
    if (base) this._bytes.set(base.subarray(0, Math.min(base.length, diskSize)));
    this._epoch = [];
    this._flushes = 0;
    this._unflushed = [];
  }

  /**
   * Writes made by the "guest". Buffered until flush(), which is what a real
   * page cache does and what the engine must cope with.
   */
  write(offset, bytes) {
    if (offset < 0 || offset + bytes.length > this.diskSize) {
      throw new RangeError("write runs past the device end");
    }
    this._unflushed.push({ offset, bytes: new Uint8Array(bytes) });
  }

  async flush() {
    this._flushes++;
    for (const write of this._unflushed) {
      this._bytes.set(write.bytes, write.offset);
      this._epoch.push({ offset: write.offset, length: write.bytes.length });
    }
    this._unflushed = [];
  }

  seal() {
    const sealed = this._epoch;
    this._epoch = [];
    return sealed;
  }

  pending() {
    return [...this._epoch];
  }

  /**
   * Write without recording. Hydration is not the guest's work, so it must not
   * appear in the epoch or the next sync would re-upload the restored disk.
   */
  async writeRaw(offset, bytes) {
    if (offset < 0 || offset + bytes.length > this.diskSize) {
      throw new RangeError("write runs past the device end");
    }
    this._bytes.set(bytes, offset);
  }

  async readChunk(index, chunkSize) {
    const { offset, length } = chunkExtent(index, chunkSize, this.diskSize);
    return this._bytes.slice(offset, offset + length);
  }

  /** Test helper: the whole device, as a real one could not cheaply provide. */
  snapshot() {
    return this._bytes.slice();
  }

  get flushCount() {
    return this._flushes;
  }
}
