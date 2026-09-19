// Optional client-side encryption of chunks.
//
// Storage systems normally resist encryption because it destroys
// deduplication. Here deduplication was measured at 1.09x on a 94%-full disk
// and consists entirely of free space, so there is almost nothing to destroy: a
// system that deduplicates poorly is one that can afford to encrypt.
//
// It also answers the sharpest privacy problem the design has. A
// version-controlled disk cannot forget, so a secret written once and deleted in
// the guest survives in that commit's chunk until compaction and the host's
// garbage collector agree to remove it. Encrypting before upload means the host
// never held the plaintext in the first place.
//
// Nonces are random. An earlier version derived them from the plaintext
// under the key, so that identical chunks encrypted identically and free
// space still collapsed to one object. That is a deterministic scheme, and a
// deterministic scheme leaks equality: anyone who can read the repository and
// get content onto the disk learns whether that content was already there,
// with no key at all (Harnik et al., 2010). The measurement that motivated
// determinism also removes the need for it. Deduplication on a populated disk
// is entirely free space, so the engine now represents a zeroed chunk on a
// blank base by absence, exactly as an unwritten chunk, and nothing about
// occupied chunks need be equal to anything. Every occupied chunk therefore
// gets a fresh 96-bit nonce and the ordinary AES-GCM guarantee.

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();

const PBKDF2_ITERATIONS = 250000;
const NONCE_BYTES = 12;
const SALT_BYTES = 16;

/** Encryption parameters recorded in the manifest. Never includes the key. */
export function describe(params) {
  return params
    ? {
        algorithm: "AES-GCM-256",
        kdf: `PBKDF2-SHA256-${PBKDF2_ITERATIONS}`,
        nonce: "random-96",
        salt: params.saltHex
      }
    : null;
}

export function randomSaltHex() {
  const salt = new Uint8Array(SALT_BYTES);
  globalThis.crypto.getRandomValues(salt);
  return [...salt].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/**
 * Derive a chunk cipher from a passphrase. The salt must be stored in the
 * manifest and reused, or previously written chunks become unreadable.
 *
 * @param {string} passphrase
 * @param {string} saltHex from randomSaltHex(), or an existing manifest
 * @returns {Promise<ChunkCipher>}
 */
export async function deriveCipher(passphrase, saltHex) {
  if (!passphrase) throw new Error("a passphrase is required");
  if (!saltHex) throw new Error("a salt is required; reuse the manifest's salt");

  const material = await subtle.importKey(
    "raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    material,
    256
  );
  const aesKey = await subtle.importKey(
    "raw", new Uint8Array(bits), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]
  );
  return new ChunkCipher(aesKey, saltHex);
}

export class ChunkCipher {
  constructor(aesKey, saltHex) {
    this._aes = aesKey;
    this.saltHex = saltHex;
  }

  /**
   * Encrypt one chunk under a fresh random nonce, prepended so the stored
   * object is self-describing. The same plaintext encrypts differently every
   * time, which is the point. With 96-bit nonces the birthday bound is around
   * 2^32 chunks per key, some 10^15 bytes at this chunk size.
   * @param {Uint8Array} plaintext
   * @returns {Promise<Uint8Array>}
   */
  async encrypt(plaintext) {
    const nonce = new Uint8Array(NONCE_BYTES);
    globalThis.crypto.getRandomValues(nonce);
    const sealed = new Uint8Array(
      await subtle.encrypt({ name: "AES-GCM", iv: nonce }, this._aes, plaintext)
    );
    const out = new Uint8Array(NONCE_BYTES + sealed.length);
    out.set(nonce, 0);
    out.set(sealed, NONCE_BYTES);
    return out;
  }

  /**
   * @param {Uint8Array} stored nonce-prefixed ciphertext
   * @returns {Promise<Uint8Array>}
   */
  async decrypt(stored) {
    if (stored.length <= NONCE_BYTES) throw new Error("ciphertext too short");
    const nonce = stored.slice(0, NONCE_BYTES);
    const body = stored.slice(NONCE_BYTES);
    try {
      return new Uint8Array(
        await subtle.decrypt({ name: "AES-GCM", iv: nonce }, this._aes, body)
      );
    } catch {
      throw new Error("chunk failed to decrypt: wrong passphrase, or the object is corrupt");
    }
  }
}

/** A pass-through used when encryption is disabled, so callers need no branches. */
export const plaintextCipher = {
  saltHex: null,
  async encrypt(bytes) { return bytes; },
  async decrypt(bytes) { return bytes; }
};
