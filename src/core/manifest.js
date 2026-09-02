// The manifest: everything needed to rebuild a machine from a commit.
//
// Two properties matter more than the format. It is cumulative, listing every
// chunk the disk needs rather than only the ones this sync touched, which is why
// restore cost stays constant in the number of syncs: a commit's tree references
// the same objects whether it is the first or the hundredth. And it lists only
// chunks that have been written, so the device is sparse by construction and a
// declared disk size costs nothing until it is used.
//
// It also records the base image explicitly. Restore is base plus written
// chunks, never blank plus written chunks. That distinction is invisible while
// the base is empty and silently corrupts the disk once it is not.

export const MANIFEST_PATH = "manifest.json";
export const MANIFEST_VERSION = 4;

/**
 * @typedef {Object} Manifest
 * @property {number} version
 * @property {number} diskSize      device size in bytes
 * @property {number} chunkSize     bytes per chunk
 * @property {string} base          URL of the read-only base image
 * @property {boolean} baseIsBlank  true if the base is all zeros
 * @property {Object|null} encryption  parameters, never a key
 * @property {Object<string,string>} chunks  chunk index -> object id
 * @property {Object<string,string>} digests chunk index -> SHA-256 of the stored
 *   bytes. The object id is a git SHA-1 and is the address; this is what makes
 *   substitution at that address detectable.
 * @property {number} sync          monotonic sync counter
 * @property {string} [machine]     opaque machine identifier
 */

export function create({
  diskSize,
  chunkSize,
  base,
  baseIsBlank = false,
  encryption = null,
  machine = null
}) {
  if (!Number.isInteger(diskSize) || diskSize <= 0) throw new RangeError("diskSize");
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) throw new RangeError("chunkSize");
  if (!base) throw new Error("a base image URL is required");
  return {
    version: MANIFEST_VERSION,
    diskSize,
    chunkSize,
    base,
    baseIsBlank,
    encryption,
    machine,
    sync: 0,
    chunks: {},
    digests: {}
  };
}

/** Record this epoch's chunks. Mutates and returns the manifest. */
export function apply(manifest, chunkIds, digests = null) {
  if (!manifest.digests) manifest.digests = {};
  for (const [index, id] of Object.entries(chunkIds)) {
    manifest.chunks[String(index)] = id;
    if (digests && digests[index]) manifest.digests[String(index)] = digests[index];
  }
  manifest.sync += 1;
  return manifest;
}

/**
 * Whether every chunk this manifest names can be checked on the way back.
 *
 * A manifest written before digests existed has none, and a machine written by
 * a mixed set of clients could have some. Reporting the difference lets a caller
 * say what it can and cannot promise rather than assuming verification happened.
 */
export function verifiable(manifest) {
  const digests = manifest.digests || {};
  const total = Object.keys(manifest.chunks).length;
  const covered = Object.keys(manifest.chunks).filter((i) => digests[i]).length;
  return { total, covered, complete: total === covered };
}

export function serialize(manifest) {
  return new TextEncoder().encode(JSON.stringify(manifest));
}

export function parse(bytes) {
  const manifest = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof manifest.version !== "number") throw new Error("manifest has no version");
  if (manifest.version > MANIFEST_VERSION) {
    throw new Error(
      `manifest version ${manifest.version} is newer than this client understands ` +
      `(${MANIFEST_VERSION})`
    );
  }
  for (const field of ["diskSize", "chunkSize", "base", "chunks"]) {
    if (manifest[field] === undefined) throw new Error(`manifest is missing ${field}`);
  }
  // Version 3 and earlier carry no digests. Such a machine still restores; it
  // just cannot be verified, and verifiable() is how a caller finds that out.
  if (!manifest.digests) manifest.digests = {};
  return manifest;
}

/** Chunk indices this manifest holds, ascending. */
export function indices(manifest) {
  return Object.keys(manifest.chunks).map(Number).sort((a, b) => a - b);
}

/** Distinct object ids, which is what the repository actually stores. */
export function distinctObjects(manifest) {
  return new Set(Object.values(manifest.chunks));
}

/**
 * What this machine costs, and why.
 *
 * Deduplication here is the reciprocal of occupancy and nothing more: on a
 * 94%-full disk it measured 1.09x, entirely from chunks that were still zero.
 * Reporting occupancy alongside the ratio keeps that visible rather than letting
 * a sparse machine look like compression.
 */
export function stats(manifest) {
  const written = indices(manifest).length;
  const distinct = distinctObjects(manifest).size;
  const total = Math.ceil(manifest.diskSize / manifest.chunkSize);
  return {
    chunksWritten: written,
    chunksTotal: total,
    distinctObjects: distinct,
    occupancy: total > 0 ? written / total : 0,
    dedupRatio: distinct > 0 ? written / distinct : 0,
    storedBytes: distinct * manifest.chunkSize,
    treeEntries: written + 1
  };
}
