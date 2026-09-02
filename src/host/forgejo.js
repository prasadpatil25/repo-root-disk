// Forgejo and Gitea: no git object writes, one batch commit instead.
//
// Confirmed against Forgejo's own OpenAPI specification as served by Codeberg:
// /git/blobs, /git/trees, /git/commits and /git/refs are GET only. What exists is
// POST /repos/{owner}/{repo}/contents, "Modify multiple files in a repository",
// taking a files array of {operation, path, content, sha} and producing a single
// commit. A sync that costs eleven requests on GitHub costs one here.
//
// The catch is body size rather than request count. Every object travels inline,
// so a sync moving 1.8 MB becomes a request body of roughly 2.4 MB once base64
// encoded, and compaction of a populated machine would be hundreds of megabytes
// in one request. Callers should split against maxBodyBytes.
//
// Two capabilities are missing. There is no parentless commit, so compaction has
// to delete and recreate the branch rather than orphaning it. And there is no
// fast-forward-only reference update: the per-file sha check is optimistic
// concurrency on a path, not on the branch, so the compare-and-swap in P7 has no
// direct equivalent and multi-writer safety must be re-established differently.

import { Host, toBase64, fromBase64 } from "./adapter.js";

export class ForgejoHost extends Host {
  static get defaultEndpoint() { return "https://codeberg.org/api/v1"; }

  static get capabilities() {
    return {
      orphanCommit: false,
      casRef: false,
      batchCommit: true,
      maxBodyBytes: 32 * 1024 * 1024
    };
  }

  authHeaders() {
    return { Authorization: `token ${this.token}`, Accept: "application/json" };
  }

  base(suffix = "") {
    return `/repos/${this.owner}/${this.repo}${suffix}`;
  }

  /** Repository metadata the commit path needs, fetched once. */
  async repository() {
    if (!this._repo) {
      const info = await this.request("GET", this.base());
      this._repo = {
        defaultBranch: info.default_branch || null,
        empty: !!info.empty,
        private: !!info.private,
        permissions: info.permissions
      };
    }
    return this._repo;
  }

  async validate() {
    const user = await this.request("GET", "/user");
    const repo = await this.request("GET", this.base());
    this._repo = {
      defaultBranch: repo.default_branch || null,
      empty: !!repo.empty,
      private: !!repo.private,
      permissions: repo.permissions
    };
    return {
      login: user.login,
      private: !!repo.private,
      canWrite: !!(repo.permissions && repo.permissions.push)
    };
  }

  async resolveRef(branch) {
    try {
      const info = await this.request("GET", this.base(`/branches/${branch}`));
      return { commit: info.commit.id, tree: info.commit.id };
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  async readCommit(id) {
    const commit = await this.request("GET", this.base(`/git/commits/${id}`));
    return {
      commit: id,
      tree: (commit.commit && commit.commit.tree && commit.commit.tree.sha) || id,
      parents: (commit.parents || []).map((p) => p.sha),
      message: (commit.commit && commit.commit.message) || ""
    };
  }

  async history(branch, { limit = 100 } = {}) {
    const list = await this.request(
      "GET", this.base(`/commits?sha=${encodeURIComponent(branch)}&limit=${limit}`)
    );
    return list.map((entry) => ({
      commit: entry.sha,
      message: (entry.commit && entry.commit.message) || "",
      when: entry.commit && entry.commit.committer && entry.commit.committer.date
    }));
  }

  async createRef(ref, commit) {
    const name = ref.replace(/^refs\/tags\//, "");
    const created = await this.request("POST", this.base("/tags"), {
      body: { tag_name: name, target: commit }
    });
    return created.name || name;
  }

  async readTree(treeIsh) {
    const tree = await this.request("GET", this.base(`/git/trees/${treeIsh}?recursive=true`));
    return (tree.tree || [])
      .filter((entry) => entry.type === "blob")
      .map((entry) => ({ path: entry.path, id: entry.sha, size: entry.size || 0 }));
  }

  async readObject(id) {
    // Forgejo's blob endpoint returns base64 in JSON with no raw media type, so
    // the 33% inflation is unavoidable here.
    const blob = await this.request("GET", this.base(`/git/blobs/${id}`));
    return fromBase64(blob.content);
  }

  async commit({ branch, message, files, parent = null, orphan = false, branchExists }) {
    const before = this.requestCount;

    if (orphan && !this.constructor.capabilities.orphanCommit) {
      throw new Error(
        "Forgejo cannot create a parentless commit. Compaction on this host must " +
        "delete and recreate the branch, which is not the same operation and loses " +
        "the atomicity the orphan commit provides."
      );
    }

    // See the note in the GitLab adapter: skipUpload entries exist for GitHub's
    // tree, and a batch commit that inherits the previous tree must not be asked
    // to create files that are already in it.
    const toCommit = files.filter((file) => !file.skipUpload);

    const payload = {
      branch,
      message,
      files: toCommit.map((file) => ({
        operation: file.replaces ? "update" : "create",
        path: file.path,
        content: toBase64(file.bytes),
        // Unlike GitLab, this API does take the blob it expects to replace, so
        // an update carries an optimistic lock on that one file.
        ...(file.replaces ? { sha: file.replaces } : {})
      }))
    };

    const estimated = estimateBody(payload);
    const limit = this.maxBodyBytes;
    if (estimated > limit) {
      throw new Error(
        `batch commit body is about ${(estimated / 1048576).toFixed(1)} MB, over the ` +
        `${(limit / 1048576).toFixed(0)} MB ceiling we set for this host, which is ` +
        `our own figure and not something the service told us. Split the sync into ` +
        `several commits, or raise it to find out what the service really accepts.`
      );
    }

    // This API commits onto `branch` and, given `new_branch`, creates that from
    // it. Sending only `branch` for a branch that does not exist yet cannot work,
    // which meant a machine's first commit never had a path here.
    const exists = branchExists === undefined ? parent !== null : branchExists;
    if (!exists) {
      const repo = await this.repository();
      if (repo.empty) {
        throw new Error(
          `${this.owner}/${this.repo} has no commits yet, and this API can only ` +
          `branch from an existing one. Initialise the repository first.`
        );
      }
      if (!repo.defaultBranch) {
        throw new Error(
          `${this.owner}/${this.repo} reports no default branch, so there is ` +
          `nothing to start ${branch} from.`
        );
      }
      payload.branch = repo.defaultBranch;
      payload.new_branch = branch;
    }


    const result = await this.governed(() =>
      this.request("POST", this.base("/contents"), { body: payload })
    );

    const sha = (result && result.commit && (result.commit.sha || result.commit.id)) || null;
    return { commit: sha, requests: this.requestCount - before };
  }
}

function estimateBody(payload) {
  let total = 256;
  for (const file of payload.files) total += file.content.length + file.path.length + 64;
  return total;
}
