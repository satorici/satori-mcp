/**
 * Same credentials as the satori-v2 CLI: `~/.satori_credentials.yml` profiles, overridden by
 * `SATORI_*` env vars (prefix stripped, lowercased). Profile: `default`, `--profile X` in argv,
 * or `SATORI_PROFILE`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

type Dict = Record<string, unknown>;

export const CONFIG_FILE = join(homedir(), ".satori_credentials.yml");

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** deepmerge's always_merger: dicts merge recursively, lists concatenate, the rest is replaced. */
function merge(base: Dict, other: Dict): Dict {
  const result: Dict = { ...base };
  for (const [key, value] of Object.entries(other)) {
    const current = result[key];
    if (isDict(current) && isDict(value)) result[key] = merge(current, value);
    else if (Array.isArray(current) && Array.isArray(value)) result[key] = [...current, ...value];
    else result[key] = value;
  }
  return result;
}

function profileFromArgv(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile") return argv[i + 1];
    if (argv[i].startsWith("--profile=")) return argv[i].split("=")[1];
  }
  return undefined;
}

export class Config {
  readonly profile: string;
  private readonly file: Dict;
  private readonly env: Dict;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    argv: string[] = process.argv,
    configFile: string = CONFIG_FILE,
  ) {
    this.env = Object.fromEntries(
      Object.entries(env)
        .filter(([k]) => k.startsWith("SATORI_"))
        .map(([k, v]) => [k.slice("SATORI_".length).toLowerCase(), v]),
    );
    let file: unknown = {};
    if (existsSync(configFile)) file = parse(readFileSync(configFile, "utf-8")) ?? {};
    this.file = isDict(file) ? file : {};
    this.profile = (this.env.profile as string | undefined) ?? profileFromArgv(argv) ?? "default";
  }

  getAll(): Dict {
    const asDict = (v: unknown): Dict => (isDict(v) ? v : {});
    let config = asDict(this.file.default);
    config = merge(config, asDict(this.file[this.profile]));
    return merge(config, this.env);
  }

  get(key: string): unknown {
    return this.getAll()[key];
  }
}

export const config = new Config();
