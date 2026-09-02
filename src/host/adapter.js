// The host abstraction.
//
// We expected this to be five operations with different spellings per host. It
// is not. Only GitHub exposes low-level git object writes; Forgejo and GitLab
// serve blobs, trees and commits read only and provide a batch commit endpoint
// instead. The portable operation is therefore a single one,
// commit(files) -> ref, which GitHub implements the long way round at N+3
// requests while the others do it in one.
//
// Adapters also declare what they cannot do rather than emulating it badly.
// Fast-forward-only reference updates give a compare-and-swap on GitHub, and
// neither batch-commit host offers the same guarantee, so concurrency safety is
// a capability rather than an assumption.

import { RateLimited } from "../core/governor.js";

/**
 * @typedef {Object} FileWrite
 * @property {string} path
 * @property {Uint8Array} bytes
 * @property {string} [id] precomputed object id, when the caller knows it
 * @property {string} [replaces] prior object id at this path, if overwriting
 */

/**
 * @typedef {Object} Capabilities
 * @property {boolean} orphanCommit  can commit with no parent, for compaction
 * @property {boolean} casRef        fast-forward-only reference updates
 * @property {boolean} batchCommit   one request per commit regardless of file count
 * @property {number}  maxBodyBytes  practical ceiling on a single request body
 */

export class Host {
  /**
   * @param {Object} options
   * @param {string} options.token
   * @param {string} options.owner
   * @param {string} options.repo
   * @param {string} [options.endpoint] API base, for self-hosted instances
   * @param {import("../core/governor.js").Governor} [options.governor]
   */
  constructor({ token, owner, repo, endpoint, governor, maxBodyBytes }) {
    if (!token) throw new Error("a token is required");
    if (!owner || !repo) throw new Error("owner and repo are required");
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.endpoint = endpoint || this.constructor.defaultEndpoint;
    this.governor = governor || null;
    // Our own ceiling, not the service's. We picked it, we have never asked the
    // service what it accepts, and a measurement that runs into this number is
    // measuring us. Overridable so a probe can find the real one.
    this.maxBodyBytes = maxBodyBytes || this.constructor.capabilities.maxBodyBytes;
    this.requestCount = 0;
  }

  static get defaultEndpoint() {
    throw new Error("subclass must define defaultEndpoint");
  }

  /** @returns {Capabilities} */
  static get capabilities() {
    throw new Error("subclass must declare capabilities");
  }

  /** Requests this host needs to commit `fileCount` new objects. */
  static requestsPerCommit(fileCount) {
    return this.capabilities.batchCommit ? 1 : fileCount + 3;
  }

  // --- to be implemented per host -------------------------------------------

  /** @returns {Promise<{login: string, private: boolean, canWrite: boolean}>} */
  async validate() { throw new Error("not implemented"); }

  /**
   * Create one commit containing these files and move `branch` to it.
   * @param {Object} options
   * @param {string} options.branch
   * @param {string} options.message
   * @param {FileWrite[]} options.files
   * @param {string|null} [options.parent] previous head, null for a first or orphan commit
   * @param {boolean} [options.orphan] discard history, used only by compaction
   * @returns {Promise<{commit: string, requests: number}>}
   */
  async commit() { throw new Error("not implemented"); }

  /** @returns {Promise<{commit: string, tree: string}|null>} null if the branch is absent */
  async resolveRef() { throw new Error("not implemented"); }

  /** @returns {Promise<Array<{path: string, id: string, size: number}>>} */
  async readTree() { throw new Error("not implemented"); }

  /** @returns {Promise<Uint8Array>} */
  async readObject() { throw new Error("not implemented"); }

  /**
   * A commit's tree and parents. Reaching a state other than the newest starts
   * here, because a branch resolves only to the tip.
   */
  async readCommit() { throw new Error("not implemented"); }

  /**
   * A branch's commits, newest first. Bounded by `limit`, because a machine's
   * history is long and a caller searching it does not need all of it.
   */
  async history() { throw new Error("not implemented"); }

  /**
   * Point a new reference at an existing commit. Naming a state costs one
   * request and no storage, since the commit already exists.
   */
  async createRef() { throw new Error("not implemented"); }

  // --- shared plumbing -------------------------------------------------------

  async request(method, path, { body, headers = {}, binary = false, raw = false } = {}) {
    const url = path.startsWith("http") ? path : this.endpoint + path;
    const init = { method, headers: { ...this.authHeaders(), ...headers } };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    this.requestCount++;
    const response = await fetch(url, init);

    if (response.status === 403 || response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after")) || 60;
      throw new RateLimited(retryAfter);
    }
    if (binary) {
      if (!response.ok) throw await this.error(response, method, path);
      return new Uint8Array(await response.arrayBuffer());
    }
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    if (!response.ok) throw await this.error(response, method, path, json, text);
    return raw ? text : json;
  }

  authHeaders() {
    return { Authorization: `Bearer ${this.token}` };
  }

  async error(response, method, path, json, text) {
    const detail = (json && (json.message || json.error)) || (text || "").slice(0, 120);
    const err = new Error(`${method} ${path} -> ${response.status} ${detail}`);
    err.status = response.status;
    return err;
  }

  /** Run a write through the governor when one is attached. */
  governed(fn) {
    return this.governor ? this.governor.write(fn) : fn();
  }

  governedAll(fns) {
    return this.governor ? this.governor.all(fns) : Promise.all(fns.map((f) => f()));
  }
}

const CHUNK = 0x8000;

export function toBase64(bytes) {
  const parts = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(""));
}

export function fromBase64(text) {
  const binary = atob(text.replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
