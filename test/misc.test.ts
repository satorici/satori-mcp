import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { ApiClient, buildQuery } from "../src/api.js";
import { dumpFileUris, makeBundle } from "../src/bundle.js";
import { Config, config } from "../src/config.js";
import { SatoriError } from "../src/errors.js";
import { login } from "../src/login.js";
import { CLONE_ATTEMPTS, cloneRepo, gitDeps, originRepository } from "../src/git.js";
import { runTestFilter } from "../src/outputs.js";
import { pyRepr, pyTuple, splitLines } from "../src/pyrepr.js";
import { isGithubRepo, parseGithubRemote, wildcardOwner } from "../src/repo.js";

afterEach(() => vi.restoreAllMocks());

describe("runTestFilter", () => {
  it("includes a test on a path match", () => {
    const result = runTestFilter(["foo.bar"], [{ path: "foo.bar", output: { stdout: "ok", stderr: "" } }]);
    expect(result).toHaveLength(1);
    expect(result[0].output).toEqual({ stdout: "ok", stderr: "" });
  });

  it("narrows the output to a stream", () => {
    const result = runTestFilter(["foo.bar.stdout"], [{ path: "foo.bar", output: { stdout: "ok", stderr: "err" } }]);
    expect(result[0].output).toEqual({ stdout: "ok" });
    expect(result[0].filtered_result).toBe("stdout");
  });

  it("normalizes colons to dots", () => {
    expect(runTestFilter(["foo:bar"], [{ path: "foo.bar", output: { stdout: "ok" } }])).toHaveLength(1);
  });
});

describe("cloneRepo", () => {
  function fake(results: { code: number; stderr: string }[]) {
    const calls: string[][] = [];
    let i = 0;
    vi.spyOn(gitDeps, "run").mockImplementation(async (cmd) => {
      calls.push(cmd);
      return results[i++];
    });
    vi.spyOn(gitDeps, "sleep").mockResolvedValue(undefined);
    vi.spyOn(gitDeps, "rm").mockReturnValue(undefined);
    return calls;
  }

  it("retries a transient failure, then succeeds", async () => {
    const dest = mkdtempSync(join(tmpdir(), "satori-git-"));
    const calls = fake([
      { code: 128, stderr: "error: RPC failed; curl 56 Recv failure: Connection reset by peer" },
      { code: 0, stderr: "" },
    ]);
    expect(await cloneRepo("git", "a/b", dest)).toBe(join(dest, "b"));
    expect(calls).toHaveLength(2);
    expect(calls[0].slice(0, 5)).toEqual(["git", "clone", "--quiet", "--depth", "1"]);
  });

  it("does not retry a missing repo", async () => {
    const dest = mkdtempSync(join(tmpdir(), "satori-git-"));
    const calls = fake([
      { code: 128, stderr: "fatal: repository 'https://github.com/a/b.git/' not found" },
      { code: 0, stderr: "" },
    ]);
    await expect(cloneRepo("git", "a/b", dest)).rejects.toThrow(SatoriError);
    expect(calls).toHaveLength(1);
  });

  it("gives up after the attempt cap", async () => {
    const dest = mkdtempSync(join(tmpdir(), "satori-git-"));
    const calls = fake(Array(10).fill({ code: 128, stderr: "early EOF" }));
    await expect(cloneRepo("git", "a/b", dest)).rejects.toThrow(SatoriError);
    expect(calls).toHaveLength(CLONE_ATTEMPTS);
  });
});

describe("originRepository", () => {
  it("reads the origin remote of the directory", async () => {
    const output = vi.spyOn(gitDeps, "output").mockResolvedValue("git@github.com:acme/app.git\n");
    expect(await originRepository("/work")).toBe("acme/app");
    expect(output.mock.calls[0][0].slice(1)).toEqual(["-C", "/work", "remote", "get-url", "origin"]);
  });

  it("is null without an origin", async () => {
    vi.spyOn(gitDeps, "output").mockResolvedValue(null);
    expect(await originRepository()).toBeNull();
  });

  it("is null without git", async () => {
    const output = vi.spyOn(gitDeps, "output");
    vi.stubEnv("PATH", "");
    expect(await originRepository()).toBeNull();
    expect(output).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("finds this checkout's origin and nothing outside a checkout", async () => {
    expect(await originRepository(import.meta.dirname)).toMatch(/^[\w.-]+\/[\w.-]+$/);
    expect(await originRepository(tmpdir())).toBeNull();
  });
});

describe("parseGithubRemote", () => {
  it.each([
    ["git@github.com:acme/app.git", "acme/app"],
    ["git@github.com:acme/app", "acme/app"],
    ["ssh://git@github.com/acme/app.git", "acme/app"],
    ["ssh://git@github.com:22/acme/app.git", "acme/app"],
    ["https://github.com/acme/app.git", "acme/app"],
    ["https://github.com/acme/app", "acme/app"],
    ["https://github.com/acme/app/", "acme/app"],
    ["https://token@github.com/Acme/my.app.git\n", "Acme/my.app"],
    ["git://github.com/acme/app.git", "acme/app"],
    ["https://gitlab.com/acme/app.git", null],
    ["git@github.com.evil.test:acme/app.git", null],
    ["https://evil.test/github.com/acme/app", null],
    ["https://github.com/acme", null],
    ["https://github.com/acme/app/tree/main", null],
    ["/srv/git/app.git", null],
    ["", null],
  ])("%s -> %s", (url, expected) => {
    expect(parseGithubRemote(url)).toBe(expected);
  });
});

describe("bundles", () => {
  it("collects file:// references from import lists and input files", () => {
    const playbook = {
      import: ["file://a.yml", "satori://x.yml"],
      test: { cmd: ["echo ${{X}}"], X: [[{ file: "file://inputs.txt" }, { value: "v" }]] },
      mixed: ["file://no.yml", "echo"],
    };
    expect([...dumpFileUris(playbook)]).toEqual(["file://a.yml", "file://inputs.txt"]);
  });

  it("zips the playbook and its references reproducibly", () => {
    const dir = mkdtempSync(join(tmpdir(), "satori-bundle-"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "a.yml"), "x: 1\n");
    writeFileSync(join(dir, ".satori.yml"), "import:\n- file://sub/a.yml\n");
    const first = makeBundle(join(dir, ".satori.yml"));
    expect(makeBundle(join(dir, ".satori.yml"))).toEqual(first);
    const files = unzipSync(first);
    expect(Object.keys(files)).toEqual([".satori.yml", "sub/a.yml"]);
    expect(new TextDecoder().decode(files["sub/a.yml"])).toBe("x: 1\n");
  });
});

describe("config", () => {
  it("merges default, profile and env, env winning", () => {
    const dir = mkdtempSync(join(tmpdir(), "satori-config-"));
    const file = join(dir, "creds.yml");
    writeFileSync(file, "default:\n  token: d\n  other: o\nwork:\n  token: w\n");
    expect(new Config({}, [], file).get("token")).toBe("d");
    const work = new Config({}, ["node", "x", "--profile", "work"], file);
    expect(work.profile).toBe("work");
    expect(work.get("token")).toBe("w");
    expect(work.get("other")).toBe("o");
    const env = new Config({ SATORI_TOKEN: "e", SATORI_PROFILE: "work" }, [], file);
    expect(env.profile).toBe("work");
    expect(env.get("token")).toBe("e");
  });

  it("saves to the active profile like the CLI, keeping everything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "satori-config-"));
    const file = join(dir, "creds.yml");
    writeFileSync(file, "default:\n  token: d\n  organization: 3\nwork:\n  token: w\n");
    const work = new Config({}, ["node", "x", "--profile", "work"], file);
    work.save("organization", 7);
    expect(work.get("organization")).toBe(7);
    expect(parse(readFileSync(file, "utf-8"))).toEqual({
      default: { token: "d", organization: 3 },
      work: { token: "w", organization: 7 },
    });

    work.save("organization", null);
    expect(work.get("organization")).toBeNull();
    expect(new Config({}, ["node", "x", "--profile", "work"], file).get("organization")).toBeNull();
    expect(new Config({}, [], file).get("organization")).toBe(3);
  });

  it("keeps the credentials file readable by its owner only", () => {
    const dir = mkdtempSync(join(tmpdir(), "satori-config-"));
    const created = join(dir, "new.yml");
    new Config({}, [], created).save("token", "t");
    expect(statSync(created).mode & 0o777).toBe(0o600);

    const existing = join(dir, "old.yml");
    writeFileSync(existing, "default:\n  token: d\n", { mode: 0o644 });
    new Config({}, [], existing).save("organization", 7);
    expect(statSync(existing).mode & 0o777).toBe(0o600);
  });

  it("reports env overrides", () => {
    expect(new Config({ SATORI_ORGANIZATION: "9" }, [], "/nonexistent").envOverrides("organization")).toBe(true);
    expect(new Config({}, [], "/nonexistent").envOverrides("organization")).toBe(false);
  });
});

describe("ApiClient", () => {
  async function sentHeaders(settings: Record<string, unknown>): Promise<Record<string, string>> {
    vi.spyOn(config, "get").mockImplementation((key) => settings[key]);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await new ApiClient("https://api.test", true).get("/jobs");
    return fetch.mock.calls[0][1]!.headers as Record<string, string>;
  }

  it("sends the configured organization", async () => {
    const headers = await sentHeaders({ token: "t", organization: 7 });
    expect(headers.Authorization).toBe("Bearer t");
    expect(headers["X-Satori-Organization"]).toBe("7");
  });

  it("acts on the own account without one", async () => {
    expect(await sentHeaders({ token: "t", organization: null })).not.toHaveProperty("X-Satori-Organization");
  });
});

describe("helpers", () => {
  it("formats like Python", () => {
    expect(pyTuple(["PASS", "FAIL"])).toBe("('PASS', 'FAIL')");
    expect(pyTuple(["GITHUB"])).toBe("('GITHUB',)");
    expect(pyRepr(["a", 1, true, null])).toBe("['a', 1, True, None]");
    expect(pyRepr("it's")).toBe(`"it's"`);
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb\rc")).toEqual(["a", "b", "c"]);
    expect(splitLines("")).toEqual([]);
  });

  it("builds queries with repeated keys", () => {
    expect(buildQuery({ a: [1, 2], b: true, c: null, d: undefined })).toBe("?a=1&a=2&b=true");
  });

  it("validates repository names", () => {
    expect(isGithubRepo("o/r")).toBe(true);
    expect(isGithubRepo("nope")).toBe(false);
    expect(wildcardOwner("octo/*")).toBe("octo");
    expect(wildcardOwner("octo/repo")).toBeNull();
  });
});

describe("login", () => {
  const TOKEN = "secret-token-123";

  function setup(options: { status?: number; body?: unknown; env?: NodeJS.ProcessEnv; argv?: string[]; typed?: string } = {}) {
    const file = join(mkdtempSync(join(tmpdir(), "satori-login-")), "creds.yml");
    const output: string[] = [];
    const requests: { url: string; authorization: string }[] = [];
    const deps = {
      readToken: async () => options.typed ?? TOKEN,
      write: (text: string) => void output.push(text),
      config: new Config(options.env ?? {}, options.argv ?? [], file),
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ url, authorization: (init.headers as Record<string, string>).Authorization });
        return new Response(JSON.stringify(options.body ?? { profile: { name: "Ada" } }), {
          status: options.status ?? 200,
        });
      }) as unknown as typeof fetch,
    };
    return { file, deps, requests, text: () => output.join("") };
  }

  it("checks the token, saves it and never prints it", async () => {
    const { file, deps, requests, text } = setup();
    expect(await login(deps)).toBe(0);
    expect(requests).toEqual([{ url: expect.stringMatching(/\/settings$/), authorization: `Bearer ${TOKEN}` }]);
    expect(parse(readFileSync(file, "utf-8"))).toEqual({ default: { token: TOKEN } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(text()).toBe("Logged in as Ada (profile default).\n");
  });

  it("saves to the selected profile and keeps the others", async () => {
    const { file, deps } = setup({ argv: ["node", "x", "login", "--profile", "work"] });
    writeFileSync(file, "default:\n  token: d\n");
    expect(await login(deps)).toBe(0);
    expect(parse(readFileSync(file, "utf-8"))).toEqual({ default: { token: "d" }, work: { token: TOKEN } });
  });

  it("saves nothing when the API rejects the token", async () => {
    const { file, deps, text } = setup({ status: 401 });
    expect(await login(deps)).toBe(1);
    expect(existsSync(file)).toBe(false);
    expect(text()).toBe("Token rejected. Nothing was saved.\n");
  });

  it("saves nothing when the API cannot be reached", async () => {
    const { file, deps, text } = setup();
    deps.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await login(deps)).toBe(1);
    expect(existsSync(file)).toBe(false);
    expect(text()).toContain("failed to connect");
  });

  it("asks nothing of the API when no token is given", async () => {
    const { file, deps, requests } = setup({ typed: "" });
    expect(await login(deps)).toBe(1);
    expect(requests).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  it("warns when SATORI_TOKEN overrides the saved token", async () => {
    const { deps, text } = setup({ env: { SATORI_TOKEN: "other" } });
    expect(await login(deps)).toBe(0);
    expect(text()).toContain("SATORI_TOKEN is set and overrides the saved token");
  });
});
