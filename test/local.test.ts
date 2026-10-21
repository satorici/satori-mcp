import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import type { CommandData, CommandLine } from "../src/local/models.js";
import { Flag, processCommands, runCommand, TimedOut } from "../src/local/runner.js";
import { shlexSplit } from "../src/local/shlex.js";
import { replaceResults, replaceTestcase } from "../src/local/utils.js";
import { InMemoryResultCache } from "../src/local/models.js";

const text = (b: Uint8Array | null) => new TextDecoder().decode(b ?? new Uint8Array());
const lines = (cmd: string, path = "cmd"): CommandLine[] => [{ path, original: cmd, testcase: {} }];
const DATA: Record<string, CommandData> = { cmd: { settings: {} } };

async function run(commandLines: CommandLine[], data = DATA, options = {}) {
  const results = [];
  for await (const [, result] of processCommands(commandLines, data, options)) results.push(result);
  return results;
}

describe("processCommands", () => {
  it("does not leak a timeout into the next run", async () => {
    await expect(run(lines("sleep 5"), DATA, { timeout: 0.5 })).rejects.toThrow(TimedOut);
    const [res] = await run(lines("echo hi"));
    expect(text(res.stdout).trim()).toBe("hi");
  });

  it("honors cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "satori-cwd-"));
    const [res] = await run(lines("pwd"), DATA, { cwd: dir });
    expect(text(res.stdout).trim()).toBe(realpathSync(dir));
  });

  it("runs shell commands with setShell", async () => {
    const [res] = await run(lines("printf 'hi\\n' | cat"), { cmd: { settings: { setShell: true } } });
    expect(text(res.stdout)).toBe("hi\n");
  });

  it("treats shell operators as plain arguments without setShell", async () => {
    const [res] = await run(lines("echo a | b"));
    expect(text(res.stdout)).toBe("a | b\n");
  });

  it("reports a missing executable as os_error", async () => {
    const [res] = await run(lines("definitely-not-a-command-xyz"));
    expect(res.os_error).toBeTruthy();
    expect(res.return_code).toBeNull();
  });

  it("kills a command after setCommandTimeout", async () => {
    const start = performance.now();
    const [res] = await run(lines("sleep 5"), { cmd: { settings: { setCommandTimeout: 0.3 } } });
    expect(performance.now() - start).toBeLessThan(3000);
    expect(res.return_code).toBe(-9);
  });

  it("substitutes earlier results and testcase variables", async () => {
    const commandLines: CommandLine[] = [
      { path: "first", original: "echo hello", testcase: {} },
      { path: "second", original: "echo ${{first.stdout.strip()}} ${{NAME}}", testcase: { NAME: new TextEncoder().encode("world") } },
    ];
    const results = await run(commandLines, { first: { settings: {} }, second: { settings: {} } });
    expect(text(results[1].stdout)).toBe("hello world\n");
  });

  it("runs a parallel group concurrently", async () => {
    const commandLines = [...lines("sleep 0.4"), ...lines("sleep 0.4")];
    const start = performance.now();
    const results = await run(commandLines, { cmd: { settings: { setParallel: true } } });
    expect(results).toHaveLength(2);
    expect(performance.now() - start).toBeLessThan(750);
  });
});

it("streams stdout before the command exits", async () => {
  const chunks: [number, string][] = [];
  const start = performance.now();
  const result = await runCommand(
    new Flag(),
    new Flag(),
    "printf 'hola\\n'; sleep 0.3; printf 'chaudate\\n'",
    true,
    undefined,
    undefined,
    (chunk) => chunks.push([(performance.now() - start) / 1000, text(chunk)]),
  );
  expect(text(result.stdout)).toBe("hola\nchaudate\n");
  expect(chunks.map(([, c]) => c).join("")).toBe("hola\nchaudate\n");
  const firstHola = chunks.find(([, c]) => c.includes("hola"))![0];
  const firstChaudate = chunks.find(([, c]) => c.includes("chaudate"))![0];
  expect(firstHola).toBeLessThan(0.2);
  expect(firstChaudate).toBeGreaterThanOrEqual(0.25);
});

describe("shlexSplit", () => {
  it("matches Python's shlex.split", () => {
    expect(shlexSplit(`a 'b c' "d \\"e\\"" f\\ g`)).toEqual(["a", "b c", 'd "e"', "f g"]);
    expect(shlexSplit("echo a|b; c")).toEqual(["echo", "a|b;", "c"]);
    expect(shlexSplit(`''`)).toEqual([""]);
    expect(() => shlexSplit(`"open`)).toThrow("No closing quotation");
  });
});

describe("result references", () => {
  it("replaces stdout/stderr/return_code and drops unknown refs", () => {
    const cache = new InMemoryResultCache();
    cache.store("a:b", {
      stdout: new TextEncoder().encode(" out \n"),
      stderr: null,
      return_code: 3,
      time: 0,
      os_error: null,
    });
    expect(replaceResults("x ${{a.b.stdout.strip()}} ${{a.b.return_code}} ${{a.b.stderr}}", cache)).toBe("x out 3 ");
    expect(replaceResults("${{z.stdout}}", cache)).toBe("${{z.stdout}}");
    expect(replaceTestcase("${{X}}-${{X}}", { X: "1" })).toBe("1-1");
  });
});
