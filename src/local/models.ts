export interface Result {
  stdout: Uint8Array | null;
  stderr: Uint8Array | null;
  return_code: number | null;
  time: number | null;
  os_error: string | null;
}

export interface CommandData {
  /** key: setting name, value: setting value */
  settings: Record<string, any>;
  /** key: assert name, value: all applicable assert values */
  asserts?: Record<string, unknown[]>;
  /** Cache result to reference in future commands */
  cache?: boolean;
}

export interface CommandLine {
  /** Command group path */
  path: string;
  /** Playbook command as-is */
  original: string;
  /** key: variable name, value: variable value */
  testcase: Record<string, Uint8Array | string>;
  [key: string]: unknown;
}

export interface ResultCache {
  store(path: string, result: Result): void;
  get(id: string): Result | undefined;
}

/** Results of earlier commands, looked up by `${{path.stdout}}`-style references. */
export class InMemoryResultCache implements ResultCache {
  private readonly cache = new Map<string, Result>();

  store(path: string, result: Result): void {
    this.cache.set(path.replace(/:/g, "."), result);
  }

  get(id: string): Result | undefined {
    return this.cache.get(id);
  }
}
