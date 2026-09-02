// The Network Block Device wire protocol, as pure functions.
//
// Kept separate from the socket deliberately. Attaching a real kernel needs
// Linux, but the protocol is just bytes, and bytes can be tested anywhere. What
// is left in the server around this is connection handling.
//
// Only what a block device actually needs is here: the fixed-newstyle handshake
// up to an export name, then read, write, flush, trim and disconnect. There is a
// great deal more in the specification, and none of it is required to serve one
// export to one client.

export const MAGIC = {
  // "NBDMAGIC" and "IHAVEOPT", sent in that order to open a newstyle handshake.
  hello: 0x4e42444d41474943n,
  option: 0x49484156454f5054n,
  request: 0x25609513,
  reply: 0x67446698
};

export const CMD = { READ: 0, WRITE: 1, DISCONNECT: 2, FLUSH: 3, TRIM: 4 };
export const OPT = { EXPORT_NAME: 1, ABORT: 2 };

export const FLAG = {
  // Server handshake flags.
  FIXED_NEWSTYLE: 1 << 0,
  NO_ZEROES: 1 << 1,
  // Transmission flags, telling the kernel what this export supports. Announcing
  // flush is what lets the kernel tell us when its cache must reach the disk,
  // and announcing trim is what lets it tell us blocks are free.
  HAS_FLAGS: 1 << 0,
  SEND_FLUSH: 1 << 2,
  SEND_TRIM: 1 << 5
};

export const ERR = { NONE: 0, IO: 5, INVALID: 22, NOSPACE: 28 };

const REQUEST_BYTES = 28;

/** The two magic words and the handshake flags a client reads first. */
export function greeting({ fixedNewstyle = true } = {}) {
  const out = Buffer.alloc(18);
  out.writeBigUInt64BE(MAGIC.hello, 0);
  out.writeBigUInt64BE(MAGIC.option, 8);
  out.writeUInt16BE(fixedNewstyle ? FLAG.FIXED_NEWSTYLE | FLAG.NO_ZEROES : 0, 16);
  return out;
}

/**
 * The reply to NBD_OPT_EXPORT_NAME: the size, what the export supports, and
 * historically 124 zero bytes the client can ask to omit.
 */
export function exportReply(diskSize, { noZeroes = false, readOnly = false } = {}) {
  const padding = noZeroes ? 0 : 124;
  const out = Buffer.alloc(10 + padding);
  out.writeBigUInt64BE(BigInt(diskSize), 0);
  let flags = FLAG.HAS_FLAGS | FLAG.SEND_FLUSH | FLAG.SEND_TRIM;
  if (readOnly) flags |= 1 << 1;
  out.writeUInt16BE(flags, 8);
  return out;
}

/**
 * Read one option header. Returns null when the buffer does not yet hold a
 * whole one, which is the normal case on a stream.
 */
export function parseOption(buffer) {
  if (buffer.length < 16) return null;
  const magic = buffer.readBigUInt64BE(0);
  if (magic !== MAGIC.option) {
    throw new Error(`option magic was ${magic.toString(16)}, not IHAVEOPT`);
  }
  const option = buffer.readUInt32BE(8);
  const length = buffer.readUInt32BE(12);
  if (buffer.length < 16 + length) return null;
  return {
    option,
    data: buffer.subarray(16, 16 + length),
    consumed: 16 + length
  };
}

/**
 * Read one transmission request. A write's payload follows the header, so the
 * caller cannot act until that has arrived either.
 */
export function parseRequest(buffer) {
  if (buffer.length < REQUEST_BYTES) return null;
  const magic = buffer.readUInt32BE(0);
  if (magic !== MAGIC.request) {
    throw new Error(`request magic was ${magic.toString(16)}, not a request`);
  }
  const type = buffer.readUInt16BE(6);
  const length = buffer.readUInt32BE(24);
  const needsPayload = type === CMD.WRITE;
  if (needsPayload && buffer.length < REQUEST_BYTES + length) return null;

  return {
    flags: buffer.readUInt16BE(4),
    type,
    handle: buffer.subarray(8, 16),
    offset: Number(buffer.readBigUInt64BE(16)),
    length,
    data: needsPayload ? buffer.subarray(REQUEST_BYTES, REQUEST_BYTES + length) : null,
    consumed: REQUEST_BYTES + (needsPayload ? length : 0)
  };
}

/** A reply header. Read data follows it on the wire. */
export function reply(handle, error = ERR.NONE) {
  const out = Buffer.alloc(16);
  out.writeUInt32BE(MAGIC.reply, 0);
  out.writeUInt32BE(error, 4);
  Buffer.from(handle).copy(out, 8);
  return out;
}

/** Build an option, the other half of the handshake. */
export function optionRequest(option, data = Buffer.alloc(0)) {
  const body = Buffer.from(data);
  const out = Buffer.alloc(16 + body.length);
  out.writeBigUInt64BE(MAGIC.option, 0);
  out.writeUInt32BE(option, 8);
  out.writeUInt32BE(body.length, 12);
  body.copy(out, 16);
  return out;
}

/** Build a request, which is what the tests need to act as a client. */
export function request({ type, handle, offset = 0, length = 0, data = null }) {
  const head = Buffer.alloc(REQUEST_BYTES);
  head.writeUInt32BE(MAGIC.request, 0);
  head.writeUInt16BE(0, 4);
  head.writeUInt16BE(type, 6);
  Buffer.from(handle).copy(head, 8);
  head.writeBigUInt64BE(BigInt(offset), 16);
  head.writeUInt32BE(length, 24);
  return data ? Buffer.concat([head, Buffer.from(data)]) : head;
}

/**
 * Whether a request is answerable against a device of this size.
 *
 * A request past the end is a protocol error rather than a short read: the
 * kernel is entitled to assume the export is the size it was told.
 */
export function validate({ type, offset, length }, diskSize) {
  if (type === CMD.FLUSH || type === CMD.DISCONNECT) return ERR.NONE;
  if (offset < 0 || length < 0) return ERR.INVALID;
  if (offset + length > diskSize) return ERR.NOSPACE;
  return ERR.NONE;
}
