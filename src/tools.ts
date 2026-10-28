/**
 * Tool handlers: a thin, task-shaped client of the Satori v2 API. Each returns a plain object;
 * API/auth failures become small error objects (see `safe`) instead of protocol errors.
 *
 * stdout is the protocol channel. Nothing in here may print to it.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { client, playbooksClient } from "./api.js";
import { makeBundle, uploadBundle } from "./bundle.js";
import { config } from "./config.js";
import { advisoryUrl, DOCS_URL, reportUrl } from "./constants.js";
import { ApiTimeoutError, AuthError, HttpStatusError, SatoriError } from "./errors.js";
import { cloneRepo, requireGit } from "./git.js";
import { runLocalJob } from "./local/localRun.js";
import { loadExecutionOutputs, runTestFilter } from "./outputs.js";
import { pyRepr, pyTuple } from "./pyrepr.js";
import * as recommend from "./recommend.js";
import { isGithubRepo, wildcardOwner } from "./repo.js";
import { normalizeSeverities } from "./severity.js";
import * as shaping from "./shaping.js";

type Dict = Record<string, any>;

export const DOC_MAX_CHARS = 30_000;
export const DOC_PAGES: Record<string, string> = {
  language: "playbooks/language",
  asserts: "playbooks/asserts",
  inputs: "playbooks/inputs",
  settings: "playbooks/settings",
  execution: "playbooks/execution",
  "tool-output": "playbooks/tool-output",
};

export const REPORT_STATUSES = ["PASS", "FAIL"];
export const JOB_TYPES = ["RUN", "SCAN", "MONITOR", "GITHUB", "LOCAL"];
export const VISIBILITIES = ["PUBLIC", "PRIVATE", "UNLISTED"];
export const FINDING_STATUSES = ["OPEN", "INVESTIGATING", "TP", "FIXED", "FP", "ACCEPTED"];
export const LISTABLE_JOB_TYPES = ["RUN", "SCAN", "MONITOR"];
export const FINDING_SOURCES = ["ASSERT", "TOOL"];
export const ORDERS = ["ASC", "DESC"];
export const ADVISORY_KINDS = ["SECURITY_ADVISORY", "ISSUE"];
export const ADVISORY_PROVIDERS = ["GITHUB"];
export const MAX_SCAN_QUANTITY = 10;
export const LOCAL_DEFAULT_TIMEOUT = 300;
export const LOCAL_MAX_TIMEOUT = 3600;
export const MAX_AI_ANALYSIS_FINDING_IDS = 20;
export const AI_ANALYSIS_DEFAULT_WAIT = 120;
export const AI_ANALYSIS_MAX_WAIT = 600;
export const AI_ANALYSIS_POLL_MS = 2000;
export const MAX_DELETE_EXECUTIONS = 100;
export const DELETABLE_JOB_STATUSES = ["CANCELED", "FINISHED"];

/** Indirection so tests can skip real waits and fake the local runner. */
export const deps = {
  sleep: (ms: number) => sleep(ms),
  now: () => performance.now(),
  runLocalJob,
  loadExecutionOutputs,
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
const oneOf = (name: string, values: string[]) => ({ error: `${name} must be one of ${pyTuple(values)}` });

function expandUser(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

const isDir = (path: string) => existsSync(path) && statSync(path).isDirectory();
const isFile = (path: string) => existsSync(path) && statSync(path).isFile();

export const AI_ANALYSIS_409_HINT =
  "Configure an AI provider and API key in Settings (dashboard) before analyzing findings.";

export const PUBLISH_ADVISORY_409_HINT =
  "Conflict: advisory may already be published, or no GitHub PAT is configured in Settings.";

export function errorResult(e: unknown): Dict | null {
  if (e instanceof AuthError) return { error: "Not logged in. Run: satori-v2 config token <token>" };
  if (e instanceof HttpStatusError) {
    const result: Dict = { error: shaping.clip(e.text, 2000), status: e.status };
    if (e.status === 403) result.hint = "This action needs a PRO or ENTERPRISE plan.";
    return result;
  }
  if (e instanceof ApiTimeoutError) return { error: "Request to the Satori API timed out." };
  if (e instanceof SatoriError) return { error: e.message };
  return null;
}

function withAi409Hint(result: Dict): Dict {
  if (result.status === 409) result.hint = AI_ANALYSIS_409_HINT;
  return result;
}

/** Turn API/auth failures into small error objects instead of protocol errors. */
export function safe<A extends unknown[]>(fn: (...args: A) => Promise<Dict>): (...args: A) => Promise<Dict> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      const result = errorResult(e);
      if (result === null) throw e;
      return result;
    }
  };
}

export const whoami = safe(async (): Promise<Dict> => {
  const settings = await client.get("/settings");
  return {
    profile: config.profile,
    endpoint: client.baseUrl,
    notify_email: (settings.notify ?? {}).email ?? null,
    github_pat_configured: ((settings.github ?? {}).token ?? {}).configured ?? null,
  };
});

export async function bundleSource(
  playbookPath?: string | null,
  playbookYaml?: string | null,
  playbookUri?: string | null,
): Promise<string> {
  if ([playbookPath, playbookYaml, playbookUri].filter(Boolean).length !== 1) {
    throw new SatoriError("Provide exactly one of playbook_path, playbook_yaml or playbook_uri.");
  }

  if (playbookUri) {
    if (!playbookUri.startsWith("satori://")) {
      throw new SatoriError(
        "playbook_uri must be a catalog URI like satori://code/python/pyspector_v2.yml (see list_playbooks).",
      );
    }
    return playbookUri;
  }

  let bundle: Uint8Array;
  if (playbookYaml) {
    const tmp = mkdtempSync(join(tmpdir(), "satori-playbook-"));
    try {
      const path = join(tmp, ".satori.yml");
      writeFileSync(path, playbookYaml);
      bundle = makeBundle(path);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  } else {
    const path = expandUser(playbookPath!);
    if (!isFile(path) || ![".yml", ".yaml"].includes(extname(path))) {
      throw new SatoriError(`playbook_path must be an existing .yml file: ${playbookPath}`);
    }
    bundle = makeBundle(path);
  }
  return uploadBundle(bundle);
}

async function firstExecutionId(jobId: number, attempts = 15): Promise<number | null> {
  for (let i = 0; i < attempts; i++) {
    const { items } = await client.get("/executions", { job_id: jobId, quantity: 1 });
    if (items.length) return items[0].id;
    await deps.sleep(1000);
  }
  return null;
}

export async function executionSummary(executionId: number): Promise<Dict> {
  const execution = await client.get(`/executions/${executionId}`);
  return shaping.summarizeExecution(execution, reportUrl(executionId));
}

export interface RecommendArgs {
  directory?: string | null;
  prefs?: Dict | null;
}

export const recommendPlaybook = safe(async ({ directory, prefs }: RecommendArgs = {}): Promise<Dict> => {
  const given = expandUser(directory || ".");
  if (!isDir(given)) return { error: `directory must be an existing directory: ${directory}` };
  const root = resolve(given);

  const readIfFile = (path: string) => (isFile(path) ? readFileSync(path, "utf-8") : null);
  const llmText = readIfFile(join(root, recommend.LLM_PLAYBOOK));
  const ciText = readIfFile(join(root, recommend.CI_PLAYBOOK));

  // Prefer .satori-llm.yml; fall back to a legacy recommended .satori.yml for migrate.
  const legacyCi = llmText === null && ciText !== null && recommend.hasRecommendedHeader(ciText);
  const existingLlm = llmText !== null ? llmText : legacyCi ? ciText : null;
  const previous = existingLlm ? recommend.parseHeader(existingLlm) : null;

  const profile = recommend.detect(root);
  const rec = recommend.build(profile, prefs ?? null, previous);

  const result: Dict = {
    language: profile.language,
    package_manager: profile.manager,
    rules_version: rec.rulesVersion,
    checks: rec.checks.map(({ id, category, command, blocking, why }) => ({ id, category, command, blocking, why })),
    questions: rec.questions,
    prefs: rec.prefsUsed,
    notes: rec.notes,
    llm_playbook: recommend.LLM_PLAYBOOK,
    ci_playbook: recommend.CI_PLAYBOOK,
  };

  const hintParts: string[] = [];
  if (existingLlm === null) {
    result.playbook_yaml = shaping.clip(rec.yaml, shaping.MAX_PLAYBOOK_CHARS);
    hintParts.push(
      `Write playbook_yaml to ${recommend.LLM_PLAYBOOK} with the user's approval ` +
        "(no install section — quality checks only), " +
        `then run_local(playbook_path=${pyRepr(recommend.LLM_PLAYBOOK)}). ` +
        "If a check fails because a tool or deps are missing, install on the host and re-run; " +
        `do not add install: to ${recommend.LLM_PLAYBOOK}.`,
    );
  } else {
    result.existing = true;
    result.changes = recommend.diffExisting(existingLlm, rec);
    result.header = rec.header;
    if (legacyCi) {
      result.migrate_from_ci = true;
      hintParts.push(
        `Move the recommended content out of ${recommend.CI_PLAYBOOK} into ` +
          `${recommend.LLM_PLAYBOOK}: merge \`changes\`, set the \`# satori:recommended\` ` +
          "header line to `header`, drop any top-level install from the LLM file " +
          "(put install on CI instead), with the user's approval.",
      );
    } else {
      hintParts.push(
        `Merge \`changes\` into ${recommend.LLM_PLAYBOOK} and replace its ` +
          "`# satori:recommended` header line with `header` (add it if missing), " +
          "with the user's approval. Keep install out of the LLM playbook " +
          "(see `move_install_to_ci` if present).",
      );
    }
  }

  if (ciText === null) {
    result.ci_playbook_yaml = recommend.ciImporterYaml(rec.install);
    hintParts.push(
      `Also write ci_playbook_yaml to ${recommend.CI_PLAYBOOK} ` +
        "(install for CI + imports the LLM file).",
    );
  } else if (!recommend.ciImportsLlm(ciText)) {
    result.needs_ci_import = true;
    result.ci_import_yaml = recommend.ciImporterYaml();
    const missingInstall = recommend.ciInstallMissing(ciText, rec.install);
    if (missingInstall.length) result.ci_install_missing = missingInstall;
    hintParts.push(
      `Add \`import: - ${recommend.LLM_IMPORT}\` to ${recommend.CI_PLAYBOOK} ` +
        "(see ci_import_yaml); do not overwrite existing CI checks." +
        (missingInstall.length
          ? " Merge `ci_install_missing` into CI install carefully if needed."
          : ""),
    );
  } else if (rec.install.length) {
    const missingInstall = recommend.ciInstallMissing(ciText, rec.install);
    if (missingInstall.length) {
      result.ci_install_missing = missingInstall;
      hintParts.push(
        `Merge \`ci_install_missing\` into ${recommend.CI_PLAYBOOK} install ` +
          "(CI only; keep install out of the LLM playbook).",
      );
    }
  }

  if (rec.questions.length) {
    hintParts.push("Ask the user the `questions` first and call again with `prefs`; defaults were applied meanwhile.");
  }
  result.hint = hintParts.join(" ");
  return result;
});

export interface PlaybookSourceArgs {
  playbook_path?: string | null;
  playbook_yaml?: string | null;
  playbook_uri?: string | null;
}

export interface RunPlaybookArgs extends PlaybookSourceArgs {
  repository?: string | null;
  parameters?: Record<string, string[]> | null;
  secrets?: Record<string, string> | null;
  regions?: string[] | null;
  wait?: boolean;
  wait_seconds?: number;
}

export const runPlaybook = safe(async (args: RunPlaybookArgs = {}): Promise<Dict> => {
  const { wait = true, wait_seconds: waitSeconds = 120 } = args;
  const source = await bundleSource(args.playbook_path, args.playbook_yaml, args.playbook_uri);
  const run = await client.post("/jobs/runs", {
    playbook_source: source,
    parameters: args.parameters || {},
    secrets: args.secrets || {},
    regions: args.regions || [],
    count: 1,
    save_report: true,
    save_output: true,
    repository: args.repository ?? null,
    visibility: "PRIVATE",
  });
  const jobId = run.id;
  const result: Dict = { job_id: jobId, status: run.status ?? null, playbook_source: source };

  const executionId = await firstExecutionId(jobId);
  result.execution_id = executionId;
  if (executionId) result.report_url = reportUrl(executionId);

  if (!wait || executionId === null) {
    result.hint = "Call get_execution(execution_id) to check progress, or stop_execution(execution_id) to cancel.";
    return result;
  }

  const deadline = deps.now() + clamp(waitSeconds, 0, 600) * 1000;
  let status = result.status;
  while (!["FINISHED", "CANCELED"].includes(status) && deps.now() < deadline) {
    await deps.sleep(2000);
    status = (await client.get(`/jobs/${jobId}`)).status;
  }
  result.status = status;

  if (["FINISHED", "CANCELED"].includes(status)) {
    result.execution = await executionSummary(executionId);
  } else {
    result.hint = `Still ${status} after ${waitSeconds}s. Call get_execution(execution_id) later.`;
  }
  return result;
});

export interface RunLocalArgs extends PlaybookSourceArgs {
  repository?: string | null;
  directory?: string | null;
  parameters?: Record<string, string[]> | null;
  run?: string[] | null;
  timeout_seconds?: number;
}

export const runLocal = safe(async (args: RunLocalArgs = {}): Promise<Dict> => {
  const { repository, directory, timeout_seconds: timeoutSeconds = LOCAL_DEFAULT_TIMEOUT } = args;
  if (repository && directory) return { error: "Provide only one of repository or directory." };
  if (repository && repository.endsWith("/*")) return { error: "wildcard is not supported on local" };
  if (repository && !isGithubRepo(repository)) return { error: "repository must be 'owner/repo'." };
  if (directory && !isDir(expandUser(directory))) {
    return { error: `directory must be an existing directory: ${directory}` };
  }

  const source = await bundleSource(args.playbook_path, args.playbook_yaml, args.playbook_uri);
  const timeout = clamp(timeoutSeconds, 1, LOCAL_MAX_TIMEOUT);

  let cloneTmpdir: string | null = null;
  let outcome;
  try {
    let workdir = directory ? expandUser(directory) : undefined;
    if (repository) {
      const git = requireGit();
      cloneTmpdir = mkdtempSync(join(tmpdir(), "satori-local-"));
      workdir = await cloneRepo(git, repository, cloneTmpdir);
    }
    outcome = await deps.runLocalJob(source, {
      parameters: args.parameters || {},
      repository: repository ?? null,
      workdir,
      run: args.run ?? [],
      timeout,
      needsReport: true,
    });
  } finally {
    if (cloneTmpdir !== null) rmSync(cloneTmpdir, { recursive: true, force: true });
  }

  const result: Dict = {
    job_id: outcome.job.id,
    status: outcome.timedOut ? "CANCELED" : "FINISHED",
    playbook_source: source,
    execution_id: outcome.executionId,
  };
  if (outcome.timedOut) result.timed_out = true;
  if (outcome.executionId === null) {
    result.hint =
      "Results were uploaded but no execution appeared yet; call get_job(job_id) or list_executions(job_id=...) later.";
    return result;
  }

  result.report_url = reportUrl(outcome.executionId);
  result.execution = await executionSummary(outcome.executionId);
  result.hint =
    "Call get_execution_output(execution_id, test=...) for logs and list_findings(execution_id=...) for findings.";
  return result;
});

export const getExecution = safe(async ({ execution_id }: { execution_id: number }) =>
  executionSummary(execution_id),
);

export interface ListExecutionsArgs {
  job_id?: number | null;
  status?: string[] | null;
  report_status?: string | null;
  job_type?: string | null;
  from_?: string | null;
  to?: string | null;
  q?: string | null;
  visibility?: string | null;
  severity?: number | null;
  playbook?: string | null;
  tags?: string[] | null;
  id_gt?: number | null;
  id_lt?: number | null;
  global_?: boolean;
  order?: string | null;
  quantity?: number;
  page?: number;
}

export const listExecutions = safe(async (args: ListExecutionsArgs = {}): Promise<Dict> => {
  const { report_status: reportStatus, job_type: jobType, from_: from, to, severity, page = 1 } = args;
  const visibility = args.visibility ? args.visibility.toUpperCase() : null;
  const order = args.order ? args.order.toUpperCase() : null;
  if (reportStatus && !REPORT_STATUSES.includes(reportStatus)) return oneOf("report_status", REPORT_STATUSES);
  if (jobType && !JOB_TYPES.includes(jobType)) return oneOf("job_type", JOB_TYPES);
  if (visibility && !VISIBILITIES.includes(visibility)) return oneOf("visibility", VISIBILITIES);
  if (severity !== null && severity !== undefined && (severity < 0 || severity > 5)) {
    return { error: "severity must be an int 0-5." };
  }
  if (order && !ORDERS.includes(order)) return oneOf("order", ORDERS);
  if (from && to && from >= to) return { error: "from_ must be earlier than to." };

  const quantity = clamp(args.quantity ?? 25, 1, 25);
  const params: Dict = { quantity, page, order: order || "DESC" };
  const optional: Dict = {
    job_id: args.job_id,
    status: args.status,
    report_status: reportStatus,
    job_type: jobType,
    from,
    to,
    q: args.q,
    visibility,
    severity,
    playbook: args.playbook,
    tags: args.tags,
    id_gt: args.id_gt,
    id_lt: args.id_lt,
  };
  for (const [k, v] of Object.entries(optional)) {
    if (v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)) params[k] = v;
  }
  if (args.global_) params.global = true;
  const data = await client.get("/executions", params);
  return shaping.paged(
    data.items.map((e: Dict) => shaping.summarizeExecutionRow(e, reportUrl(e.id))),
    data.total,
    page,
    quantity,
  );
});

export const stopExecution = safe(async ({ execution_id: id }: { execution_id: number }): Promise<Dict> => {
  const status = (await client.get(`/executions/${id}`)).status ?? null;
  if (status !== "RUNNING") {
    return { execution_id: id, status, stopped: false, hint: "Only RUNNING executions can be stopped." };
  }
  await client.patch(`/executions/${id}`, { status: "CANCELED" });
  return { execution_id: id, stopped: true, hint: "Cancellation is asynchronous; call get_execution to confirm." };
});

export const deleteExecution = safe(async ({ execution_id: id }: { execution_id: number }): Promise<Dict> => {
  const status = (await client.get(`/executions/${id}`)).status ?? null;
  if (status === "RUNNING") {
    return {
      execution_id: id,
      status,
      deleted: false,
      hint: "RUNNING executions cannot be deleted — stop_execution first, then delete.",
    };
  }
  await client.delete(`/executions/${id}`);
  return { execution_id: id, deleted: true };
});

export const deleteExecutions = safe(
  async ({ execution_ids: ids }: { execution_ids: number[] }): Promise<Dict> => {
    if (!ids.length) return { deleted: 0, hint: "No execution ids provided." };
    if (ids.length > MAX_DELETE_EXECUTIONS) {
      return { error: `execution_ids exceeds max ${MAX_DELETE_EXECUTIONS}.` };
    }
    await client.request("POST", "/executions/delete", { json: ids });
    return {
      deleted: ids.length,
      hint: "RUNNING executions in the list are skipped by the API.",
    };
  },
);

export const getExecutionPlaybook = safe(async ({ execution_id: id }: { execution_id: number }): Promise<Dict> => {
  const text = await client.getText(`/executions/${id}/playbook`);
  return {
    execution_id: id,
    yaml: shaping.clip(text, shaping.MAX_PLAYBOOK_CHARS),
    truncated: text.length > shaping.MAX_PLAYBOOK_CHARS,
  };
});

export interface GetExecutionOutputArgs {
  execution_id: number;
  test?: string | null;
  stream?: string;
  tail_lines?: number;
  offset_from_end?: number;
}

export const getExecutionOutput = safe(async (args: GetExecutionOutputArgs): Promise<Dict> => {
  const { execution_id: id, test, tail_lines: tail = 100, offset_from_end: offset = 0 } = args;
  let stream = args.stream ?? "stdout";
  const streams: readonly string[] = shaping.OUTPUT_STREAMS;
  if (!streams.includes(stream)) return oneOf("stream", [...streams]);

  const outputs = await deps.loadExecutionOutputs(id);
  if (!test) {
    return {
      execution_id: id,
      tests: shaping.outputIndex(outputs),
      hint: "Call again with `test` set to one of these paths to read its output.",
    };
  }

  const normalized = test.replace(/:/g, ".");
  let path = normalized;
  const dot = normalized.lastIndexOf(".");
  const suffix = dot === -1 ? normalized : normalized.slice(dot + 1);
  if (streams.includes(suffix)) {
    stream = suffix;
    path = dot === -1 ? "" : normalized.slice(0, dot);
  }
  const selected = runTestFilter(
    [path],
    outputs.map((o) => ({ ...o })),
  );
  if (!selected.length) {
    return { error: `No test matches ${pyRepr(test)}.`, tests: shaping.outputIndex(outputs) };
  }

  const picked = selected[0];
  const text = String((picked.output ?? {})[stream] || "");
  return { ...shaping.tailLines(text, tail, offset), execution_id: id, path: picked.path, stream };
});

export interface ListFindingsArgs {
  execution_id?: number | null;
  severity?: (number | string)[] | null;
  status?: string | null;
  source?: string | null;
  order?: string | null;
  quantity?: number;
  page?: number;
}

export const listFindings = safe(async (args: ListFindingsArgs = {}): Promise<Dict> => {
  const { page = 1 } = args;
  const status = args.status ? args.status.toUpperCase() : null;
  const source = args.source ? args.source.toUpperCase() : null;
  const order = args.order ? args.order.toUpperCase() : null;
  if (status && !FINDING_STATUSES.includes(status)) return oneOf("status", FINDING_STATUSES);
  if (source && !FINDING_SOURCES.includes(source)) return oneOf("source", FINDING_SOURCES);
  if (order && !ORDERS.includes(order)) return oneOf("order", ORDERS);
  let severities: number[] | null = null;
  if (args.severity && args.severity.length) {
    const normalized = normalizeSeverities(args.severity);
    if (typeof normalized === "string") return { error: normalized };
    severities = normalized;
  }
  const quantity = clamp(args.quantity ?? 25, 1, 25);
  const params: Dict = { quantity, page };
  if (args.execution_id !== null && args.execution_id !== undefined) params.execution_id = args.execution_id;
  if (severities && severities.length) params.severity = severities;
  if (status) params.status = status;
  if (source) params.source = source;
  if (order) params.order = order;
  const data = await client.get("/findings", params);
  return shaping.paged(data.items.map(shaping.summarizeFinding), data.total, page, quantity);
});

export const getFinding = safe(
  async ({ finding_id: id, include_timeline = true }: { finding_id: number; include_timeline?: boolean }) => {
    const result = shaping.detailFinding(await client.get(`/findings/${id}`));
    if (include_timeline) Object.assign(result, shaping.summarizeTimeline(await client.get(`/findings/${id}/timeline`)));
    return result;
  },
);

export const getFindingTimeline = safe(async ({ finding_id: id }: { finding_id: number }) =>
  shaping.summarizeTimeline(await client.get(`/findings/${id}/timeline`)),
);

export const updateFindingStatus = safe(
  async ({ finding_id: id, status, comment }: { finding_id: number; status: string; comment?: string | null }) => {
    status = status.toUpperCase();
    if (!FINDING_STATUSES.includes(status)) return oneOf("status", FINDING_STATUSES);
    if (comment !== null && comment !== undefined && comment.length > shaping.MAX_COMMENT_CHARS) {
      return { error: `comment exceeds ${shaping.MAX_COMMENT_CHARS} characters.` };
    }

    const updated = await client.patch(`/findings/${id}`, { status });
    const result: Dict = { id, status: updated.status ?? status };
    if (comment) {
      try {
        result.comment_id = (await client.post(`/findings/${id}/comments`, { body: comment })).id;
      } catch (e) {
        if (!(e instanceof HttpStatusError)) throw e;
        result.comment_error = shaping.clip(e.text, 500);
      }
    }
    return result;
  },
);

export interface UpdateFindingArgs {
  finding_id: number;
  status?: string | null;
  severity?: number | null;
  assignee_id?: number | null;
}

export const updateFinding = safe(async (args: UpdateFindingArgs): Promise<Dict> => {
  const { finding_id: id } = args;
  const body: Dict = {};

  if (args.status !== undefined && args.status !== null) {
    const status = args.status.toUpperCase();
    if (!FINDING_STATUSES.includes(status)) return oneOf("status", FINDING_STATUSES);
    body.status = status;
  }
  if (args.severity !== undefined) {
    if (args.severity !== null && (args.severity < 0 || args.severity > 5 || !Number.isInteger(args.severity))) {
      return { error: "severity must be an int 0-5, or null to clear." };
    }
    body.severity = args.severity;
  }
  if (args.assignee_id !== undefined) {
    if (args.assignee_id !== null && !Number.isInteger(args.assignee_id)) {
      return { error: "assignee_id must be an int, or null to clear." };
    }
    body.assignee_id = args.assignee_id;
  }
  if (!Object.keys(body).length) {
    return { error: "Provide at least one of status, severity or assignee_id." };
  }

  const updated = await client.patch(`/findings/${id}`, body);
  return shaping.detailFinding(updated);
});

export interface ListFindingEventsArgs {
  execution_id: number;
  quantity?: number;
  page?: number;
  order?: string | null;
}

export const listFindingEvents = safe(async (args: ListFindingEventsArgs): Promise<Dict> => {
  const { execution_id, page = 1 } = args;
  let order = args.order ? args.order.toUpperCase() : null;
  if (order && !ORDERS.includes(order)) return oneOf("order", ORDERS);
  const quantity = clamp(args.quantity ?? 25, 1, 25);
  const params: Dict = { execution_id, quantity, page };
  if (order) params.order = order;
  const data = await client.get("/findings/events", params);
  return shaping.paged(
    (data.items ?? []).map(shaping.summarizeFindingEvent),
    data.total,
    page,
    quantity,
  );
});

export const addFindingComment = safe(async ({ finding_id: id, body }: { finding_id: number; body: string }) => {
  if (!body || !body.trim()) return { error: "body must be a non-empty comment." };
  if (body.length > shaping.MAX_COMMENT_CHARS) {
    return { error: `comment exceeds ${shaping.MAX_COMMENT_CHARS} characters.` };
  }
  const comment = await client.post(`/findings/${id}/comments`, { body });
  return { finding_id: id, comment_id: comment.id };
});

export const editFindingComment = safe(
  async ({
    finding_id: id,
    comment_id,
    body,
  }: {
    finding_id: number;
    comment_id: number;
    body: string;
  }): Promise<Dict> => {
    if (!body || !body.trim()) return { error: "body must be a non-empty comment." };
    if (body.length > shaping.MAX_COMMENT_CHARS) {
      return { error: `comment exceeds ${shaping.MAX_COMMENT_CHARS} characters.` };
    }
    const comment = await client.patch(`/findings/${id}/comments/${comment_id}`, { body });
    return {
      finding_id: id,
      comment_id: comment.id ?? comment_id,
      edited_at: comment.edited_at ?? null,
    };
  },
);

export const deleteFindingComment = safe(
  async ({ finding_id: id, comment_id }: { finding_id: number; comment_id: number }): Promise<Dict> => {
    await client.delete(`/findings/${id}/comments/${comment_id}`);
    return { finding_id: id, comment_id, deleted: true };
  },
);

function shapeAiAnalysis(analysis: Dict): Dict {
  return shaping.summarizeAiAnalysis(analysis);
}

async function postFindingAiAnalysis(findingId: number, force: boolean): Promise<Dict> {
  const response = await client.request("POST", `/findings/${findingId}/ai-analysis`, {
    params: force ? { force: true } : undefined,
  });
  return response.json() as Promise<Dict>;
}

async function waitForFindingAiAnalysis(findingId: number, deadlineMs: number, initial?: Dict): Promise<Dict> {
  let analysis: Dict = initial ?? (await client.get(`/findings/${findingId}/ai-analysis`));
  while (analysis.status === "PENDING" && deps.now() < deadlineMs) {
    await deps.sleep(AI_ANALYSIS_POLL_MS);
    analysis = await client.get(`/findings/${findingId}/ai-analysis`);
  }
  return analysis;
}

/** Collect analysis rows for the given ids from the execution-scoped list (paginated). */
async function fetchExecutionAnalysesByIds(executionId: number, ids: Set<number>): Promise<Map<number, Dict>> {
  const found = new Map<number, Dict>();
  let page = 1;
  while (found.size < ids.size) {
    const data = await client.get("/findings/ai-analyses", {
      execution_id: executionId,
      quantity: 100,
      page,
      order: "DESC",
    });
    for (const item of data.items as Dict[]) {
      if (ids.has(item.id)) found.set(item.id, item);
    }
    const total = data.total ?? 0;
    if (!data.items.length || page * 100 >= total) break;
    page += 1;
  }
  return found;
}

async function waitForExecutionAiAnalyses(
  executionId: number,
  analysisIds: number[],
  deadlineMs: number,
  initial: Dict[],
): Promise<Dict[]> {
  const ids = new Set(analysisIds);
  let byId = new Map(initial.map((a) => [a.id as number, a]));
  const pending = () => [...byId.values()].some((a) => a.status === "PENDING" && ids.has(a.id));
  while (pending() && deps.now() < deadlineMs) {
    await deps.sleep(AI_ANALYSIS_POLL_MS);
    byId = await fetchExecutionAnalysesByIds(executionId, ids);
  }
  return analysisIds.map((id) => byId.get(id)).filter(Boolean) as Dict[];
}

export const getFindingAiAnalysis = safe(async ({ finding_id: id }: { finding_id: number }): Promise<Dict> => {
  try {
    return shapeAiAnalysis(await client.get(`/findings/${id}/ai-analysis`));
  } catch (e) {
    if (e instanceof HttpStatusError && e.status === 404) {
      return {
        error: shaping.clip(e.text, 2000),
        status: 404,
        hint: "No analysis yet. Call analyze_finding(finding_id) when the user asks to analyze.",
      };
    }
    throw e;
  }
});

export interface AnalyzeFindingArgs {
  finding_id: number;
  force?: boolean;
  wait?: boolean;
  wait_seconds?: number;
}

const _analyzeFinding = safe(async (args: AnalyzeFindingArgs): Promise<Dict> => {
  const { finding_id: id, force = false, wait = true, wait_seconds: waitSeconds = AI_ANALYSIS_DEFAULT_WAIT } = args;
  let analysis = await postFindingAiAnalysis(id, force);
  if (wait && analysis.status === "PENDING") {
    const deadline = deps.now() + clamp(waitSeconds, 0, AI_ANALYSIS_MAX_WAIT) * 1000;
    analysis = await waitForFindingAiAnalysis(id, deadline, analysis);
  }
  const result = shapeAiAnalysis(analysis);
  if (wait && analysis.status === "PENDING") {
    result.hint = `Still PENDING after ${waitSeconds}s. Call get_finding_ai_analysis(finding_id) later.`;
  }
  return result;
});

export const analyzeFinding = async (args: AnalyzeFindingArgs): Promise<Dict> =>
  withAi409Hint(await _analyzeFinding(args));

export interface AnalyzeExecutionArgs {
  execution_id: number;
  finding_ids?: number[] | null;
  force?: boolean;
  wait?: boolean;
  wait_seconds?: number;
}

const _analyzeExecution = safe(async (args: AnalyzeExecutionArgs): Promise<Dict> => {
  const {
    execution_id: executionId,
    finding_ids: findingIds,
    force = false,
    wait = true,
    wait_seconds: waitSeconds = AI_ANALYSIS_DEFAULT_WAIT,
  } = args;

  if (findingIds !== null && findingIds !== undefined) {
    if (!findingIds.length) return { error: "finding_ids must be non-empty when provided (or omit it)." };
    if (findingIds.length > MAX_AI_ANALYSIS_FINDING_IDS) {
      return { error: `At most ${MAX_AI_ANALYSIS_FINDING_IDS} findings can be queued at once.` };
    }
  }

  const body: Dict = { execution_id: executionId, force };
  if (findingIds !== null && findingIds !== undefined) body.finding_ids = findingIds;

  const batch = await client.post("/findings/ai-analysis", body);
  let items: Dict[] = batch.items ?? [];

  if (wait && items.some((a) => a.status === "PENDING")) {
    const deadline = deps.now() + clamp(waitSeconds, 0, AI_ANALYSIS_MAX_WAIT) * 1000;
    const ids = items.map((a) => a.id as number);
    items = await waitForExecutionAiAnalyses(executionId, ids, deadline, items);
  }

  const shaped = items.map(shapeAiAnalysis);
  const stillPending = items.some((a) => a.status === "PENDING");
  const result: Dict = {
    items: shaped,
    skipped: batch.skipped ?? [],
    omitted: batch.omitted ?? [],
  };
  if (wait && stillPending) {
    result.hint = `Some analyses still PENDING after ${waitSeconds}s. Call get_finding_ai_analysis per finding_id.`;
  } else if (shaped.some((a) => a.suggested_status)) {
    result.hint =
      "`suggested_status` is advisory only. Call update_finding_status only when the user asked to triage.";
  }
  return result;
});

export const analyzeExecution = async (args: AnalyzeExecutionArgs): Promise<Dict> =>
  withAi409Hint(await _analyzeExecution(args));

export interface ListJobsArgs {
  type?: string | null;
  visibility?: string | null;
  quantity?: number;
  page?: number;
}

export const listJobs = safe(async (args: ListJobsArgs = {}): Promise<Dict> => {
  const { type, page = 1 } = args;
  const visibility = args.visibility ? args.visibility.toUpperCase() : null;
  if (type && !LISTABLE_JOB_TYPES.includes(type)) return oneOf("type", LISTABLE_JOB_TYPES);
  if (visibility && !VISIBILITIES.includes(visibility)) return oneOf("visibility", VISIBILITIES);
  const quantity = clamp(args.quantity ?? 25, 1, 25);
  const params: Dict = { quantity, page, order: "DESC" };
  if (type) params.type = type;
  if (visibility) params.visibility = visibility;
  const data = await client.get("/jobs", params);
  return shaping.paged(data.items.map(shaping.summarizeJob), data.total, page, quantity);
});

export const getJob = safe(async ({ job_id: id }: { job_id: number }): Promise<Dict> => {
  const result = shaping.summarizeJob(await client.get(`/jobs/${id}`));
  const { items } = await client.get("/executions", { job_id: id, quantity: 5, order: "DESC" });
  result.executions = items.map((e: Dict) => shaping.summarizeExecutionRow(e, reportUrl(e.id)));
  return result;
});

export const deleteJob = safe(async ({ job_id: id }: { job_id: number }): Promise<Dict> => {
  const job = await client.get(`/jobs/${id}`);
  const status = job.status ?? null;
  if (!DELETABLE_JOB_STATUSES.includes(status)) {
    return {
      job_id: id,
      type: job.type ?? null,
      status,
      deleted: false,
      hint: "Job must be CANCELED or FINISHED before delete (stop_scan / stop_execution first if needed).",
    };
  }
  await client.delete(`/jobs/${id}`);
  return { job_id: id, type: job.type ?? null, deleted: true };
});

export interface ScanRepositoryArgs extends PlaybookSourceArgs {
  repository: string;
  parameters?: Record<string, string[]> | null;
  secrets?: Record<string, string> | null;
  regions?: string[] | null;
  quantity?: number;
}

export const scanRepository = safe(async (args: ScanRepositoryArgs): Promise<Dict> => {
  const repository = args.repository || "";
  const wildcard = repository.endsWith("/*") && Boolean(wildcardOwner(repository));
  if (!wildcard && !isGithubRepo(repository)) return { error: "repository must be 'owner/repo' or 'owner/*'." };
  const provided = [args.playbook_path, args.playbook_yaml, args.playbook_uri].filter(Boolean).length;
  if (provided > 1) return { error: "Provide at most one of playbook_path, playbook_yaml or playbook_uri." };
  const source =
    provided === 1 ? await bundleSource(args.playbook_path, args.playbook_yaml, args.playbook_uri) : null;
  const quantity = wildcard ? 1 : clamp(args.quantity ?? 1, 1, MAX_SCAN_QUANTITY);
  const body: Dict = {
    parameters: args.parameters || {},
    secrets: args.secrets || {},
    regions: args.regions || [],
    repository_data: { repository },
    criteria: { quantity },
    visibility: "PRIVATE",
  };
  if (source !== null) body.playbook_source = source;
  const scan = await client.post("/jobs/scans", body);
  return {
    job_id: scan.id,
    status: scan.status ?? null,
    repository,
    playbook_source: scan.playbook_source || source,
    hint: "Call get_job(job_id) to follow progress and see its executions.",
  };
});

type VisibilityPageArgs = { visibility?: string | null; quantity?: number; page?: number };

export const listScans = safe(async (args: VisibilityPageArgs = {}) => listJobs({ ...args, type: "SCAN" }));

async function requireJobType(id: number, type: string): Promise<Dict | { error: string }> {
  const job = await client.get(`/jobs/${id}`);
  if (job.type !== type) return { error: `Job ${id} is type ${job.type ?? "unknown"}, not ${type}.` };
  return job;
}

async function requireScan(id: number): Promise<Dict | { error: string }> {
  return requireJobType(id, "SCAN");
}

async function requireMonitor(id: number): Promise<Dict | { error: string }> {
  return requireJobType(id, "MONITOR");
}

/** Page all executions for a job and bulk-delete non-RUNNING ones. Returns how many ids were sent. */
async function cleanJobExecutions(jobId: number): Promise<number> {
  const executionIds: number[] = [];
  let page = 1;
  while (true) {
    const data = await client.get("/executions", { job_id: jobId, quantity: 100, page });
    const items: Dict[] = data.items ?? [];
    if (!items.length) break;
    executionIds.push(...items.map((item) => item.id as number));
    if (executionIds.length >= (data.total ?? 0)) break;
    page += 1;
  }
  if (executionIds.length) {
    await client.request("POST", "/executions/delete", { json: executionIds });
  }
  return executionIds.length;
}

export const stopScan = safe(async ({ scan_id: id }: { scan_id: number }): Promise<Dict> => {
  const job = await requireScan(id);
  if ("error" in job) return job;
  const status = job.status ?? null;
  if (status === "CANCELED" || status === "FINISHED") {
    return {
      scan_id: id,
      status,
      stopped: false,
      hint: "Scan is already terminal; only non-finished scans can be stopped.",
    };
  }
  await client.patch(`/jobs/scans/${id}`, { status: "CANCELED" });
  return {
    scan_id: id,
    stopped: true,
    hint: "Stop cancels the scan job (no new executions). In-flight RUNNING ones keep going — use stop_execution per id for a hard stop. Call get_job to confirm.",
  };
});

export const pauseScan = safe(async ({ scan_id: id }: { scan_id: number }): Promise<Dict> => {
  const job = await requireScan(id);
  if ("error" in job) return job;
  const status = job.status ?? null;
  if (status !== "RUNNING") {
    return {
      scan_id: id,
      status,
      paused: false,
      hint: "Only RUNNING scans can be paused.",
    };
  }
  await client.patch(`/jobs/scans/${id}`, { status: "PAUSED" });
  return {
    scan_id: id,
    paused: true,
    hint: "Scan paused (no new executions). Call resume_scan to continue, or get_job to confirm.",
  };
});

export const resumeScan = safe(async ({ scan_id: id }: { scan_id: number }): Promise<Dict> => {
  const job = await requireScan(id);
  if ("error" in job) return job;
  const status = job.status ?? null;
  if (status !== "PAUSED") {
    return {
      scan_id: id,
      status,
      resumed: false,
      hint: "Only PAUSED scans can be resumed.",
    };
  }
  await client.patch(`/jobs/scans/${id}`, { status: "RUNNING" });
  return {
    scan_id: id,
    resumed: true,
    hint: "Scan resumed. Call get_job to follow progress.",
  };
});

export const cleanScan = safe(async ({ scan_id: id }: { scan_id: number }): Promise<Dict> => {
  const job = await requireScan(id);
  if ("error" in job) return job;
  const deleted = await cleanJobExecutions(id);
  return {
    scan_id: id,
    deleted,
    hint: "Deleted non-RUNNING reports for this scan (RUNNING ones are skipped by the API). The scan job itself remains — use stop_scan / delete_job if you want to stop or remove it.",
  };
});

export const listMonitors = safe(async (args: VisibilityPageArgs = {}) => listJobs({ ...args, type: "MONITOR" }));

export const cleanMonitor = safe(async ({ monitor_id: id }: { monitor_id: number }): Promise<Dict> => {
  const job = await requireMonitor(id);
  if ("error" in job) return job;
  const deleted = await cleanJobExecutions(id);
  return {
    monitor_id: id,
    deleted,
    hint: "Deleted non-RUNNING reports for this monitor (RUNNING ones are skipped by the API). The monitor job itself remains — use delete_job after it is CANCELED or FINISHED.",
  };
});

export interface ListPlaybooksArgs {
  q?: string | null;
  category?: string | null;
  quantity?: number;
  page?: number;
}

export const listPlaybooks = safe(async (args: ListPlaybooksArgs = {}): Promise<Dict> => {
  const { q, category, page = 1 } = args;
  const quantity = clamp(args.quantity ?? 25, 1, 25);
  const catalog: Dict[] = (await playbooksClient.get("/playbooks")).playbooks;
  const needle = q ? q.toLowerCase() : null;
  const matches = catalog.filter(
    (p) =>
      (!category || String(p.category ?? "").toLowerCase() === category.toLowerCase()) &&
      (!needle ||
        ["id", "name", "description"]
          .map((k) => String(p[k] ?? ""))
          .join(" ")
          .toLowerCase()
          .includes(needle)),
  );
  const start = (page - 1) * quantity;
  return shaping.paged(
    matches.slice(start, start + quantity).map(shaping.summarizeCatalogPlaybook),
    matches.length,
    page,
    quantity,
  );
});

export const getPlaybook = safe(async ({ playbook_uri: uri }: { playbook_uri: string }): Promise<Dict> => {
  const id = uri.startsWith("satori://") ? uri.slice("satori://".length) : uri;
  const data = await playbooksClient.get(`/playbooks/${id}`);
  const result = shaping.summarizeCatalogPlaybook(data);
  const content: string = data.content || "";
  result.image = data.image ?? null;
  result.example = data.example ?? null;
  result.yaml = shaping.clip(content, shaping.MAX_PLAYBOOK_CHARS);
  result.truncated = content.length > shaping.MAX_PLAYBOOK_CHARS;
  return result;
});

export const PUBLISH_ADVISORY_TIMEOUT_MS = 30_000;

export interface ListAdvisoriesArgs {
  execution_id?: number | null;
  finding_id?: number | null;
  kind?: string | null;
  provider?: string | null;
  order?: string | null;
  quantity?: number;
  page?: number;
}

export const listAdvisories = safe(async (args: ListAdvisoriesArgs = {}): Promise<Dict> => {
  const { page = 1 } = args;
  const kind = args.kind ? args.kind.toUpperCase() : null;
  const provider = args.provider ? args.provider.toUpperCase() : null;
  const order = args.order ? args.order.toUpperCase() : null;
  if (kind && !ADVISORY_KINDS.includes(kind)) return oneOf("kind", ADVISORY_KINDS);
  if (provider && !ADVISORY_PROVIDERS.includes(provider)) return oneOf("provider", ADVISORY_PROVIDERS);
  if (order && !ORDERS.includes(order)) return oneOf("order", ORDERS);
  const quantity = clamp(args.quantity ?? 25, 1, 25);
  const params: Dict = { quantity, page };
  const optional: Dict = {
    execution_id: args.execution_id,
    finding_id: args.finding_id,
    kind,
    provider,
    order,
  };
  for (const [k, v] of Object.entries(optional)) if (v !== null && v !== undefined) params[k] = v;
  const data = await client.get("/external_issues", params);
  return shaping.paged(data.items.map(shaping.summarizeAdvisory), data.total, page, quantity);
});

function shapeAdvisoryDetail(advisory: Dict): Dict {
  const id = advisory.id as number | null | undefined;
  return shaping.detailAdvisory(advisory, id != null ? advisoryUrl(id) : null);
}

async function findSecurityAdvisoryForFinding(findingId: number): Promise<Dict | null> {
  const data = await client.get("/external_issues", {
    finding_id: findingId,
    kind: "SECURITY_ADVISORY",
    quantity: 1,
  });
  return data.items?.[0] ?? null;
}

export const getAdvisory = safe(async ({ advisory_id: id }: { advisory_id: number }): Promise<Dict> =>
  shapeAdvisoryDetail(await client.get(`/external_issues/${id}`)),
);

export interface CreateSecurityAdvisoryArgs {
  finding_id: number;
  visibility?: string | null;
}

export const createSecurityAdvisory = safe(async (args: CreateSecurityAdvisoryArgs): Promise<Dict> => {
  const { finding_id: findingId } = args;
  const visibility = args.visibility ? args.visibility.toUpperCase() : null;
  if (visibility && !VISIBILITIES.includes(visibility)) return oneOf("visibility", VISIBILITIES);

  const body: Dict = { finding_id: findingId };
  if (visibility) body.visibility = visibility;

  let advisory: Dict;
  let existed = false;
  try {
    advisory = await client.post("/external_issues/security_advisory", body);
  } catch (e) {
    if (!(e instanceof HttpStatusError) || e.status !== 409) throw e;
    const existing = await findSecurityAdvisoryForFinding(findingId);
    if (!existing) {
      return { error: shaping.clip(e.text, 2000), status: 409 };
    }
    advisory = existing;
    existed = true;
  }

  const result = shapeAdvisoryDetail(advisory);
  if (existed) {
    result.hint = "A security advisory already exists for this finding; returning the existing one.";
  } else if (!advisory.external_id) {
    result.hint =
      "Draft created (not on GitHub yet). Call publish_security_advisory(finding_id) only when the user asks to publish.";
  }
  return result;
});

export const publishSecurityAdvisory = safe(async ({ finding_id: findingId }: { finding_id: number }): Promise<Dict> => {
  try {
    const response = await client.request("POST", "/external_issues/security_advisory/publish", {
      json: { finding_id: findingId },
      timeoutMs: PUBLISH_ADVISORY_TIMEOUT_MS,
    });
    const advisory = (await response.json()) as Dict;
    const result = shapeAdvisoryDetail(advisory);
    if (advisory.external_url) {
      result.hint = "Published to GitHub. external_url is the remote advisory link.";
    }
    return result;
  } catch (e) {
    const result = errorResult(e);
    if (result === null) throw e;
    if (result.status === 409) result.hint = PUBLISH_ADVISORY_409_HINT;
    return result;
  }
});

export const getAdvisoryStatus = safe(async ({ advisory_id: id }: { advisory_id: number }): Promise<Dict> => {
  const data = await client.get(`/external_issues/${id}/status`);
  return { advisory_id: id, status: data.status ?? null };
});

export const updateAdvisoryVisibility = safe(
  async ({ advisory_id: id, visibility }: { advisory_id: number; visibility: string }): Promise<Dict> => {
    visibility = visibility.toUpperCase();
    if (!VISIBILITIES.includes(visibility)) return oneOf("visibility", VISIBILITIES);
    // API returns 200 with an empty body.
    await client.request("PATCH", `/external_issues/${id}`, { json: { visibility } });
    return { id, visibility };
  },
);

export const deleteSecurityAdvisory = safe(
  async ({ finding_id: findingId }: { finding_id: number }): Promise<Dict> => {
    const response = await client.request("DELETE", "/external_issues/security_advisory", {
      json: { finding_id: findingId },
    });
    let warning: string | null = null;
    const text = await response.text();
    if (text) {
      try {
        const data = JSON.parse(text) as Dict;
        if (data.warning) warning = String(data.warning);
      } catch {
        // Empty or non-JSON body is fine.
      }
    }
    const result: Dict = { finding_id: findingId, deleted: true };
    if (warning) {
      result.warning = warning;
      result.hint = "Local advisory deleted; closing on GitHub may have failed — see warning.";
    }
    return result;
  },
);

export const listRepos = safe(async (args: { order?: string | null; quantity?: number; page?: number } = {}) => {
  const { page = 1 } = args;
  const order = args.order ? args.order.toUpperCase() : null;
  if (order && !ORDERS.includes(order)) return oneOf("order", ORDERS);
  const quantity = clamp(args.quantity ?? 50, 1, 50);
  const params: Dict = { quantity, page };
  if (order) params.order = order;
  const data = await client.get("/repos", params);
  return shaping.paged(data.items.map(shaping.summarizeRepo), data.total, page, quantity);
});

/** `repository` ("owner/repo") scopes saved inputs to that repository's runs and scans. */
const savedScope = (repository?: string | null): Dict => (repository ? { repository } : {});
const savedPath = (kind: "parameters" | "secrets", name: string) =>
  `/settings/${kind}/${encodeURIComponent(name)}`;

export const listSavedInputs = safe(async ({ repository }: { repository?: string | null } = {}): Promise<Dict> => {
  const params = savedScope(repository);
  const [parameters, secrets] = await Promise.all([
    client.get<Dict[]>("/settings/parameters", params),
    client.get<Dict[]>("/settings/secrets", params),
  ]);
  return {
    repository: repository ?? null,
    parameters: parameters.map((p) => ({ name: p.name, values: p.values })),
    secrets: secrets.map((s) => ({ name: s.name, created_at: s.created_at })),
  };
});

export const saveParameter = safe(
  async ({ name, values, repository }: { name: string; values: string[]; repository?: string | null }) => {
    const saved = await client.put(savedPath("parameters", name), { values }, savedScope(repository));
    return { ...saved, repository: repository ?? null };
  },
);

export const deleteParameter = safe(async ({ name, repository }: { name: string; repository?: string | null }) => {
  await client.delete(savedPath("parameters", name), savedScope(repository));
  return { deleted: name, repository: repository ?? null };
});

export const saveSecret = safe(
  async ({ name, value, repository }: { name: string; value: string; repository?: string | null }) => {
    const saved = await client.put(savedPath("secrets", name), { value }, savedScope(repository));
    return { name: saved.name, created_at: saved.created_at, repository: repository ?? null };
  },
);

export const deleteSecret = safe(async ({ name, repository }: { name: string; repository?: string | null }) => {
  await client.delete(savedPath("secrets", name), savedScope(repository));
  return { deleted: name, repository: repository ?? null };
});

export const SSH_EXEC_MAX_TIMEOUT = 3600;
/** Margin over the command timeout for connecting and returning the result. */
const SSH_EXEC_GRACE_MS = 30_000;
/** How long exec_in_session waits for READY+host before giving up. */
export const SSH_EXEC_READY_WAIT_MS = 120_000;
/** Lifetime of the JWT from GET /executions/{id}/ssh. */
const SSH_TOKEN_TTL_SECONDS = 300;

export interface CreateSshSessionArgs {
  cpu?: number | null;
  memory?: number | null;
  storage?: number | null;
  image?: string | null;
  os?: string | null;
  environment_variables?: Record<string, string> | null;
  regions?: string[] | null;
  timeout?: number | null;
  save_files?: boolean;
  wait?: boolean;
  wait_seconds?: number;
}

export const createSshSession = safe(async (args: CreateSshSessionArgs = {}): Promise<Dict> => {
  const { wait = true, wait_seconds: waitSeconds = 300 } = args;
  const settings: Dict = {
    cpu: args.cpu,
    memory: args.memory,
    storage: args.storage,
    image: args.image,
    os: args.os,
    environment_variables: args.environment_variables,
  };
  const containerSettings = Object.fromEntries(
    Object.entries(settings).filter(([, v]) => v !== null && v !== undefined),
  );
  const body: Dict = { save_files: args.save_files ?? false };
  if (Object.keys(containerSettings).length) body.container_settings = containerSettings;
  if (args.regions?.length) body.regions = args.regions;
  if (args.timeout !== null && args.timeout !== undefined) body.timeout = args.timeout;

  let session = await client.post("/ssh_sessions", body);
  if (wait) {
    session = await waitForSshSession(session.id, deps.now() + clamp(waitSeconds, 0, 600) * 1000, session);
  }
  return sshSessionResult(session);
});

/** READY only means the task was launched; commands work once the task's host is known. */
const sshSessionStarting = (session: Dict) =>
  session.status === "PREPARING" || (session.status === "READY" && !session.host);

const sshSessionReady = (session: Dict) => session.status === "READY" && Boolean(session.host);

/** Poll until the session has a host, finishes, or the deadline passes. */
async function waitForSshSession(id: number, deadlineMs: number, initial?: Dict): Promise<Dict> {
  let session: Dict = initial ?? (await client.get<Dict>(`/ssh_sessions/${id}`));
  while (sshSessionStarting(session) && deps.now() < deadlineMs) {
    await deps.sleep(2000);
    session = await client.get<Dict>(`/ssh_sessions/${id}`);
  }
  return session;
}

function sshSessionNotReadyResult(id: number, session: Dict): Dict {
  return {
    session_id: id,
    error: "SSH session still starting (no host yet)",
    status: session.status ?? null,
    host: session.host ?? null,
    hint: "Call get_ssh_session later, then retry exec_in_session.",
  };
}

function isSshNotReadyError(e: HttpStatusError): boolean {
  if (e.status !== 503) return false;
  const text = e.text.toLowerCase();
  return text.includes("ssh host unavailable") || text.includes("session not ready");
}

function sshSessionResult(session: Dict): Dict {
  const result = shaping.summarizeSshSession(session);
  if (sshSessionStarting(session)) {
    result.hint = "Still starting (no host yet; this can take a few minutes). Call get_ssh_session(session_id) later.";
  } else if (session.status === "READY") {
    result.hint = "Run commands with exec_in_session(session_id, command). Call stop_ssh_session when done.";
  }
  return result;
}

export const getSshSession = safe(async ({ session_id: id }: { session_id: number }): Promise<Dict> =>
  sshSessionResult(await client.get(`/ssh_sessions/${id}`)),
);

export const listSshSessions = safe(async ({ quantity = 10, page = 1 }: { quantity?: number; page?: number } = {}) => {
  quantity = clamp(quantity, 1, 25);
  const data = await client.get("/ssh_sessions", { quantity, page });
  return shaping.paged(data.items.map(shaping.summarizeSshSession), data.total, page, quantity);
});

export interface ExecInSessionArgs {
  session_id: number;
  command: string;
  timeout?: number;
}

export const execInSession = safe(async (args: ExecInSessionArgs): Promise<Dict> => {
  const { session_id: id, command } = args;
  const timeout = clamp(args.timeout ?? 60, 1, SSH_EXEC_MAX_TIMEOUT);

  const session = await waitForSshSession(id, deps.now() + SSH_EXEC_READY_WAIT_MS);
  if (!sshSessionReady(session)) return sshSessionNotReadyResult(id, session);

  try {
    // The API streams keepalive spaces before the JSON result; JSON parsing skips them.
    const response = await client.request("POST", `/ssh_sessions/${id}/exec`, {
      json: { command, timeout },
      timeoutMs: timeout * 1000 + SSH_EXEC_GRACE_MS,
    });
    const result = (await response.json()) as Dict;
    // Failures after the stream started still arrive as HTTP 200.
    if (result.error) return { session_id: id, error: shaping.clip(result.error, 2000) };
    return {
      session_id: id,
      return_code: result.return_code ?? null,
      stdout: shaping.clip(result.stdout ?? "", shaping.MAX_OUTPUT_CHARS),
      stderr: shaping.clip(result.stderr ?? "", shaping.MAX_OUTPUT_CHARS),
      timed_out: result.timed_out ?? false,
      truncated:
        Boolean(result.truncated) ||
        String(result.stdout ?? "").length > shaping.MAX_OUTPUT_CHARS ||
        String(result.stderr ?? "").length > shaping.MAX_OUTPUT_CHARS,
      duration: result.duration ?? null,
    };
  } catch (e) {
    if (e instanceof HttpStatusError && isSshNotReadyError(e)) {
      return sshSessionNotReadyResult(id, session);
    }
    throw e;
  }
});

export const stopSshSession = safe(async ({ session_id: id }: { session_id: number }): Promise<Dict> => {
  try {
    // 202 with an empty body, so no .json().
    await client.request("POST", `/ssh_sessions/${id}/stop`);
  } catch (e) {
    if (e instanceof HttpStatusError && e.status === 409) {
      return { session_id: id, status: "FINISHED", stopped: false, hint: "The session already finished." };
    }
    throw e;
  }
  return { session_id: id, stopped: true, hint: "Stopping is asynchronous; call get_ssh_session to confirm FINISHED." };
});

export const sshIntoExecution = safe(async ({ execution_id: id }: { execution_id: number }): Promise<Dict> => {
  const { host, token } = await client.get(`/executions/${id}/ssh`);
  return {
    execution_id: id,
    host,
    username: "root",
    password: token,
    expires_in_seconds: SSH_TOKEN_TTL_SECONDS,
    hint:
      "Short-lived SSH credentials for an interactive shell; the MCP cannot host a TTY. " +
      `Have the user run: satori-v2 shell ${id}`,
  };
});

export async function fetchDoc(name: string): Promise<string> {
  const url = `${DOCS_URL}/${DOC_PAGES[name]}.md`;
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return shaping.clip(await res.text(), DOC_MAX_CHARS);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return `Could not fetch ${url} (${reason}). Docs source: satori-docs/satori_help/docs/${DOC_PAGES[name]}.md`;
  }
}

export function writeAndRunPlaybookPrompt(goal: string): string {
  return (
    `Goal: ${goal}\n\n` +
    "1. Read the satori-docs://playbooks/language resource (and asserts if needed).\n" +
    "2. If the playbook runs a security/analysis tool, read " +
    "satori-docs://playbooks/tool-output and prefer that tool's JSON/JSONL flags " +
    "over human-readable defaults.\n" +
    "3. Write the playbook YAML.\n" +
    "4. Call run_playbook with playbook_yaml (a validation error is returned verbatim; fix and retry).\n" +
    "5. Call get_execution; if there are failures, call get_execution_output with a `test` " +
    "filter (never request full logs) and list_findings(execution_id=...).\n" +
    "6. Summarize the result and include the report_url."
  );
}
