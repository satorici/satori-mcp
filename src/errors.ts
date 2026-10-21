export class SatoriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class AuthError extends SatoriError {}

/** A 4xx/5xx response; `text` is the response body. */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly text: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpStatusError";
  }
}

export class ApiTimeoutError extends Error {
  constructor(readonly url: string) {
    super(`Request to ${url} timed out`);
    this.name = "ApiTimeoutError";
  }
}
