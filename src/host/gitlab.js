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
      // Not on the reference: the commits API has no expected-parent for an
      // existing branch, and a stale commit is accepted. On the manifest: an
      // update action carrying last_commit_id is refused with "The file has
      // changed" when the file moved since, and every sync updates the
      // manifest, so that one lock is a compare-and-swap on the machine. Both
      // halves measured by src/analysis/cas-probe.mjs.
      casRef: true,
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

  async createBranch(branch, commit) {
    await this.request("POST", this.base("/repository/branches"), {
      body: { branch, ref: commit }
    });
    return branch;
  }

  async deleteBranch(branch) {
    await this.request(
      "DELETE", this.base(`/repository/branches/${encodeURIComponent(branch)}`)
    );
    return branch;
  }

  async readTree(ref) {
    // The tree comes 100 entries a page, and a machine of a few hundred live
    // chunks already needs several. GitHub answers the whole tree in one call;
    // here the reference plus tree costs 1 + ceil(entries / 100) requests,
    // which restore pays on every boot.
    const out = [];
    for (let page = 1; ; page++) {
      const entries = await this.request(
        "GET", this.base(`/repository/tree?ref=${encodeURIComponent(ref)}&recursive=true&per_page=100&page=${page}`)
      );
      for (const entry of entries || []) {
        if (entry.type === "blob") out.push({ path: entry.path, id: entry.id, size: 0 });
      }
      if (!entries || entries.length < 100) break;
    }
    return out;
  }

  async readObject(id) {
    // The JSON form of this endpoint returned 233,593 of a 262,144-byte chunk
    // of random content, measured on the 1 GB machine, where the object under
    // that id is intact (its git id is over the full content). The raw form
    // serves the bytes as they are, and without the base64 inflation.
    return this.request("GET", this.base(`/repository/blobs/${id}/raw`), { binary: true });
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

    const toAction = (file) => ({
      action: file.replaces ? "update" : "create",
      file_path: file.path,
      content: toBase64(file.bytes),
      encoding: "base64",
      // The one field this API offers that might refuse a stale writer:
      // "last known file commit id", enforcement undocumented. Sent only when
      // a caller supplies it, so an ordinary sync is unchanged until the
      // probe has established what it does.
      ...(file.lastCommit ? { last_commit_id: file.lastCommit } : {})
    });
    const actions = toCommit.map(toAction);
    const limit = this.maxBodyBytes;

    // One commit when it fits, which is every sync the portability comparison
    // measured. A sync larger than the ceiling becomes several: the objects
    // go first, in commits that each fit, and the manifest goes last, so the
    // branch's machine state changes only when everything it names is there.
    // The manifest is the caller's last file, by the engine's convention.
    const batches = [];
    let current = [];
    let size = 256;
    for (const action of actions) {
      const cost = action.content.length + action.file_path.length + 64;
      if (current.length && size + cost > limit) { batches.push(current); current = []; size = 256; }
      current.push(action);
      size += cost;
    }
    if (current.length) batches.push(current);
    if (batches.some((b) => b.length === 1 && estimateBody({ actions: b }) > limit)) {
      throw new Error(
        `a single object of about ${(estimateBody({ actions: batches.find((b) => b.length === 1) }) / 1048576).toFixed(1)} MB ` +
        `is over the ${(limit / 1048576).toFixed(0)} MB ceiling we set for this host, which is our own ` +
        `figure and not something the service told us; raise it to find out what the service accepts.`
      );
    }

    // A branch has to be started from a branch that already exists. Naming the
    // target itself, which this adapter used to do, is rejected with "You can
    // only create or edit files when you are on a branch": at that moment the
    // target is exactly what does not exist.
    const exists = branchExists === undefined ? parent !== null : branchExists;
    const payload = { branch, commit_message: message };
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

    let result = null;
    for (let i = 0; i < batches.length; i++) {
      const body = {
        ...payload,
        actions: batches[i],
        commit_message: batches.length === 1 ? message : `${message} (${i + 1}/${batches.length})`
      };
      // Only the first commit starts the branch; the rest are on it.
      if (i > 0) delete body.start_branch;
      result = await this.governed(() =>
        this.request("POST", this.base("/repository/commits"), { body })
      );
    }
    return { commit: result.id, requests: this.requestCount - before, commits: batches.length };
  }
}

function estimateBody(payload) {
  let total = 256;
  for (const action of payload.actions) {
    total += action.content.length + action.file_path.length + 64;
  }
  return total;
}
