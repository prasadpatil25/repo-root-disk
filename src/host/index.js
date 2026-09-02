import { Host } from "./adapter.js";
import { GitHubHost } from "./github.js";
import { ForgejoHost } from "./forgejo.js";
import { GitLabHost } from "./gitlab.js";

export { Host, GitHubHost, ForgejoHost, GitLabHost };

const REGISTRY = {
  github: GitHubHost,
  forgejo: ForgejoHost,
  gitea: ForgejoHost,
  codeberg: ForgejoHost,
  gitlab: GitLabHost
};

/**
 * @param {"github"|"forgejo"|"gitea"|"codeberg"|"gitlab"} kind
 * @param {ConstructorParameters<typeof Host>[0]} options
 */
export function createHost(kind, options) {
  const Adapter = REGISTRY[String(kind).toLowerCase()];
  if (!Adapter) {
    throw new Error(
      `unknown host "${kind}". Known: ${Object.keys(REGISTRY).join(", ")}`
    );
  }
  return new Adapter(options);
}

/**
 * Cost comparison across hosts for a given commit shape. This is the portability
 * result in executable form: the same commit is N+3 requests on GitHub and one
 * everywhere else, and the constraint moves from request count to body size.
 */
export function compareHosts(fileCount, bytesPerFile) {
  return Object.entries({ github: GitHubHost, forgejo: ForgejoHost, gitlab: GitLabHost })
    .map(([name, Adapter]) => {
      const caps = Adapter.capabilities;
      const requests = Adapter.requestsPerCommit(fileCount);
      // base64 inflates by 4/3, plus JSON overhead
      const bodyBytes = caps.batchCommit
        ? Math.ceil(fileCount * bytesPerFile * 1.37)
        : Math.ceil(bytesPerFile * 1.37);
      return {
        host: name,
        requests,
        largestBodyBytes: bodyBytes,
        exceedsBodyLimit: bodyBytes > caps.maxBodyBytes,
        orphanCommit: caps.orphanCommit,
        casRef: caps.casRef
      };
    });
}
