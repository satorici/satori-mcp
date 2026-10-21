import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildQuery } from "../src/api.js";
import { dumpFileUris, makeBundle } from "../src/bundle.js";
import { Config } from "../src/config.js";
import { SatoriError } from "../src/errors.js";
import { CLONE_ATTEMPTS, cloneRepo, gitDeps } from "../src/git.js";
import { runTestFilter } from "../src/outputs.js";
import { pyRepr, pyTuple, splitLines } from "../src/pyrepr.js";
import { isGithubRepo, wildcardOwner } from "../src/repo.js";

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
