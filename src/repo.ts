export const REPO_RE = /^[\p{L}\p{N}_.-]+\/[\p{L}\p{N}_.-]+$/u;
export const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

// git@github.com:owner/repo.git, ssh://git@github.com/owner/repo, https://github.com/owner/repo/
const GITHUB_REMOTE_RE =
  /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|(?:[^@/]+@)?github\.com:)([^/]+\/[^/]+?)(?:\.git)?\/?$/i;

export function isGithubRepo(name: string): boolean {
  return REPO_RE.test(name);
}

/** The `owner/repo` of a github.com git remote URL, else null. */
export function parseGithubRemote(url: string): string | null {
  const repo = GITHUB_REMOTE_RE.exec(url.trim())?.[1];
  return repo && isGithubRepo(repo) ? repo : null;
}

/** The owner of `owner` or `owner/*` (every repository of `owner`), else null. */
export function wildcardOwner(name: string): string | null {
  let value = name.trim().replace(/\/+$/, "");
  if (value.endsWith("/*")) value = value.slice(0, -2);
  else if (value.includes("/")) return null;
  return OWNER_RE.test(value) ? value : null;
}
