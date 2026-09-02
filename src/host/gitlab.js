// GitLab: no git object writes either, and a batch commit shaped slightly
// differently from Forgejo's.
//
// POST /projects/:id/repository/commits takes an actions array of
// {action, file_path, content, encoding} and produces one commit. Blob and tree
// endpoints exist read only. As with Forgejo, a sync costing eleven requests on
// GitHub costs one here, and the constraint moves from request count to request
// body size.
//
// GitLab advertises its rate limits in response headers even unauthenticated,
// at 500 per minute for anonymous API traffic, which is a different shape
// entirely from GitHub's points system. Callers should read them rather than
// assume our GitHub-derived governor settings transfer.
//
// start_sha gives a weak form of optimistic concurrency, but it is not
// fast-forward-only enforcement on the branch, so as with Forgejo the
// compare-and-swap in P7 has no direct equivalent.

import { Host, toBase64, fromBase64 } from "./adapter.js";

export class GitLabHost extends Host {
  static get defaultEndpoint() { return "https://gitlab.com/api/v4"; }

  static get capabilities() {
    return {
      orphanCommit: false,
      casRef: false,
      batchCommit: true,
      maxBodyBytes: 32 * 1024 * 1024
    };
  }

  authHeaders() {
    return { "PRIVATE-TOKEN": this.token, Accept: "application/json" };
  }

  get projectId() {
    return encodeURIComponent(`${this.owner}/${this.repo}`);
  }

  base(suffix = "") {
    return `/projects/${this.projectId}${suffix}`;
  }

  /**
   * Project metadata the commit path needs, fetched once.
   *
   * Creating a branch requires naming an existing one to start from, so the
   * default branch is not optional information here.
   */
  async project() {
    if (!this._project) {
      const info = await this.request("GET", this.base());
      this._project = {
        defaultBranch: info.default_branch || null,
        empty: !!info.empty_repo,
        visibility: info.visibility,
        permissions: info.permissions
      };
    }
    return this._project;
  }

  async validate() {
    const user = await this.request("GET", "/user");
    const project = await this.request("GET", this.base());
    // Cache it, so the first commit does not pay for this again.
    this._project = {
      defaultBranch: project.default_branch || null,
      empty: !!project.empty_repo,
      visibility: project.visibility,
      permissions: project.permissions
    };
    const access = (project.permissions &&
      (project.permissions.project_access || project.permissions.group_access)) || null;
    return {
      login: user.username,
      private: project.visibility !== "public",
      // 30 is Developer, the lowest level that may push to an ordinary branch
      canWrite: !!access && access.access_level >= 30
    };
  }

  async resolveRef(branch) {
    try {
      const info = await this.request(
        "GET", this.base(`/repository/branches/${encodeURIComponent(branch)}`)
      );
      return { commit: info.commit.id, tree: info.commit.id };
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  async readCommit(id) {
    const commit = await this.request("GET", this.base(`/repository/commits/${id}`));
    return {
      commit: id,
      // GitLab does not expose a tree id, so the tree is addressed by the commit
      // itself and readTree takes that instead.
      tree: id,
      parents: commit.parent_ids || [],
      message: commit.message
    };
  }

  async history(branch, { limit = 100 } = {}) {
    const list = await this.request(
      "GET",
      this.base(`/repository/commits?ref_name=${encodeURIComponent(branch)}&per_page=${limit}`)
    );
    return list.map((entry) => ({
      commit: entry.id,
      message: entry.message || entry.title || "",
      when: entry.committed_date
    }));
  }

  async createRef(ref, commit) {
    // GitLab has no generic reference endpoint; a tag is the closest thing to a
    // reference that does not move.
    const name = ref.replace(/^refs\/tags\//, "");
    const created = await this.request("POST", this.base("/repository/tags"), {
      body: { tag_name: name, ref: commit }
    });
    return created.name || name;
  }

  async readTree(ref) {
    const entries = await this.request(
      "GET", this.base(`/repository/tree?ref=${encodeURIComponent(ref)}&recursive=true&per_page=100`)
    );
    return (entries || [])
      .filter((entry) => entry.type === "blob")
      .map((entry) => ({ path: entry.path, id: entry.id, size: 0 }));
  }

  async readObject(id) {
    const blob = await this.request("GET", this.base(`/repository/blobs/${id}`));
    return fromBase64(blob.content);
  }

  async commit({ branch, message, files, parent = null, orphan = false, branchExists }) {
    const before = this.requestCount;

    if (orphan) {
      throw new Error(
        "GitLab cannot create a parentless commit through the commits API. " +
        "Compaction on this host must delete and recreate the branch."
      );
    }

    // Only what actually has to move. Entries marked skipUpload exist so that
    // GitHub's tree can name every live object; a batch commit inherits the
    // previous tree and applies actions to it, so sending them here asks the
    // host to create files that are already there. The consequence of the
    // inheritance is that chunks dropped by compaction linger as files in the
    // branch until it is rewritten, which costs storage rather than correctness:
    // restore reads the manifest, and the manifest does not name them.
    const toCommit = files.filter((file) => !file.skipUpload);

    const payload = {
      branch,
      commit_message: message,
      actions: toCommit.map((file) => ({
        action: file.replaces ? "update" : "create",
        file_path: file.path,
        content: toBase64(file.bytes),
        encoding: "base64"
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

    // A branch has to be started from a branch that already exists. Naming the
    // target itself, which this adapter used to do, is rejected with "You can
    // only create or edit files when you are on a branch": at that moment the
    // target is exactly what does not exist.
    const exists = branchExists === undefined ? parent !== null : branchExists;
    if (exists) {
      // Nothing. start_sha and start_branch both mean "create this branch from
      // there", so naming either for a branch that already exists is refused
      // outright with "A branch called X already exists". We had read start_sha
      // as a parent pin, which is what it is when the branch is being created
      // and not what it is afterwards.
      //
      // The cost is real and belongs in the paper: on this host an ordinary sync
      // carries no statement about the parent it expected, so the fast-forward
      // check that phase P7 relies on has no equivalent here. Whether anything
      // else supplies it is what src/analysis/cas-probe.mjs exists to settle.
    } else {
      const project = await this.project();
      if (!project.empty) {
        if (!project.defaultBranch) {
          throw new Error(
            `${this.owner}/${this.repo} reports no default branch, so there is ` +
            `nothing to start ${branch} from. Push an initial commit first.`
          );
        }
        payload.start_branch = project.defaultBranch;
      }
      // An empty repository has no branch to start from, and GitLab accepts the
      // very first commit with the target branch named alone.
    }

    const result = await this.governed(() =>
      this.request("POST", this.base("/repository/commits"), { body: payload })
    );
    return { commit: result.id, requests: this.requestCount - before };
  }
}

function estimateBody(payload) {
  let total = 256;
  for (const action of payload.actions) {
    total += action.content.length + action.file_path.length + 64;
  }
  return total;
}
