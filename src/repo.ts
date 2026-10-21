export const REPO_RE = /^[\p{L}\p{N}_.-]+\/[\p{L}\p{N}_.-]+$/u;
export const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function isGithubRepo(name: string): boolean {
  return REPO_RE.test(name);
}

/** The owner of `owner` or `owner/*` (every repository of `owner`), else null. */
export function wildcardOwner(name: string): string | null {
  let value = name.trim().replace(/\/+$/, "");
  if (value.endsWith("/*")) value = value.slice(0, -2);
  else if (value.includes("/")) return null;
  return OWNER_RE.test(value) ? value : null;
}
