// Turning a captured write log into a set of dirty chunks.
//
// Capture granularity is the device transfer, not the sector: intercepted calls
// averaged about 79 KB against a 512-byte sector, and a single filesystem format
// arrived as seven calls. So the input is a small number of wide ranges, not a
// large number of sectors, and the job is to project those ranges onto fixed
// chunk boundaries before hashing.
//
// Alignment costs are worth knowing when picking a chunk size. Measured
// amplification was 2.3x for scattered filesystem metadata writes and 1.22x for
// sequential bulk writes, because sequential writes fill whole chunks while
// scattered ones clip the edges of many.

/**
 * @typedef {{offset: number, length: number}} Range
 */

/**
 * Project write ranges onto chunk indices.
 *
 * @param {Iterable<Range>} ranges writes captured since the last sync
 * @param {number} chunkSize bytes per chunk
 * @param {number} [diskSize] total device size, used to clamp the last chunk
 * @returns {number[]} sorted, unique chunk indices
 */
export function dirtyChunks(ranges, chunkSize, diskSize) {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError("chunkSize must be a positive integer");
  }
  const seen = new Set();
  for (const range of ranges) {
    const { offset, length } = range;
    if (length <= 0) continue;
    if (offset < 0) throw new RangeError(`negative offset ${offset}`);
    if (diskSize !== undefined && offset + length > diskSize) {
      throw new RangeError(
        `write [${offset}, ${offset + length}) runs past the device end ${diskSize}`
      );
    }
    const first = Math.floor(offset / chunkSize);
    const last = Math.floor((offset + length - 1) / chunkSize);
    for (let i = first; i <= last; i++) seen.add(i);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Byte extent of a chunk, clamped to the device.
 * @returns {{offset: number, length: number}}
 */
export function chunkExtent(index, chunkSize, diskSize) {
  const offset = index * chunkSize;
  if (offset >= diskSize) throw new RangeError(`chunk ${index} starts past the device end`);
  return { offset, length: Math.min(chunkSize, diskSize - offset) };
}

/** Number of chunks a device of this size is divided into. */
export function chunkCount(diskSize, chunkSize) {
  return Math.ceil(diskSize / chunkSize);
}

/**
 * How much a set of writes costs once aligned to chunks.
 *
 * Reported separately from the payload because the gap between them is the
 * alignment tax, and it is the number that should drive chunk sizing.
 */
export function alignmentCost(ranges, chunkSize, diskSize) {
  const list = [...ranges];
  const payload = list.reduce((sum, r) => sum + Math.max(0, r.length), 0);
  const indices = dirtyChunks(list, chunkSize, diskSize);
  const aligned = indices.reduce(
    (sum, i) => sum + chunkExtent(i, chunkSize, diskSize).length,
    0
  );
  return {
    payloadBytes: payload,
    alignedBytes: aligned,
    chunks: indices.length,
    amplification: payload > 0 ? aligned / payload : 0
  };
}
