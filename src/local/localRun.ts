/** Silent core of a local run: nothing in here may print (MCP stdout is the protocol). */
import { setTimeout as sleep } from "node:timers/promises";
import { decodeMulti, encode } from "@msgpack/msgpack";
import { client, raiseForStatus } from "../api.js";
import type { CommandData, CommandLine } from "./models.js";
import { processCommands, TimedOut } from "./runner.js";

export interface LocalRunResult {
  job: Record<string, any>;
  executionId: number | null;
  report: Record<string, any> | null;
  timedOut: boolean;
}

export interface LocalRunOptions {
  parameters?: Record<string, unknown>;
  visibility?: string;
  tags?: Record<string, string>;
  repository?: string | null;
  workdir?: string;
  run?: string[];
  /** Seconds. */
  timeout?: number | null;
  needsReport?: boolean;
  pollAttempts?: number;
  pollIntervalMs?: number;
}

/** Create a LOCAL job, run its recipe in `workdir`, upload results, find the execution. */
export async function runLocalJob(playbookSource: string, options: LocalRunOptions = {}): Promise<LocalRunResult> {
  const localJob = await client.post("/jobs/locals", {
    playbook_source: playbookSource,
    parameters: options.parameters ?? null,
    visibility: options.visibility ?? "PRIVATE",
    tags: options.tags ?? {},
    repository: options.repository ?? null,
  });

  const recipeResponse = await fetch(localJob.recipe_url);
  await raiseForStatus(recipeResponse);
  const recipe = new Uint8Array(await recipeResponse.arrayBuffer());
  let commandLines = [...decodeMulti(recipe)] as CommandLine[];
  const run = options.run ?? [];
  if (run.length) commandLines = commandLines.filter((c) => run.some((prefix) => c.path.startsWith(prefix)));

  const settingsResponse = await fetch(localJob.settings_url);
  await raiseForStatus(settingsResponse);
  const settings = (await settingsResponse.json()) as Record<string, CommandData>;

  const results: Uint8Array[] = [];
  let timedOut = false;
  try {
    for await (const [cline, result] of processCommands(commandLines, settings, {
      timeout: options.timeout,
      cwd: options.workdir,
    })) {
      results.push(encode({ ...cline, output: result }));
    }
  } catch (e) {
    if (!(e instanceof TimedOut)) throw e;
    timedOut = true;
  }

  const upload = localJob.results_upload;
  const form = new FormData();
  for (const [key, value] of Object.entries(upload.fields as Record<string, string>)) form.append(key, value);
  form.append("x-amz-meta-status", timedOut ? "CANCELED" : "FINISHED");
  form.append("file", new Blob(results as Uint8Array<ArrayBuffer>[]), "upload");
  await raiseForStatus(await fetch(upload.url, { method: "POST", body: form }));

  let executionId: number | null = null;
  let report: Record<string, any> | null = null;
  // The execution (and its report) are created by the backend after the results upload,
  // so poll instead of querying once.
  const attempts = options.pollAttempts ?? 60;
  for (let i = 0; i < attempts; i++) {
    const { items } = await client.get("/executions", { job_id: localJob.id, quantity: 1 });
    if (items.length) {
      executionId = items[0].id as number;
      if (options.needsReport === false) break;
      const execution = await client.get(`/executions/${executionId}`);
      report = execution.report || null;
      if (report && Object.keys(report).length) break;
    }
    await sleep(options.pollIntervalMs ?? 2000);
  }

  return { job: localJob, executionId, report, timedOut };
}
