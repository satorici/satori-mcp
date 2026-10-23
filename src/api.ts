/** Minimal Satori REST client: Bearer auth from config, errors raised as typed exceptions. */
import { config } from "./config.js";
import { API_URL, PLAYBOOKS_API_URL } from "./constants.js";
import { ApiTimeoutError, AuthError, HttpStatusError } from "./errors.js";

export type Params = Record<string, unknown>;

export const DEFAULT_TIMEOUT_MS = 30_000;

export function getToken(): string {
  const token = config.get("token");
  if (token) return String(token);
  throw new AuthError("Login required");
}

/** Query string with repeated keys for lists (like httpx); null/undefined are skipped. */
export function buildQuery(params?: Params): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) search.append(key, String(item));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

interface RequestOptions {
  params?: Params;
  json?: unknown;
  body?: FormData;
  /** null disables the timeout (streams). */
  timeoutMs?: number | null;
}

export class ApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly auth: boolean,
  ) {}

  url(path: string, params?: Params): string {
    return `${this.baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}${buildQuery(params)}`;
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const url = this.url(path, options.params);
    const headers: Record<string, string> = {};
    if (this.auth) headers.Authorization = `Bearer ${getToken()}`;
    let body: FormData | string | undefined = options.body;
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    }
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body,
        redirect: "follow",
        signal: timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") throw new ApiTimeoutError(url);
      throw e;
    }
    await raiseForStatus(response);
    return response;
  }

  async get<T = any>(path: string, params?: Params): Promise<T> {
    return (await this.request("GET", path, { params })).json() as Promise<T>;
  }

  async getText(path: string, params?: Params): Promise<string> {
    return (await this.request("GET", path, { params })).text();
  }

  async post<T = any>(path: string, json: unknown): Promise<T> {
    return (await this.request("POST", path, { json })).json() as Promise<T>;
  }

  async patch<T = any>(path: string, json: unknown): Promise<T> {
    return (await this.request("PATCH", path, { json })).json() as Promise<T>;
  }

  async put<T = any>(path: string, json: unknown, params?: Params): Promise<T> {
    return (await this.request("PUT", path, { json, params })).json() as Promise<T>;
  }

  /** DELETE; the API answers 204 with no body. */
  async delete(path: string, params?: Params): Promise<void> {
    await this.request("DELETE", path, { params });
  }

  /** Multipart POST; returns the response body as text. */
  async postForm(path: string, form: FormData): Promise<string> {
    return (await this.request("POST", path, { body: form })).text();
  }

  /** Raw response with no timeout, for large downloads. */
  async stream(path: string): Promise<Response> {
    return this.request("GET", path, { timeoutMs: null });
  }
}

export async function raiseForStatus(response: Response): Promise<void> {
  if (response.status >= 400) {
    throw new HttpStatusError(response.status, await response.text(), response.url);
  }
}

export const client = new ApiClient(API_URL, true);
export const playbooksClient = new ApiClient(PLAYBOOKS_API_URL, false);
