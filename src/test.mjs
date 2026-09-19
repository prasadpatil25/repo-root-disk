// Offline test suite for the storage core and host adapters.
//
// Runs entirely against a mock fetch, so it needs no token, no network and no
// rate budget. Run with: node src/test.mjs

import { blobId, objectPath } from "./core/objectid.js";
import { dirtyChunks, chunkExtent, chunkCount, alignmentCost } from "./core/chunker.js";
import * as manifest from "./core/manifest.js";
import { Governor, RateLimited } from "./core/governor.js";
import { deriveCipher, randomSaltHex, plaintextCipher, describe } from "./core/crypto.js";
import { createHost, compareHosts, GitHubHost, ForgejoHost, GitLabHost } from "./host/index.js";

let passed = 0, failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; console.log("  PASS  " + name); }
  else { failed++; failures.push(name); console.log("  FAIL  " + name + (detail ? "   [" + detail + "]" : "")); }
}

function eq(name, actual, expected) {
  check(name, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected),
        `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const enc = new TextEncoder();

// --------------------------------------------------------------- object ids

console.log("\nobject identity");
eq("blobId of empty matches git", await blobId(new Uint8Array(0)),
   "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
eq('blobId of "hello\\n" matches git', await blobId(enc.encode("hello\n")),
   "ce013625030ba8dba906f756967f9e9ca394464a");
eq("objectPath fans out by prefix", objectPath("ce013625030ba8dba906f756967f9e9ca394464a"),
   "objects/ce/013625030ba8dba906f756967f9e9ca394464a");

// ----------------------------------------------------------------- chunking

console.log("\nchunking");
const K = 1024;
eq("a write inside one chunk dirties one",
   dirtyChunks([{ offset: 100, length: 50 }], 256 * K, 16 * 1024 * K), [0]);
eq("a write spanning a boundary dirties both",
   dirtyChunks([{ offset: 256 * K - 10, length: 20 }], 256 * K, 16 * 1024 * K), [0, 1]);
eq("overlapping writes coalesce",
   dirtyChunks([{ offset: 0, length: 10 }, { offset: 20, length: 10 }], 256 * K, 1024 * K), [0]);
eq("indices come back sorted and unique",
   dirtyChunks([{ offset: 3 * 256 * K, length: 4 }, { offset: 0, length: 4 }], 256 * K, 1024 * 1024),
   [0, 3]);
eq("zero-length writes are ignored", dirtyChunks([{ offset: 0, length: 0 }], 256 * K, 1024), []);
check("a write past the device end is rejected", (() => {
  try { dirtyChunks([{ offset: 1000, length: 200 }], 256, 1024); return false; }
  catch { return true; }
})());
eq("the last chunk is clamped to the device",
   chunkExtent(3, 256 * K, 3 * 256 * K + 100).length, 100);
eq("chunk count rounds up", chunkCount(16 * 1024 * K, 256 * K), 64);

// The two amplification regimes measured on real workloads: scattered
// filesystem metadata cost 2.3x its payload, sequential bulk writes 1.22x.
const scattered = alignmentCost(
  [{ offset: 0, length: 4096 }, { offset: 8 * 1024 * K, length: 4096 }],
  256 * K, 16 * 1024 * K
);
eq("scattered writes touch two chunks", scattered.chunks, 2);
check("scattered writes amplify heavily", scattered.amplification > 50,
      scattered.amplification.toFixed(1) + "x");
const sequential = alignmentCost([{ offset: 0, length: 1024 * K }], 256 * K, 16 * 1024 * K);
check("sequential writes amplify barely", sequential.amplification === 1,
      sequential.amplification.toFixed(2) + "x");

// ----------------------------------------------------------------- manifest

console.log("\nmanifest");
const m = manifest.create({
  diskSize: 16 * 1024 * K, chunkSize: 256 * K, base: "images/base.img", baseIsBlank: true
});
manifest.apply(m, { 0: "aa", 1: "bb", 32: "aa" });
eq("sync counter advances", m.sync, 1);
eq("indices are numeric and sorted", manifest.indices(m), [0, 1, 32]);
eq("distinct objects collapse duplicates", manifest.distinctObjects(m).size, 2);
const st = manifest.stats(m);
eq("three chunks written", st.chunksWritten, 3);
eq("dedup ratio is written over distinct", Number(st.dedupRatio.toFixed(2)), 1.5);
eq("tree entries include the manifest", st.treeEntries, 4);
const round = manifest.parse(manifest.serialize(m));
eq("serialize and parse round trip", round.chunks["32"], "aa");
check("a newer manifest version is refused", (() => {
  try {
    manifest.parse(enc.encode(JSON.stringify({
      version: 99, diskSize: 1, chunkSize: 1, base: "x", chunks: {}
    })));
    return false;
  } catch { return true; }
})());
check("a manifest missing a field is refused", (() => {
  try { manifest.parse(enc.encode(JSON.stringify({ version: 3 }))); return false; }
  catch { return true; }
})());

// ---------------------------------------------------------------- encryption

console.log("\nencryption");
const salt = randomSaltHex();
const cipher = await deriveCipher("correct horse battery staple", salt);
const plain = enc.encode("machine state that should not be readable by the host");
const sealed = await cipher.encrypt(plain);
const opened = await cipher.decrypt(sealed);
eq("round trips", new TextDecoder().decode(opened),
   "machine state that should not be readable by the host");
check("ciphertext differs from plaintext", !sealed.every((b, i) => b === plain[i]));

// Nonces are random, so nothing about two ciphertexts says whether their
// plaintexts were equal. Free space is kept out of the store by the engine
// (a zeroed chunk on a blank base is absent), not by making zeros encrypt alike.
const again = await cipher.encrypt(plain);
check("the same plaintext encrypts differently every time",
      await blobId(again) !== await blobId(sealed));
eq("and both decrypt", new TextDecoder().decode(await cipher.decrypt(again)),
   new TextDecoder().decode(plain));
const zerosA = await cipher.encrypt(new Uint8Array(4096));
const zerosB = await cipher.encrypt(new Uint8Array(4096));
check("two zero chunks do not encrypt alike either", await blobId(zerosA) !== await blobId(zerosB));
check("the recorded parameters say so", describe({ saltHex: salt }).nonce === "random-96");

const wrong = await deriveCipher("wrong passphrase", salt);
let rejected = false;
try { await wrong.decrypt(sealed); } catch { rejected = true; }
check("a wrong passphrase is rejected", rejected);
const differentSalt = await deriveCipher("correct horse battery staple", randomSaltHex());
let saltMatters = false;
try { await differentSalt.decrypt(sealed); } catch { saltMatters = true; }
check("a different salt cannot decrypt", saltMatters);
check("described params never carry a key",
      JSON.stringify(describe({ saltHex: salt })).indexOf("horse") === -1);
eq("the plaintext cipher passes bytes through",
   new TextDecoder().decode(await plaintextCipher.encrypt(plain)),
   new TextDecoder().decode(plain));

// ----------------------------------------------------------------- governor

console.log("\ngovernor");
const gov = new Governor({ ratePerMin: 60000, concurrency: 4 });
const order = [];
await gov.all([1, 2, 3, 4, 5, 6].map((n) => async () => { order.push(n); return n; }));
eq("every task runs", order.length, 6);
eq("issued count tracks writes", gov.stats.issued, 6);
eq("estimate uses the sustained rate",
   Math.round(new Governor({ ratePerMin: 150 }).estimateSeconds(945)), 378);

const slowGov = new Governor({ ratePerMin: 60000, concurrency: 8, sampleWindow: 4, backpressureRatio: 1.5 });
let tick = 0;
const originalNow = Date.now;
// First sample fast, later samples slow: the governor should shed concurrency
// before a refusal arrives, which is what the measured backpressure allows.
for (const latency of [10, 10, 10, 10, 100, 100, 100, 100]) {
  Date.now = () => (tick += latency);
  await slowGov.write(async () => true);
}
Date.now = originalNow;
check("rising latency reduces concurrency", slowGov.concurrency < 8, `now ${slowGov.concurrency}`);

const limitGov = new Governor({ ratePerMin: 60000, concurrency: 4 });
let attempts = 0;
const recovered = await limitGov.write(async () => {
  attempts++;
  if (attempts === 1) throw new RateLimited(0);
  return "ok";
});
eq("a refusal is retried after backoff", recovered, "ok");
eq("the refusal is counted", limitGov.stats.refused, 1);

// -------------------------------------------------------------- host adapters

console.log("\nhost adapters");

function mockFetch(routes) {
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    seen.push({ method, url, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    for (const [pattern, handler] of routes) {
      if (pattern.test(url) ) {
        const result = handler(method, url, seen[seen.length - 1].body);
        if (result) return mockResponse(result.status || 200, result.json);
      }
    }
    return mockResponse(404, { message: "unmocked " + method + " " + url });
  };
  return seen;
}

function mockResponse(status, json) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(json),
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(json)).buffer
  };
}

// GitHub: N+3
{
  const seen = mockFetch([
    [/\/git\/blobs$/, (m) => m === "POST" ? { status: 201, json: { sha: "blob1" } } : null],
    [/\/git\/trees$/, () => ({ status: 201, json: { sha: "tree1" } })],
    [/\/git\/commits$/, () => ({ status: 201, json: { sha: "commit1" } })],
    [/\/git\/ref\/heads\//, () => ({ status: 404, json: { message: "Not Found" } })],
    [/\/git\/refs$/, () => ({ status: 201, json: {} })]
  ]);
  const host = createHost("github", { token: "t", owner: "o", repo: "r" });
  const result = await host.commit({
    branch: "machine", message: "test",
    files: [
      { path: "objects/aa/1", bytes: enc.encode("one") },
      { path: "objects/bb/2", bytes: enc.encode("two") }
    ]
  });
  eq("github returns the commit id", result.commit, "commit1");
  eq("github costs N+3 requests for 2 files", result.requests, 5);
  const posts = seen.filter((r) => r.method === "POST").map((r) => r.url.split("/git/")[1]);
  eq("github order is blobs, tree, commit, ref",
     posts, ["blobs", "blobs", "trees", "commits", "refs"]);
  check("github asks for the raw media type on reads",
        GitHubHost.prototype.readObject.toString().includes("vnd.github.raw"));
}

// GitHub: a tree the endpoint will not build in one call is built in pieces
{
  // 2,300 entries: over the batch size, and the endpoint answers 502 to any
  // batch above 300, which is what a machine with thousands of live chunks
  // met. The tree must still come out, chained through base_tree, and the
  // request count must say what it cost.
  let treeCalls = 0;
  const seen = mockFetch([
    [/\/git\/blobs$/, (m) => m === "POST" ? { status: 201, json: { sha: "blob" } } : null],
    [/\/git\/trees$/, (m, u, body) => {
      treeCalls++;
      if (body.tree.length > 300) return { status: 502, json: { message: "Server Error" } };
      return { status: 201, json: { sha: "tree" + treeCalls } };
    }],
    [/\/git\/commits$/, () => ({ status: 201, json: { sha: "commit1" } })],
    [/\/git\/refs$/, () => ({ status: 201, json: {} })]
  ]);
  const host = createHost("github", { token: "t", owner: "o", repo: "r" });
  const files = Array.from({ length: 2300 }, (_, i) => ({ path: `objects/${i}`, bytes: new Uint8Array(0), id: "blob", skipUpload: true }));
  const result = await host.commit({ branch: "machine", message: "big", files, branchExists: false });
  eq("the commit lands", result.commit, "commit1");
  const treeBodies = seen.filter((r) => r.url.endsWith("/git/trees")).map((r) => r.body);
  const landed = treeBodies.filter((b) => b.tree.length <= 300);
  eq("every entry reached a tree", landed.reduce((a, b) => a + b.tree.length, 0), 2300);
  check("later batches chain onto the earlier tree", landed.slice(1).every((b) => b.base_tree));
  check("no batch exceeded the size the endpoint accepted after the halving", landed.every((b) => b.tree.length <= 250));
  eq("and the model counts one blob-free tree per batch plus commit and reference",
     result.requests, seen.length);
}

// Forgejo: one batch request onto a branch that already exists
{
  const seen = mockFetch([
    [/\/contents$/, () => ({ status: 201, json: { commit: { sha: "fcommit" } } })]
  ]);
  const host = createHost("forgejo", { token: "t", owner: "o", repo: "r" });
  const result = await host.commit({
    branch: "machine", message: "test", branchExists: true,
    files: [
      { path: "objects/aa/1", bytes: enc.encode("one") },
      { path: "objects/bb/2", bytes: enc.encode("two") },
      { path: "manifest.json", bytes: enc.encode("{}"), replaces: "oldsha" }
    ]
  });
  eq("forgejo commits in one request", result.requests, 1);
  eq("forgejo returns the commit id", result.commit, "fcommit");
  const body = seen[0].body;
  eq("forgejo sends all files in one payload", body.files.length, 3);
  eq("new paths are creates", body.files[0].operation, "create");
  eq("a replaced path is an update carrying the prior sha", body.files[2].operation, "update");
  eq("the prior sha travels with the update", body.files[2].sha, "oldsha");
}

// GitLab: one batch request, different spelling
{
  const seen = mockFetch([
    [/\/repository\/commits$/, () => ({ status: 201, json: { id: "glcommit" } })]
  ]);
  const host = createHost("gitlab", { token: "t", owner: "o", repo: "r" });
  const result = await host.commit({
    branch: "machine", message: "test", parent: "parentsha",
    files: [{ path: "objects/aa/1", bytes: enc.encode("one") }]
  });
  eq("gitlab commits in one request", result.requests, 1);
  eq("gitlab returns the commit id", result.commit, "glcommit");
  eq("gitlab uses base64 encoding", seen[0].body.actions[0].encoding, "base64");
  // It cannot pin the parent on the reference, and we had this backwards.
  // start_sha means "create this branch from that commit", so sending it for a
  // branch that already exists is refused with "A branch called X already
  // exists". The compare-and-swap on this host comes from last_commit_id on
  // the manifest instead, tested below.
  check("gitlab sends no parent pin, because the API has no way to accept one",
        seen[0].body.start_sha === undefined && seen[0].body.start_branch === undefined,
        JSON.stringify(Object.keys(seen[0].body)));
}

// GitLab: a sync over the body ceiling becomes several commits, manifest last
{
  const seen = mockFetch([
    [/\/repository\/commits$/, () => ({ status: 201, json: { id: "gl" + seen.length } })]
  ]);
  // A 1 MB ceiling and four 300 KB chunks plus a manifest: about 400 KB each
  // in base64, so two chunks per commit, and the manifest rides in the last.
  const host = createHost("gitlab", { token: "t", owner: "o", repo: "r", maxBodyBytes: 1024 * 1024 });
  const chunk = () => ({ path: "objects/" + Math.random().toString(36).slice(2), bytes: new Uint8Array(300 * 1024) });
  const files = [chunk(), chunk(), chunk(), chunk(), { path: "manifest.json", bytes: enc.encode("{}"), replaces: "old" }];
  const result = await host.commit({ branch: "machine", message: "big", parent: "p", branchExists: true, files });
  const commits = seen.filter((r) => r.url.endsWith("/repository/commits"));
  eq("two commits for what would have been one", [result.requests, result.commits], [2, 2]);
  check("every commit fits the ceiling", commits.every((r) => JSON.stringify(r.body).length <= 1024 * 1024));
  eq("the manifest is in the last commit only",
     commits.map((r) => r.body.actions.some((a) => a.file_path === "manifest.json")), [false, true]);
  eq("every chunk went exactly once", commits.reduce((a, r) => a + r.body.actions.length, 0), 5);
  check("commit messages are numbered", commits.every((r, i) => r.body.commit_message === `big (${i + 1}/2)`));
}

// Creating a branch, which is what a machine's first commit has to do
console.log("\nstarting a new branch on the batch-commit hosts");
{
  // GitLab rejects a commit onto a branch that does not exist unless it is told
  // which existing branch to start it from. The adapter used to name the target
  // itself, and the service answered "You can only create or edit files when you
  // are on a branch", which is true and unhelpful.
  const seen = mockFetch([
    [/\/projects\/[^/]+$/, () => ({ status: 200, json: {
      default_branch: "main", empty_repo: false, visibility: "private"
    } })],
    [/\/repository\/commits$/, () => ({ status: 201, json: { id: "glnew" } })]
  ]);
  const host = createHost("gitlab", { token: "t", owner: "o", repo: "r" });
  const result = await host.commit({
    branch: "machine-abc", message: "create", branchExists: false,
    files: [{ path: "manifest.json", bytes: enc.encode("{}") }]
  });
  const body = seen.find((r) => r.method === "POST").body;
  eq("the commit targets the new branch", body.branch, "machine-abc");
  eq("and starts it from the default branch", body.start_branch, "main");
  check("which is not the branch being created",
        body.start_branch !== body.branch,
        "starting a branch from itself is the bug this pins");
  check("no parent is pinned when there is none", body.start_sha === undefined);
  eq("the commit id comes back", result.commit, "glnew");
}
{
  // An empty repository has no branch to start from, and GitLab takes the first
  // commit with the target named alone. Sending start_branch there would fail.
  const seen = mockFetch([
    [/\/projects\/[^/]+$/, () => ({ status: 200, json: {
      default_branch: null, empty_repo: true, visibility: "private"
    } })],
    [/\/repository\/commits$/, () => ({ status: 201, json: { id: "glfirst" } })]
  ]);
  const host = createHost("gitlab", { token: "t", owner: "o", repo: "r" });
  await host.commit({
    branch: "machine-abc", message: "create", branchExists: false,
    files: [{ path: "manifest.json", bytes: enc.encode("{}") }]
  });
  const body = seen.find((r) => r.method === "POST").body;
  check("an empty repository is committed to with no start branch",
        body.start_branch === undefined, JSON.stringify(body.start_branch));
}
{
  // A repository with commits but no default branch cannot be branched from,
  // and saying so beats a service error the user has to decode.
  mockFetch([
    [/\/projects\/[^/]+$/, () => ({ status: 200, json: {
      default_branch: null, empty_repo: false, visibility: "private"
    } })]
  ]);
  const host = createHost("gitlab", { token: "t", owner: "o", repo: "r" });
  let message = "";
  try {
    await host.commit({
      branch: "machine-abc", message: "create", branchExists: false,
      files: [{ path: "manifest.json", bytes: enc.encode("{}") }]
    });
  } catch (err) { message = err.message; }
  check("no default branch is reported clearly",
        /no default branch/.test(message), message);
}
{
  // Forgejo commits onto `branch` and creates `new_branch` from it, so the two
  // are not interchangeable. Sending only `branch` cannot create anything.
  const seen = mockFetch([
    [/\/repos\/[^/]+\/[^/]+$/, () => ({ status: 200, json: {
      default_branch: "main", empty: false, private: true
    } })],
    [/\/contents$/, () => ({ status: 201, json: { commit: { sha: "fjnew" } } })]
  ]);
  const host = createHost("forgejo", { token: "t", owner: "o", repo: "r" });
  await host.commit({
    branch: "machine-abc", message: "create", branchExists: false,
    files: [{ path: "manifest.json", bytes: enc.encode("{}") }]
  });
  const body = seen.find((r) => r.method === "POST").body;
  eq("it commits onto the existing default branch", body.branch, "main");
  eq("and asks for the machine branch to be created from it",
     body.new_branch, "machine-abc");
}
{
  const host = createHost("forgejo", { token: "t", owner: "o", repo: "r" });
  mockFetch([
    [/\/repos\/[^/]+\/[^/]+$/, () => ({ status: 200, json: {
      default_branch: null, empty: true, private: true
    } })]
  ]);
  let message = "";
  try {
    await host.commit({
      branch: "machine-abc", message: "create", branchExists: false,
      files: [{ path: "manifest.json", bytes: enc.encode("{}") }]
    });
  } catch (err) { message = err.message; }
  check("an empty repository is refused with a reason",
        /no commits yet/.test(message), message);
}
{
  // validate() already fetches the project, so the commit that follows it must
  // not fetch it again. A per-sync extra request is spent from the same budget
  // the whole design is bounded by.
  const seen = mockFetch([
    [/\/user$/, () => ({ status: 200, json: { username: "u" } })],
    [/\/projects\/[^/]+$/, () => ({ status: 200, json: {
      default_branch: "main", empty_repo: false, visibility: "private",
      permissions: { project_access: { access_level: 40 } }
    } })],
    [/\/repository\/commits$/, () => ({ status: 201, json: { id: "glnew" } })]
  ]);
  const host = createHost("gitlab", { token: "t", owner: "o", repo: "r" });
  await host.validate();
  const before = seen.length;
  await host.commit({
    branch: "machine-abc", message: "create", branchExists: false,
    files: [{ path: "manifest.json", bytes: enc.encode("{}") }]
  });
  eq("the commit after validate costs one request", seen.length - before, 1);
}

// What a batch commit is allowed to say about a branch that already exists.
// Both of these needed a second sync to appear, and until the batch-commit
// harness ran, nothing had ever synced to GitLab twice.
{
  const seen = mockFetch([
    [/\/projects\/[^/]+$/, () => ({ json: { default_branch: "main", empty: false } })],
    [/repository\/commits$/, () => ({ json: { id: "c2" } })]
  ]);
  const host = createHost("gitlab", { token: "t", owner: "o", repo: "r" });
  await host.commit({
    branch: "machine", message: "second sync", parent: "c1", branchExists: true,
    files: [{ path: "manifest.json", bytes: enc.encode("{}"), replaces: "blob1" }]
  });
  const body = seen[seen.length - 1].body;
  // start_sha and start_branch both mean "create this branch from there", so
  // either one names a branch that already exists and the commit is refused
  // outright with "A branch called X already exists".
  check("gitlab does not try to start a branch that is already there",
        !("start_sha" in body) && !("start_branch" in body),
        JSON.stringify(Object.keys(body)));
  eq("it commits onto the branch itself", body.branch, "machine");
}
{
  const seen = mockFetch([
    [/\/projects\/[^/]+$/, () => ({ json: { default_branch: "main", empty: false } })],
    [/repository\/commits$/, () => ({ json: { id: "c2" } })]
  ]);
  const host = createHost("gitlab", { token: "t", owner: "o", repo: "r" });
  await host.commit({
    branch: "machine", message: "second sync", parent: "c1", branchExists: true,
    files: [
      { path: "objects/aa/new", bytes: enc.encode("fresh") },
      // Carried so GitHub's tree can name every live object. A batch commit
      // inherits the previous tree, so asking it to create these is asking for
      // files that already exist.
      { path: "objects/bb/old", bytes: enc.encode("already there"), skipUpload: true },
      { path: "manifest.json", bytes: enc.encode("{}"), replaces: "blob1" }
    ]
  });
  const actions = seen[seen.length - 1].body.actions;
  eq("only the files that actually move are sent", actions.length, 2);
  check("the one already in the repository is not among them",
        !actions.some((a) => a.file_path === "objects/bb/old"),
        JSON.stringify(actions.map((a) => a.file_path)));
  eq("a replaced file is an update", actions.find((a) => a.file_path === "manifest.json").action,
     "update");
  eq("and a new one is a create", actions.find((a) => a.file_path === "objects/aa/new").action,
     "create");
}
{
  const seen = mockFetch([
    [/\/repos\/[^/]+\/[^/]+$/, () => ({ json: { default_branch: "main", empty: false } })],
    [/contents$/, () => ({ json: { commit: { sha: "c2" } } })]
  ]);
  const host = createHost("forgejo", { token: "t", owner: "o", repo: "r" });
  await host.commit({
    branch: "machine", message: "second sync", parent: "c1", branchExists: true,
    files: [
      { path: "objects/aa/new", bytes: enc.encode("fresh") },
      { path: "objects/bb/old", bytes: enc.encode("already there"), skipUpload: true }
    ]
  });
  const sent = seen[seen.length - 1].body.files;
  eq("forgejo sends only the files that move", sent.length, 1);
  eq("and it is the new one", sent[0].path, "objects/aa/new");
}
{
  // The body estimate is what refuses an oversized commit before spending a
  // request on it, so it has to be measured on what is actually sent. Counting
  // the skipped files inflated it and would refuse commits that would have fit.
  const seen = mockFetch([
    [/\/projects\/[^/]+$/, () => ({ json: { default_branch: "main", empty: false } })],
    [/repository\/commits$/, () => ({ json: { id: "c2" } })]
  ]);
  const host = createHost("gitlab", { token: "t", owner: "o", repo: "r" });
  const big = { path: "objects/cc/big", bytes: new Uint8Array(30 * 1024 * 1024), skipUpload: true };
  let sent = true;
  try {
    await host.commit({
      branch: "machine", message: "mostly skipped", parent: "c1", branchExists: true,
      files: [big, { path: "manifest.json", bytes: enc.encode("{}"), replaces: "b" }]
    });
  } catch { sent = false; }
  check("a commit whose bulk is skipped is not refused for size", sent);
  eq("and only the small file was sent", seen[seen.length - 1].body.actions.length, 1);
}

{
  // The one field GitLab's API offers that might refuse a stale writer is only
  // sent when a caller supplies it, so an ordinary sync's payload is unchanged.
  const seen = mockFetch([
    [/\/projects\/[^/]+$/, () => ({ json: { default_branch: "main", empty: false } })],
    [/repository\/commits$/, () => ({ json: { id: "c2" } })]
  ]);
  const host = createHost("gitlab", { token: "t", owner: "o", repo: "r" });
  await host.commit({
    branch: "machine", message: "with a lock", parent: "c1", branchExists: true,
    files: [
      { path: "manifest.json", bytes: enc.encode("{}"), replaces: "b1", lastCommit: "c1" },
      { path: "objects/aa/new", bytes: enc.encode("x") }
    ]
  });
  const actions = seen[seen.length - 1].body.actions;
  eq("a file that names its last commit sends last_commit_id",
     actions.find((a) => a.file_path === "manifest.json").last_commit_id, "c1");
  check("and one that does not, does not",
        !("last_commit_id" in actions.find((a) => a.file_path === "objects/aa/new")));
}

// Branch deletion, which exists so a tool can remove the branch it created.
{
  const cases = [
    ["github",  /\/git\/refs\/heads\/cas-probe-x$/,        "DELETE /git/refs/heads/{branch}"],
    ["gitlab",  /\/repository\/branches\/cas-probe-x$/,     "DELETE /repository/branches/{branch}"],
    ["forgejo", /\/branches\/cas-probe-x$/,                 "DELETE /branches/{branch}"]
  ];
  for (const [kind, pattern, label] of cases) {
    const seen = mockFetch([[pattern, () => ({ status: 204, json: null })]]);
    const host = createHost(kind, { token: "t", owner: "o", repo: "r" });
    const got = await host.deleteBranch("cas-probe-x");
    const call = seen[seen.length - 1];
    eq(`${kind} deletes with ${label}`, call.method, "DELETE");
    check(`${kind} names the branch in the path`, pattern.test(call.url), call.url);
    eq(`${kind} returns the branch it removed`, got, "cas-probe-x");
  }
}

// Capabilities are declared honestly rather than emulated badly
console.log("\ncapabilities");
check("only github offers parentless commits",
      GitHubHost.capabilities.orphanCommit &&
      !ForgejoHost.capabilities.orphanCommit &&
      !GitLabHost.capabilities.orphanCommit);
// GitHub's is on the reference. GitLab's and Forgejo's are per-file locks on
// the manifest, which every sync updates, so each amounts to the same
// guarantee. All three measured by cas-probe; Forgejo's is the strongest, since
// its API requires the lock on every update and no unlocked path exists.
check("all three hosts offer a compare-and-swap, each by a measured mechanism",
      GitHubHost.capabilities.casRef &&
      GitLabHost.capabilities.casRef &&
      ForgejoHost.capabilities.casRef);
{
  let refused = false;
  const host = createHost("gitlab", { token: "t", owner: "o", repo: "r" });
  try {
    await host.commit({ branch: "m", message: "x", files: [], orphan: true });
  } catch (err) { refused = /parentless/.test(err.message); }
  check("gitlab refuses an orphan commit rather than faking it", refused);
}
{
  // Refused before sending, and before anything else either. Resolving the
  // branch takes a request, and spending one on a body that can never be sent
  // draws from the same budget the whole design is bounded by.
  const seen = mockFetch([]);
  let refused = false;
  const host = createHost("forgejo", { token: "t", owner: "o", repo: "r" });
  const huge = { path: "objects/aa/1", bytes: new Uint8Array(40 * 1024 * 1024) };
  try {
    await host.commit({ branch: "m", message: "x", files: [huge] });
  } catch (err) { refused = /ceiling/.test(err.message); }
  check("a batch body over the ceiling is refused before sending", refused);
  eq("and costs no requests at all", seen.length, 0);
}

// The portability result, executable
const comparison = compareHosts(941, 256 * 1024);
const gh = comparison.find((c) => c.host === "github");
const fj = comparison.find((c) => c.host === "forgejo");
eq("compaction is 944 requests on github", gh.requests, 944);
eq("compaction is 1 request on forgejo", fj.requests, 1);
check("but forgejo's single body blows the size ceiling", fj.exceedsBodyLimit);
check("github's per-object body stays small", !gh.exceedsBodyLimit);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log("failures: " + failures.join("; ")); process.exit(1); }
