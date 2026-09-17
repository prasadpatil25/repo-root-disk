// A captured machine history: the format shared by the browser that records
// it and the Node harness that replays it.
//
// A history is history.json plus one file per phase. The JSON carries every
// phase's dirty chunk indices, which is all the in-process shapes need since
// they count chunks; the phase files carry the chunk contents, which restic
// needs since content-defined chunking sees content. One phase file is a
// big-endian length-prefixed JSON header followed by the chunks in index order,
// each exactly chunkSize bytes.
//
// No Node imports here: app/demo-history.js runs this in the browser.

/** Pack one phase. `payloads` are the chunks in the order `header.chunks` lists them. */
export function packPhase(header, payloads) {
  const head = new TextEncoder().encode(JSON.stringify(header));
  const total = payloads.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(4 + head.length + total);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  let o = 4 + head.length;
  for (const p of payloads) { out.set(p, o); o += p.length; }
  return out;
}

/** Unpack one phase into writes the shapes and restic can apply. */
export function readPhase(bytes, chunkSize) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headLength = view.getUint32(0);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headLength)));
  const size = chunkSize ?? header.chunkSize;
  const writes = [];
  let o = 4 + headLength;
  for (const index of header.chunks) {
    if (o + size > bytes.length) throw new Error(`phase file truncated at chunk ${index}`);
    writes.push({ index, bytes: bytes.subarray(o, o + size) });
    o += size;
  }
  return { header, writes };
}

/**
 * Turn a history into a plan the shapes replay.
 *
 * `load(file)` returns a phase file's bytes or null when it is absent. A phase
 * without its bytes gets a distinct small payload per chunk, which keeps the
 * chunk counts honest for the shapes that count; whether every phase had bytes
 * is reported, since restic must not run without them. A phase that wrote
 * nothing is not a sync and is dropped.
 */
export function planFrom(history, load) {
  const encoder = new TextEncoder();
  const phases = [];
  let withBytes = 0;
  for (const p of history.phases) {
    if (!p.chunks.length) continue;
    const bytes = load(p.file);
    let writes;
    if (bytes) {
      writes = readPhase(bytes, history.chunkSize).writes;
      withBytes++;
    } else {
      writes = p.chunks.map((index) => ({ index, bytes: encoder.encode(`phase ${p.index} chunk ${index}`) }));
    }
    phases.push({ label: p.label, chunks: p.chunks.length, writes });
  }
  return {
    plan: phases.map((p, i) => ({ sync: i + 1, writes: p.writes })),
    labels: phases.map((p) => p.label),
    skipped: history.phases.length - phases.length,
    haveBytes: withBytes === phases.length
  };
}
