/** Shallow-clone a GitHub owner/repo into a destination directory. */
import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, rmSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SatoriError } from "./errors.js";

export const CLONE_ATTEMPTS = 3;
const CLONE_BACKOFF_MS = 10_000;
// Retry only genuine network flakiness (a 404 / auth error must fail fast, not retry).
const TRANSIENT_CLONE_RE = new RegExp(
  "Connection reset|Connection timed out|Could not resolve host|Recv failure|send failure" +
    "|early EOF|unexpected disconnect|RPC failed|fetch-pack|index-pack|GnuTLS|TLS|SSL" +
    "|Operation timed out|timed out|returned error: 5\\d\\d|Temporary failure|Broken pipe",
  "i",
);

export interface RunResult {
  code: number | null;
  stderr: string;
}

/** Indirection so tests can fake git and skip the backoff. */
export const gitDeps = {
  run(cmd: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
    return new Promise((resolve) => {
      const child = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", "ignore", "pipe"], env });
      let stderr = "";
      child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (stderr += chunk));
      child.on("error", (e) => resolve({ code: null, stderr: e.message }));
      child.on("close", (code) => resolve({ code, stderr }));
    });
  },
  sleep: (ms: number) => sleep(ms),
  rm: (path: string) => rmSync(path, { recursive: true, force: true }),
};

export function requireGit(): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "git");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  throw new SatoriError("`git` is not installed or not on PATH.");
}

/**
 * Clone `owner/repo` with `--depth 1` into `dest/<repo-name>`. Output is captured, never
 * printed (stdout is the MCP channel); stderr is surfaced only when the clone fails. Transient
 * network failures are retried with backoff; anything else fails immediately.
 */
export async function cloneRepo(git: string, repository: string, dest: string): Promise<string> {
  const url = `https://github.com/${repository}.git`;
  mkdirSync(dest, { recursive: true });
  const cloneDir = join(dest, basename(repository));
  const cmd = [git, "clone", "--quiet", "--depth", "1", url, cloneDir];
  for (let attempt = 1; attempt <= CLONE_ATTEMPTS; attempt++) {
    const result = await gitDeps.run(cmd, { ...process.env, GIT_TERMINAL_PROMPT: "0" });
    if (result.code === 0) return cloneDir;
    const detail = result.stderr.trim();
    if (attempt < CLONE_ATTEMPTS && TRANSIENT_CLONE_RE.test(detail)) {
      gitDeps.rm(cloneDir); // git won't clone into a non-empty dir
      await gitDeps.sleep(CLONE_BACKOFF_MS);
      continue;
    }
    throw new SatoriError(`Failed to clone ${url} (exit ${result.code}): ${detail.slice(0, 500)}`);
  }
  throw new SatoriError(`Failed to clone ${url}`); // unreachable: the loop returns or throws
}
