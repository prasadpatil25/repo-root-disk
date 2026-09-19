// GitHub: the only host of the three with low-level git object writes, and
// consequently the most expensive for this workload.
//
// A commit costs N+3 requests: one blob per new object, then a tree, a commit,
// and a reference update. The measured end-to-end loop was nine requests and
// 5.1 seconds. Compaction of a 94%-full 256 MB machine needs 945 requests, which
// at the enforced 180 writes per minute is 5.3 minutes against 2.8 minutes of
// bandwidth, so it is the one workload here that a rate limit actually bounds.
//
// What GitHub gives in return is the two capabilities the batch-commit hosts
// lack: parentless commits, which compaction needs, and fast-forward-only
// reference updates, which are a real compare-and-swap. A stale parent is
// rejected with 422 every time.

import { Host, toBase64 } from "./adapter.js";

/** Tree entries per create-tree request; larger trees are chained through base_tree. */
const TREE_BATCH = 1000;
/** The batch is halved on a 5xx, down to this. */
const TREE_BATCH_MIN = 50;

export class GitHubHost extends Host {
  static get defaultEndpoint() { return "https://api.github.com"; }

  static get capabilities() {
    return {
      orphanCommit: true,
      casRef: true,
      batchCommit: false,
      maxBodyBytes: 100 * 1024 * 1024
    };
  }

  /**
   * One blob per new object, then the tree (in batches past TREE_BATCH
   * entries), a commit and a reference update. The tree term is what the
   * portability comparison counts as one; it stays one for every machine
   * that section measured.
   */
  static requestsPerCommit(fileCount) {
    return fileCount + Math.max(1, Math.ceil(fileCount / TREE_BATCH)) + 2;
  }

  authHeaders() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
  }

  base(suffix = "") {
    return `/repos/${this.owner}/${this.repo}${suffix}`;
  }

  async validate() {
    const user = await this.request("GET", "/user");
    const repo = await this.request("GET", this.base());
    return {
      login: user.login,
      private: !!repo.private,
      canWrite: !!(repo.permissions && repo.permissions.push)
    };
  }

  async resolveRef(branch) {
    try {
      const ref = await this.request("GET", this.base(`/git/ref/heads/${branch}`));
      const commit = await this.request("GET", this.base(`/git/commits/${ref.object.sha}`));
      return { commit: ref.object.sha, tree: commit.tree.sha };
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  async readCommit(id) {
    const commit = await this.request("GET", this.base(`/git/commits/${id}`));
    return {
      commit: id,
      tree: commit.tree.sha,
      parents: (commit.parents || []).map((p) => p.sha),
      message: commit.message
    };
  }

  async history(branch, { limit = 100 } = {}) {
    const list = await this.request(
      "GET", this.base(`/commits?sha=${encodeURIComponent(branch)}&per_page=${limit}`)
    );
    return list.map((entry) => ({
      commit: entry.sha,
      message: (entry.commit && entry.commit.message) || "",
      when: entry.commit && entry.commit.committer && entry.commit.committer.date
    }));
  }

  async createRef(ref, commit) {
    const created = await this.request("POST", this.base("/git/refs"), {
      body: { ref, sha: commit }
    });
    return created.ref || ref;
  }

  async deleteBranch(branch) {
    await this.request("DELETE", this.base(`/git/refs/heads/${encodeURIComponent(branch)}`));
    return branch;
  }

  async readTree(treeSha) {
    const tree = await this.request("GET", this.base(`/git/trees/${treeSha}?recursive=1`));
    return tree.tree
      .filter((entry) => entry.type === "blob")
      .map((entry) => ({ path: entry.path, id: entry.sha, size: entry.size || 0 }));
  }

  async readObject(id) {
    // The default media type returns base64 inside JSON and inflates a 65,536
    // byte blob to 90,615. Asking for raw is worth 17% on the read path, which
    // matters most on private repositories where the CDN is unavailable and
    // every read goes through here.
    return this.request("GET", this.base(`/git/blobs/${id}`), {
      headers: { Accept: "application/vnd.github.raw" },
      binary: true
    });
  }

  async commit({ branch, message, files, parent = null, orphan = false, branchExists }) {
    const before = this.requestCount;
    const toUpload = files.filter((f) => !f.skipUpload);

    await this.governedAll(
      toUpload.map((file) => async () => {
        const result = await this.request("POST", this.base("/git/blobs"), {
          body: { content: toBase64(file.bytes), encoding: "base64" }, retryOn5xx: true
        });
        if (file.id && result.sha !== file.id) {
          throw new Error(
            `object id mismatch for ${file.path}: computed ${file.id}, server ${result.sha}`
          );
        }
        file.id = result.sha;
        return result.sha;
      })
    );

    // One tree request for the usual sync. A machine with thousands of live
    // chunks exceeds what the endpoint answers in one call (a 502 at 2,460
    // entries, where 941 succeeded), so a large tree is built in batches,
    // each chained onto the previous through base_tree. That costs
    // ceil(n / TREE_BATCH) requests where the portability comparison counts
    // one; a 256 KB chunk machine reaches the second batch at 250 MB of live
    // disk, past every machine that comparison measured.
    const entries = files.map((f) => ({ path: f.path, mode: "100644", type: "blob", sha: f.id }));
    let tree = null;
    let batchSize = TREE_BATCH;
    for (let at = 0; at < entries.length;) {
      const batch = entries.slice(at, at + batchSize);
      const body = tree ? { base_tree: tree.sha, tree: batch } : { tree: batch };
      try {
        tree = await this.governed(() =>
          this.request("POST", this.base("/git/trees"), { body, retryOn5xx: true })
        );
        at += batch.length;
      } catch (err) {
        // A 502, or a 422 that says the request timed out and asks for the
        // tree to be built incrementally, is the endpoint timing out on the
        // batch, not refusing the entries: halve and go again, down to a floor.
        const timedOut = err.status >= 500
          || (err.status === 422 && /timed out|too large|incrementally/i.test(err.message || ""));
        if (timedOut && batchSize > TREE_BATCH_MIN) {
          batchSize = Math.max(TREE_BATCH_MIN, Math.floor(batchSize / 2));
          continue;
        }
        throw err;
      }
    }

    const commit = await this.governed(() =>
      this.request("POST", this.base("/git/commits"), {
        body: {
          message,
          tree: tree.sha,
          parents: orphan || !parent ? [] : [parent]
        },
        retryOn5xx: true
      })
    );

    // Whether the branch exists is already known to the caller, which resolved
    // the ref to obtain `parent`. Probing for it here would cost an extra
    // request per commit and make the cost N+4 rather than the N+3 the
    // portability comparison reports.
    const existing = branchExists !== undefined ? branchExists : parent !== null;
    if (existing) {
      // force is correct only when deliberately discarding history. Otherwise
      // force:false gives fast-forward-only semantics, which is the
      // compare-and-swap P7 depends on: a rejection means someone moved first.
      await this.governed(() =>
        this.request("PATCH", this.base(`/git/refs/heads/${branch}`), {
          body: { sha: commit.sha, force: !!orphan }
        })
      );
    } else {
      // A commit created a moment ago is sometimes not yet visible to the refs
      // endpoint, which then answers 422 "Object does not exist". That is
      // replication lag, not a refusal, and a short retry resolves it.
      for (let attempt = 1; ; attempt++) {
        try {
          await this.governed(() =>
            this.request("POST", this.base("/git/refs"), {
              body: { ref: `refs/heads/${branch}`, sha: commit.sha }
            })
          );
          break;
        } catch (err) {
          const lagging = err.status === 422 && /object does not exist/i.test(err.message || "");
          if (!lagging || attempt >= 5) throw err;
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
    }

    return { commit: commit.sha, requests: this.requestCount - before };
  }

}
