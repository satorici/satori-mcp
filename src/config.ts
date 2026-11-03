/**
 * Same credentials as the satori-v2 CLI: `~/.satori_credentials.yml` profiles, overridden by
 * `SATORI_*` env vars (prefix stripped, lowercased). Profile: `default`, `--profile X` in argv,
 * or `SATORI_PROFILE`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";

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

function readFile(configFile: string): Dict {
  if (!existsSync(configFile)) return {};
  const file: unknown = parse(readFileSync(configFile, "utf-8")) ?? {};
  return isDict(file) ? file : {};
}

export class Config {
  readonly profile: string;
  private file: Dict;
  private readonly env: Dict;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    argv: string[] = process.argv,
    private readonly configFile: string = CONFIG_FILE,
  ) {
    this.env = Object.fromEntries(
      Object.entries(env)
        .filter(([k]) => k.startsWith("SATORI_"))
        .map(([k, v]) => [k.slice("SATORI_".length).toLowerCase(), v]),
    );
    this.file = readFile(configFile);
    this.profile = (this.env.profile as string | undefined) ?? profileFromArgv(argv) ?? "default";
  }

  /** Like the CLI's `config.save`: set `key` in the active profile of the credentials file. */
  save(key: string, value: unknown): void {
    const file = readFile(this.configFile);
    file[this.profile] = { ...(isDict(file[this.profile]) ? (file[this.profile] as Dict) : {}), [key]: value };
    writeFileSync(this.configFile, stringify(file));
    this.file = file;
  }

  /** Whether a SATORI_* variable shadows `key` in the file. */
  envOverrides(key: string): boolean {
    return key in this.env;
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
