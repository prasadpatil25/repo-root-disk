// Delete the branches the measurement harnesses leave behind.
//
//   GITLAB_TOKEN=... node src/analysis/clean-probes.mjs gitlab owner/repo \
//       cas-probe-mu4s46l9 cas-probe-mu4s8cjg
//
// Branches are named explicitly rather than listed and matched, and every name
// must carry a harness prefix, so this cannot delete anything the harnesses did
// not create however it is invoked. The prefixes are the ones cas-probe.mjs and
// batch-commit.mjs use.
//
// From now on cas-probe.mjs removes its own branch on the way out, so this is
// for what earlier runs left and for batch-commit.mjs, which keeps its branch
// deliberately because the uploaded data is the measurement.

import { createHost } from "../host/index.js";
import { Governor } from "../core/governor.js";

const PREFIXES = ["cas-probe-", "batch-probe-"];

const [kind, slug, ...branches] = process.argv.slice(2);
if (!kind || !slug || !slug.includes("/") || branches.length === 0) {
  console.error("usage: node src/analysis/clean-probes.mjs <gitlab|github|forgejo> <owner/repo> <branch> [branch...]");
  process.exit(2);
}

const refused = branches.filter((b) => !PREFIXES.some((p) => b.startsWith(p)));
if (refused.length) {
  console.error(`refusing to delete branches that no harness created: ${refused.join(", ")}`);
  console.error(`only names starting with ${PREFIXES.join(" or ")} are accepted`);
  process.exit(2);
}

const tokenVar = `${kind.toUpperCase()}_TOKEN`;
const token = process.env[tokenVar];
if (!token) {
  console.error(`set ${tokenVar} in the environment. It is never printed or stored.`);
  process.exit(2);
}

const [owner, repo] = slug.split("/");
const host = createHost(kind, {
  token, owner, repo,
  endpoint: process.env[`${kind.toUpperCase()}_ENDPOINT`] || undefined,
  governor: new Governor({ ratePerMin: 60, concurrency: 1 })
});

let failed = 0;
for (const branch of branches) {
  try {
    await host.deleteBranch(branch);
    console.log(`  deleted  ${branch}`);
  } catch (err) {
    failed++;
    console.log(`  FAILED   ${branch}   ${String(err.message).slice(0, 80)}`);
  }
}
process.exit(failed ? 1 : 0);
