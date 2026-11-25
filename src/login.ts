/**
 * `satori-mcp login`: save an API token to the credentials file, so the server needs no CLI.
 * In a terminal the dashboard creates the token and posts it to a loopback listener. With
 * `--paste`, or stdin piped, the token is typed (hidden) or read from the pipe instead.
 * It is never passed as an argument.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import { config as defaultConfig, type Config } from "./config.js";
import { API_URL, DASHBOARD_URL } from "./constants.js";

export const LOGIN_COMMAND = "npx -y github:satorici/satori-mcp login";

const PROMPT = `Satori API token (create one at ${DASHBOARD_URL}/tokens): `;
const TIMEOUT_MS = 30_000;
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const MAX_CALLBACK_BYTES = 4096;
const TOKEN_REGEX = /^sat_[0-9A-Za-z]{49}$/;
const MAX_TOKEN_NAME = 100;

/** What the tools call. Settings and organizations have no write scope: those stay in the dashboard. */
export const TOKEN_SCOPES = [
  "jobs:read",
  "jobs:write",
  "executions:read",
  "executions:write",
  "findings:read",
  "findings:write",
  "advisories:read",
  "advisories:write",
  "repos:read",
  "ssh:read",
  "ssh:write",
  "settings:read",
];

export interface LoginDeps {
  /** Ask the dashboard for a token instead of reading one. Defaults to a terminal without `--paste`. */
  browser: boolean;
  readToken: () => Promise<string>;
  openBrowser: (url: string) => void;
  approvalTimeoutMs: number;
  write: (text: string) => void;
  config: Config;
  fetch: typeof fetch;
}

type Resolved = Pick<LoginDeps, "write" | "config" | "fetch">;

/** Best effort: the URL is also printed, for machines where nothing opens. */
export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  execFile(command as string, args as string[], () => {});
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

/** Check the token against the API and save it. Returns the process exit code. */
async function saveToken(token: string, { write, config, fetch: request }: Resolved): Promise<number> {
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

export function authorizeUrl(port: number, state: string): string {
  const query = new URLSearchParams({
    port: String(port),
    state,
    name: `MCP (${hostname()})`.slice(0, MAX_TOKEN_NAME),
    scopes: TOKEN_SCOPES.join(","),
  });
  return `${DASHBOARD_URL.replace(/\/+$/, "")}/cli/authorize?${query}`;
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams | null> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > MAX_CALLBACK_BYTES) return null;
  }
  return new URLSearchParams(body);
}

function sameSecret(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>Satori</title>` +
  `<body style="font-family:system-ui;margin:4rem auto;max-width:28rem"><h1>${title}</h1><p>${text}</p>`;

/**
 * Wait for the dashboard to post `token` and `state` to `POST /callback` on a loopback port.
 * Only the request carrying our `state` ends the wait, so another page can't hand us its token.
 */
function browserLogin(deps: Resolved & Pick<LoginDeps, "openBrowser" | "approvalTimeoutMs">): Promise<number> {
  const { write } = deps;
  const state = randomBytes(32).toString("base64url");

  return new Promise((resolve) => {
    let accepted = false;
    const finish = (code: number) => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      resolve(code);
    };

    const server = createServer(async (request, response) => {
      const reply = (status: number, body: string, done?: () => void) => {
        response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(body, done);
      };
      const { port } = server.address() as AddressInfo;
      if (request.method !== "POST" || request.url !== "/callback" || request.headers.host !== `127.0.0.1:${port}`) {
        return reply(404, page("Not found", "Nothing to see here."));
      }
      const form = await readForm(request).catch(() => null);
      const token = form?.get("token") ?? "";
      if (accepted || !form || !sameSecret(form.get("state") ?? "", state) || !TOKEN_REGEX.test(token)) {
        return reply(400, page("Login refused", "This request did not come from the login you started."));
      }
      accepted = true;
      const code = await saveToken(token, deps);
      reply(
        200,
        code === 0
          ? page("Logged in", "The Satori MCP server is authorized. You can close this tab.")
          : page("Login failed", "The token could not be saved. See the terminal for details."),
        () => finish(code),
      );
    });

    const timer = setTimeout(() => {
      write("Timed out waiting for the approval. Nothing was saved.\n");
      finish(1);
    }, deps.approvalTimeoutMs);

    server.on("error", (e) => {
      write(`Could not listen for the approval: ${e.message}. Try: ${LOGIN_COMMAND} --paste\n`);
      finish(1);
    });
    server.listen(0, "127.0.0.1", () => {
      const url = authorizeUrl((server.address() as AddressInfo).port, state);
      write(`Approve this login in your browser:\n\n  ${url}\n\nWaiting for the approval...\n`);
      deps.openBrowser(url);
    });
  });
}

/** Returns the process exit code. */
export async function login(deps: Partial<LoginDeps> = {}): Promise<number> {
  const resolved: Resolved = {
    write: deps.write ?? ((text: string) => void process.stderr.write(text)),
    config: deps.config ?? defaultConfig,
    fetch: deps.fetch ?? fetch,
  };

  if (deps.browser ?? (process.stdin.isTTY === true && !process.argv.includes("--paste"))) {
    return browserLogin({
      ...resolved,
      openBrowser: deps.openBrowser ?? openBrowser,
      approvalTimeoutMs: deps.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS,
    });
  }

  const token = await (deps.readToken ?? (() => readToken(process.stdin, resolved.write)))();
  if (!token) {
    resolved.write("No token given. Nothing was saved.\n");
    return 1;
  }
  return saveToken(token, resolved);
}
