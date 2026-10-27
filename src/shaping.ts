/**
 * Pure helpers that cap and summarize API payloads for MCP responses.
 *
 * Agents have a small context window, so every tool response goes through one of these.
 */
import { pyRepr, splitLines } from "./pyrepr.js";

type Dict = Record<string, any>;

export const MAX_TESTS = 50;
export const MAX_ASSERTS_PER_TEST = 10;
export const MAX_FIELD_CHARS = 500;
export const MAX_OUTPUT_TAIL_LINES = 500;
export const MAX_OUTPUT_CHARS = 20_000;
export const MAX_SNAPSHOT_CHARS = 4_000;
export const MAX_PLAYBOOK_CHARS = 20_000;
export const MAX_TIMELINE_ITEMS = 20;
export const MAX_COMMENT_CHARS = 2_000;
export const MAX_AI_FIX_STEPS = 10;
export const MAX_ADVISORY_DESCRIPTION_CHARS = 4_000;
export const OUTPUT_STREAMS = ["stdout", "stderr", "os_error"] as const;

export function clip(value: unknown, limit: number = MAX_FIELD_CHARS): any {
  if (typeof value === "string" && value.length > limit) {
    return `${value.slice(0, limit)}... [${value.length - limit} chars truncated]`;
  }
  if (value instanceof Uint8Array) return clip(new TextDecoder().decode(value), limit);
  return value;
}

export function clipDeep(value: unknown, limit: number = MAX_FIELD_CHARS): any {
  if (Array.isArray(value)) return value.slice(0, MAX_ASSERTS_PER_TEST).map((v) => clipDeep(v, limit));
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipDeep(v, limit)]));
  }
  return clip(value, limit);
}

const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);

/** Status plus assertion results, never raw logs. */
export function summarizeExecution(execution: Dict, reportUrl: string | null = null): Dict {
  const report: Dict = execution.report || {};
  const detail: unknown[] = report.detail || [];

  const tests: Dict[] = [];
  for (const item of detail.slice(0, MAX_TESTS)) {
    if (!isDict(item)) continue;
    tests.push(
      Object.fromEntries(
        Object.entries(item)
          .filter(([k]) => !["output", "stdout", "stderr"].includes(k))
          .map(([k, v]) => [k, clipDeep(v)]),
      ),
    );
  }

  const summary: Dict = {
    id: execution.id ?? null,
    status: execution.status ?? null,
    created_at: execution.created_at ?? null,
    job_id: execution.job_id ?? null,
    total_fails: report.total_fails ?? null,
    severities: report.severities ?? null,
    tests,
    tests_total: detail.length,
    truncated: detail.length > MAX_TESTS,
    report_url: reportUrl,
  };
  if (Object.keys(report).length === 0) {
    summary.hint = "No report yet; the execution may still be running.";
  } else if (summary.truncated) {
    summary.hint =
      `Only the first ${MAX_TESTS} tests are shown. ` +
      "Use list_findings(execution_id=...) for the failures.";
  }
  return summary;
}

/** One line per execution for list results: no tests, no data blob. */
export function summarizeExecutionRow(execution: Dict, reportUrl: string | null = null): Dict {
  const report: Dict = execution.report || {};
  const job: Dict = execution.job || {};
  return {
    id: execution.id ?? null,
    status: execution.status ?? null,
    created_at: execution.created_at ?? null,
    job_id: execution.job_id ?? null,
    job_type: job.type ?? null,
    total_fails: report.total_fails ?? null,
    report_url: reportUrl,
  };
}

/** One entry per test with line counts per stream, no content. */
export function outputIndex(outputs: Dict[]): Dict[] {
  return outputs.map((test) => {
    const out: Dict = test.output || {};
    const entry: Dict = { path: test.path ?? null };
    for (const stream of OUTPUT_STREAMS) {
      if (out[stream]) entry[`${stream}_lines`] = splitLines(String(out[stream])).length;
    }
    return entry;
  });
}

/** Return `tail` lines ending `offsetFromEnd` lines before the end of `text`. */
export function tailLines(
  text: string,
  tail: number,
  offsetFromEnd = 0,
  maxChars: number = MAX_OUTPUT_CHARS,
): Dict {
  tail = Math.max(1, Math.min(tail, MAX_OUTPUT_TAIL_LINES));
  offsetFromEnd = Math.max(0, offsetFromEnd);

  const lines = splitLines(text);
  const total = lines.length;
  const end = Math.max(total - offsetFromEnd, 0);
  let start = Math.max(end - tail, 0);
  let chunk = lines.slice(start, end).join("\n");

  let truncatedChars = false;
  if (chunk.length > maxChars) {
    // Keep the end of the chunk (most recent lines) and report how many lines survived.
    chunk = chunk.slice(-maxChars);
    if (chunk.includes("\n")) chunk = chunk.slice(chunk.indexOf("\n") + 1);
    truncatedChars = true;
    start = end - splitLines(chunk).length;
  }

  const shown = end - start;
  const nextOffset = offsetFromEnd + shown;
  const result: Dict = {
    text: chunk,
    total_lines: total,
    shown_lines: shown,
    next_offset_from_end: start > 0 ? nextOffset : null,
    truncated: start > 0 || truncatedChars,
  };
  if (start > 0) {
    result.hint =
      `${start} earlier lines not shown. ` +
      `Call again with offset_from_end=${nextOffset} for the previous page.`;
  }
  return result;
}

export function summarizeFinding(finding: Dict): Dict {
  return {
    id: finding.id ?? null,
    title: clip(finding.title ?? null),
    severity: finding.severity ?? null,
    status: finding.status ?? null,
    source: finding.source ?? null,
    execution_id: finding.execution_id ?? null,
    assignee_id: finding.assignee_id ?? null,
    location: clipDeep(finding.identity || {}),
  };
}

export function detailFinding(finding: Dict): Dict {
  const result = summarizeFinding(finding);
  result.created_at = finding.created_at ?? null;
  const snapshot = finding.snapshot;
  if (snapshot !== undefined && snapshot !== null) {
    const text = typeof snapshot === "string" ? snapshot : pyRepr(snapshot);
    result.snapshot = clip(text, MAX_SNAPSHOT_CHARS);
  }
  return result;
}

/** One row from GET /findings/events (no comments — those are on the per-finding timeline). */
export function summarizeFindingEvent(item: Dict): Dict {
  const entry: Dict = {
    kind: item.kind ?? "event",
    id: item.id ?? null,
    created_at: item.created_at ?? null,
    finding_id: item.finding_id ?? null,
    type: item.type ?? null,
    payload: clipDeep(item.payload ?? null),
  };
  if (item.display_name !== undefined && item.display_name !== null) {
    entry.display_name = item.display_name;
  }
  return entry;
}

/** AI analysis row: clipped text, capped fix steps, only useful `data` fields. */
export function summarizeAiAnalysis(analysis: Dict): Dict {
  const rawData = isDict(analysis.data) ? analysis.data : {};
  const data: Dict = {};
  if (rawData.provider !== undefined) data.provider = rawData.provider;
  if (rawData.usage !== undefined) data.usage = rawData.usage;
  if (rawData.cost !== undefined) data.cost = rawData.cost;
  if (rawData.error !== undefined) data.error = clip(rawData.error, 500);

  const steps = Array.isArray(analysis.fix_steps) ? analysis.fix_steps : [];
  const result: Dict = {
    id: analysis.id ?? null,
    finding_id: analysis.finding_id ?? null,
    model: analysis.model ?? null,
    status: analysis.status ?? null,
    risk: analysis.risk ?? null,
    false_positive_likelihood: analysis.false_positive_likelihood ?? null,
    suggested_status: analysis.suggested_status ?? null,
    summary: clip(analysis.summary ?? null),
    root_cause: clip(analysis.root_cause ?? null),
    fix_steps: steps.slice(0, MAX_AI_FIX_STEPS).map((s) => clip(s)),
    data,
  };
  if (steps.length > MAX_AI_FIX_STEPS) result.fix_steps_truncated = true;

  if (analysis.status === "COMPLETED" && analysis.suggested_status) {
    result.hint =
      "`suggested_status` is advisory only. Call update_finding_status only when the user asked to triage.";
  } else if (analysis.status === "PENDING") {
    result.hint = "Still pending. Call get_finding_ai_analysis(finding_id) later.";
  }
  return result;
}

export function summarizeRepo(repo: Dict): Dict {
  const last: Dict = repo.last_execution || {};
  return {
    full_name: repo.full_name ?? null,
    private: repo.private ?? null,
    last_execution:
      Object.keys(last).length > 0
        ? {
            execution_id: last.execution_id ?? null,
            status: last.status ?? null,
            total_fails: last.total_fails ?? null,
          }
        : null,
  };
}

export function paged(items: unknown[], total: number | null | undefined, page: number, quantity: number): Dict {
  const result: Dict = { items, total: total ?? null, page };
  if (total !== null && total !== undefined && page * quantity < total) result.next_page = page + 1;
  return result;
}

export function summarizeJob(job: Dict): Dict {
  return {
    id: job.id ?? null,
    type: job.type ?? null,
    status: job.status ?? null,
    playbook_source: clip(job.playbook_source ?? null),
    repository: job.repository ?? null,
    expression: job.expression ?? null,
    visibility: job.visibility ?? null,
    tags: job.tags ?? null,
    created_at: job.created_at ?? null,
    finished_at: job.finished_at ?? null,
    expires_at: job.expires_at ?? null,
  };
}

/** SSH session without its SSH token: exec_in_session never needs it. */
export function summarizeSshSession(session: Dict): Dict {
  return {
    id: session.id ?? null,
    status: session.status ?? null,
    region: session.region ?? null,
    regions: session.regions ?? null,
    host: session.host ?? null,
    container_settings: session.container_settings ?? null,
    timeout: session.timeout ?? null,
    save_files: session.save_files ?? null,
    created_at: session.created_at ?? null,
    finished_at: session.finished_at ?? null,
  };
}

/** Last MAX_TIMELINE_ITEMS entries (comments and events), clipped. */
export function summarizeTimeline(items: Dict[]): Dict {
  const shaped = items.slice(-MAX_TIMELINE_ITEMS).map((item) => {
    const entry: Dict = {
      kind: item.kind ?? null,
      created_at: item.created_at ?? null,
      by: item.display_name ?? null,
    };
    if (item.kind === "comment") {
      entry.body = clip(item.body ?? null);
    } else {
      entry.type = item.type ?? null;
      entry.payload = clipDeep(item.payload ?? null);
    }
    return entry;
  });
  return {
    timeline: shaped,
    timeline_total: items.length,
    timeline_truncated: items.length > MAX_TIMELINE_ITEMS,
  };
}

export function summarizeCatalogPlaybook(playbook: Dict): Dict {
  return {
    uri: playbook.uri ?? null,
    name: clip(playbook.name ?? null, 200),
    category: playbook.category ?? null,
    description: clip(playbook.description ?? null, 300),
    parameters: playbook.parameters ?? null,
  };
}

/** List row: no description or vulnerabilities (they can be long). */
export function summarizeAdvisory(advisory: Dict): Dict {
  return {
    id: advisory.id ?? null,
    kind: advisory.kind ?? null,
    provider: advisory.provider ?? null,
    title: clip(advisory.title ?? null, 200),
    severity: advisory.severity ?? null,
    repository: advisory.repository ?? null,
    visibility: advisory.visibility ?? null,
    external_id: advisory.external_id ?? null,
    external_url: advisory.external_url ?? null,
    finding_id: advisory.finding_id ?? null,
    execution_id: advisory.execution_id ?? null,
    created_at: advisory.created_at ?? null,
  };
}

/** Full advisory: clipped description and vulnerabilities. */
export function detailAdvisory(advisory: Dict, advisoryUrl: string | null = null): Dict {
  const result = summarizeAdvisory(advisory);
  result.description = clip(advisory.description ?? null, MAX_ADVISORY_DESCRIPTION_CHARS);
  if (advisory.vulnerabilities !== undefined && advisory.vulnerabilities !== null) {
    result.vulnerabilities = clipDeep(advisory.vulnerabilities, MAX_FIELD_CHARS);
  }
  if (advisoryUrl) result.advisory_url = advisoryUrl;
  return result;
}
