/**
 * `satori-mcp login`: save an API token to the credentials file, so the server needs no CLI.
 * The token is typed in the terminal (hidden) or piped on stdin, never passed as an argument.
 */
import { config as defaultConfig, type Config } from "./config.js";
import { API_URL } from "./constants.js";

export const LOGIN_COMMAND = "npx -y github:satorici/satori-mcp login";

const PROMPT = "Satori API token (from your profile at https://satori.ci): ";
const TIMEOUT_MS = 30_000;

export interface LoginDeps {
  readToken: () => Promise<string>;
  write: (text: string) => void;
  config: Config;
  fetch: typeof fetch;
}

/** The token from a pipe, or typed at a prompt that does not echo it. */
export async function readToken(
  stdin: NodeJS.ReadStream = process.stdin,
  write: (text: string) => void = (text) => void process.stderr.write(text),
): Promise<string> {
  if (!stdin.isTTY) {
    let piped = "";
    for await (const chunk of stdin) piped += chunk;
    return piped.trim();
  }
  write(PROMPT);
  stdin.setRawMode(true);
  stdin.setEncoding("utf-8");
  try {
    let typed = "";
    for await (const chunk of stdin) {
      for (const char of chunk as string) {
        if (char === "\r" || char === "\n" || char === "\u0004") return typed.trim();
        if (char === "\u0003") return "";
        if (char === "\u007f" || char === "\b") typed = typed.slice(0, -1);
        else typed += char;
      }
    }
    return typed.trim();
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    write("\n");
  }
}

/** Returns the process exit code. */
export async function login(deps: Partial<LoginDeps> = {}): Promise<number> {
  const write = deps.write ?? ((text: string) => void process.stderr.write(text));
  const config = deps.config ?? defaultConfig;
  const request = deps.fetch ?? fetch;

  const token = await (deps.readToken ?? (() => readToken(process.stdin, write)))();
  if (!token) {
    write("No token given. Nothing was saved.\n");
    return 1;
  }

  let response: Response;
  try {
    response = await request(`${API_URL.replace(/\/+$/, "")}/settings`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e instanceof Error && e.name === "TimeoutError" ? "timed out" : "failed to connect";
    write(`Could not check the token: the request to ${API_URL} ${reason}. Nothing was saved.\n`);
    return 1;
  }
  if (response.status === 401 || response.status === 403) {
    write("Token rejected. Nothing was saved.\n");
    return 1;
  }
  if (!response.ok) {
    write(`Could not check the token: ${API_URL} answered HTTP ${response.status}. Nothing was saved.\n`);
    return 1;
  }

  const settings = (await response.json().catch(() => ({}))) as { profile?: { name?: string; email?: string } };
  config.save("token", token);
  const who = settings.profile?.name ?? settings.profile?.email;
  write(`Logged in${who ? ` as ${who}` : ""} (profile ${config.profile}).\n`);
  if (config.envOverrides("token")) {
    write("Warning: SATORI_TOKEN is set and overrides the saved token.\n");
  }
  return 0;
}
