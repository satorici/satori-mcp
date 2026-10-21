/** Local command engine: runs a playbook recipe's command lines and yields their results. */
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
import { performance } from "node:perf_hooks";
import { InMemoryResultCache, type CommandData, type CommandLine, type Result, type ResultCache } from "./models.js";
import { shlexSplit } from "./shlex.js";
import { replaceResults, replaceTestcase } from "./utils.js";

export type OnChunk = (chunk: Uint8Array) => void;

export class TimedOut extends Error {}
export class Stopped extends Error {}

/** asyncio.Event equivalent. */
export class Flag {
  private set_ = false;
  private waiters: (() => void)[] = [];

  get isSet(): boolean {
    return this.set_;
  }

  set(): void {
    if (this.set_) return;
    this.set_ = true;
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  wait(): Promise<void> {
    return this.set_ ? Promise.resolve() : new Promise((resolve) => this.waiters.push(resolve));
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(chunks));
}

function spawned(child: ChildProcess): Promise<Error | null> {
  return new Promise((resolve) => {
    child.once("spawn", () => resolve(null));
    child.once("error", (e) => resolve(e));
  });
}

export async function runCommand(
  stop: Flag,
  commandTimeout: Flag,
  command: string,
  shell: boolean | null = null,
  timeout: Flag = new Flag(),
  cwd?: string,
  onStdout?: OnChunk,
  onStderr?: OnChunk,
): Promise<Result> {
  const osError = (message: string): Result => ({
    stdout: null,
    stderr: null,
    return_code: null,
    time: null,
    os_error: message,
  });

  let child: ChildProcess;
  try {
    if (!shell) {
      const argv = shlexSplit(command);
      if (argv.length === 0) return osError("list index out of range");
      child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } else {
      // New session, so the whole process group can be killed.
      child = spawn(command, { cwd, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    }
  } catch (e) {
    return osError(e instanceof Error ? e.message : String(e));
  }

  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  child.stdout!.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
    onStdout?.(chunk);
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
    onStderr?.(chunk);
  });
  const closed = new Promise<number>((resolve) => {
    child.once("close", (code, signal) => {
      resolve(code ?? (signal ? -(constants.signals[signal] ?? 0) : -1));
    });
  });

  const spawnError = await spawned(child);
  if (spawnError) return osError(spawnError.message);

  const start = performance.now();
  const exited = closed.then(() => true);
  const finishedFirst = await Promise.race([
    exited,
    timeout.wait().then(() => false),
    commandTimeout.wait().then(() => false),
    stop.wait().then(() => false),
  ]);
  if (!finishedFirst) {
    try {
      if (shell && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  const returnCode = await closed;
  return {
    stdout: concat(stdoutChunks),
    stderr: concat(stderrChunks),
    return_code: returnCode,
    time: (performance.now() - start) / 1000,
    os_error: null,
  };
}

function* groupByPath(lines: Iterable<CommandLine>): Generator<[string, CommandLine[]]> {
  let current: [string, CommandLine[]] | null = null;
  for (const line of lines) {
    if (current && current[0] === line.path) current[1].push(line);
    else {
      if (current) yield current;
      current = [line.path, [line]];
    }
  }
  if (current) yield current;
}

export interface ProcessOptions {
  timeout?: number | null;
  cache?: ResultCache;
  stop?: Flag;
  cwd?: string;
  onStdout?: OnChunk;
  onStderr?: OnChunk;
}

/**
 * Run command lines grouped by path, honoring setCommandTimeout/setParallel/setShell, and yield
 * each (command line, result). Throws TimedOut once the global `timeout` (seconds) elapses.
 */
export async function* processCommands(
  commandLines: Iterable<CommandLine>,
  commandsData: Record<string, CommandData>,
  options: ProcessOptions = {},
): AsyncGenerator<[CommandLine, Result]> {
  const stop = options.stop ?? new Flag();
  const cache = options.cache ?? new InMemoryResultCache();
  // Per call: the module is reused by the long-lived MCP process.
  const timeoutFlag = new Flag();
  const timer =
    options.timeout !== null && options.timeout !== undefined
      ? setTimeout(() => timeoutFlag.set(), options.timeout * 1000)
      : null;

  const checkEvents = () => {
    if (stop.isSet) throw new Stopped();
    if (timeoutFlag.isSet) throw new TimedOut();
  };
  const buildCommand = (cl: CommandLine) => replaceResults(replaceTestcase(cl.original, cl.testcase ?? {}), cache);

  try {
    for (const [path, clgroup] of groupByPath(commandLines)) {
      const data = commandsData[path];
      if (!data) throw new Error(`No settings for command path ${path}`);
      checkEvents();

      const innerTimeout = data.settings?.setCommandTimeout;
      const parallel = data.settings?.setParallel;
      const shell = data.settings?.setShell ?? null;
      const batches = parallel ? [clgroup] : clgroup.map((cl) => [cl]);

      for (const batch of batches) {
        const commandTimeout = new Flag();
        // Built per batch: a sequential command sees the results of the ones before it.
        const tasks = batch.map(
          (cl) =>
            [
              cl,
              runCommand(
                stop,
                commandTimeout,
                buildCommand(cl),
                shell,
                timeoutFlag,
                options.cwd,
                options.onStdout,
                options.onStderr,
              ),
            ] as const,
        );
        const innerTimer =
          innerTimeout !== null && innerTimeout !== undefined
            ? setTimeout(() => commandTimeout.set(), Number(innerTimeout) * 1000)
            : null;
        try {
          await Promise.all(tasks.map(([, task]) => task));
        } finally {
          if (innerTimer) clearTimeout(innerTimer);
        }

        for (const [commandLine, task] of tasks) {
          const result = await task;
          if (data.cache ?? true) cache.store(commandLine.path, result);
          yield [commandLine, result];
        }
        checkEvents();
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}
