import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client, playbooksClient } from "../src/api.js";
import { BundleCache } from "../src/bundle.js";
import { HttpStatusError } from "../src/errors.js";
import * as shaping from "../src/shaping.js";
import * as tools from "../src/tools.js";

type Handler = (url: string, arg?: any) => any;

function mockClient(method: "get" | "post" | "patch" | "getText" | "postForm" | "request", handler: Handler) {
  return vi.spyOn(client, method).mockImplementation((async (url: string, arg?: any) => handler(url, arg)) as any);
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "satori-mcp-test-"));
  vi.spyOn(tools.deps, "sleep").mockResolvedValue(undefined);
  vi.spyOn(BundleCache, "getBundleId").mockReturnValue(undefined);
  vi.spyOn(BundleCache, "setBundleId").mockReturnValue(undefined);
  for (const method of ["get", "post", "patch", "getText", "postForm", "request"] as const) {
    vi.spyOn(client, method).mockRejectedValue(new Error(`unexpected client.${method}`));
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("run_playbook", () => {
  it("requires exactly one source", async () => {
    expect((await tools.runPlaybook()).error).toContain("exactly one");
    expect((await tools.runPlaybook({ playbook_path: "a.yml", playbook_yaml: "x" })).error).toContain("exactly one");
  });

  it("rejects a non-yml path", async () => {
    const f = join(tmp, "x.sh");
    writeFileSync(f, "echo");
    expect((await tools.runPlaybook({ playbook_path: f })).error).toContain("must be an existing .yml");
  });

  it("bundles inline YAML, waits and summarizes", async () => {
    const posts: string[] = [];
    mockClient("postForm", (url) => {
      posts.push(url);
      return "b1";
    });
    const post = mockClient("post", (url) => {
      posts.push(url);
      return { id: 7, status: "QUEUED" };
    });
    mockClient("get", (url) => {
      if (url === "/executions") return { items: [{ id: 99 }] };
      if (url === "/jobs/7") return { status: "FINISHED" };
      return { id: 99, status: "FINISHED", report: { total_fails: 0, detail: [] } };
    });

    const result = await tools.runPlaybook({ playbook_yaml: "test:\n  assertStdoutContains: x\n" });
    expect(posts).toEqual(["/bundles", "/jobs/runs"]);
    expect((post.mock.calls[0][1] as any).playbook_source).toBe("bundle://b1");
    expect(result.execution_id).toBe(99);
    expect(result.execution.total_fails).toBe(0);
    expect(result).not.toHaveProperty("error");
  });

  it("accepts a catalog URI without bundling", async () => {
    const posts: [string, string][] = [];
    mockClient("post", (url, body) => {
      posts.push([url, body.playbook_source]);
      return { id: 1, status: "QUEUED" };
    });
    mockClient("get", () => ({ items: [] }));
    await tools.runPlaybook({ playbook_uri: "satori://code/x.yml", wait: false });
    expect(posts).toEqual([["/jobs/runs", "satori://code/x.yml"]]);
    expect((await tools.runPlaybook({ playbook_uri: "https://evil/x" })).error).toContain("satori://");
  });
});

it("turns HTTP errors into error objects", async () => {
  mockClient("get", () => {
    throw new HttpStatusError(403, "plan", "http://x");
  });
  const result = await tools.getExecution({ execution_id: 1 });
  expect(result.status).toBe(403);
  expect(result.hint).toContain("PRO");
});

describe("get_execution_output", () => {
  it("returns only an index without test", async () => {
    vi.spyOn(tools.deps, "loadExecutionOutputs").mockResolvedValue([{ path: "cmd.0", output: { stdout: "a\nb" } }]);
    const result = await tools.getExecutionOutput({ execution_id: 1 });
    expect(result.tests).toEqual([{ path: "cmd.0", stdout_lines: 2 }]);
    expect(result).not.toHaveProperty("text");
  });

  it("tails a test's stream", async () => {
    vi.spyOn(tools.deps, "loadExecutionOutputs").mockImplementation(async () => [
      { path: "cmd.0", output: { stdout: Array.from({ length: 50 }, (_, i) => String(i)).join("\n") } },
    ]);
    const result = await tools.getExecutionOutput({ execution_id: 1, test: "cmd.0", tail_lines: 5 });
    expect(result.text.split("\n")).toEqual(["45", "46", "47", "48", "49"]);
    expect(result.next_offset_from_end).toBe(5);
    const stderr = await tools.getExecutionOutput({ execution_id: 1, test: "cmd.0.stderr" });
    expect(stderr.text).toBe("");
    expect(stderr.stream).toBe("stderr");
  });

  it("reports unknown tests and streams", async () => {
    vi.spyOn(tools.deps, "loadExecutionOutputs").mockResolvedValue([{ path: "cmd.0", output: {} }]);
    expect((await tools.getExecutionOutput({ execution_id: 1, test: "nope" })).error).toBe("No test matches 'nope'.");
    expect((await tools.getExecutionOutput({ execution_id: 1, stream: "x" })).error).toBe(
      "stream must be one of ('stdout', 'stderr', 'os_error')",
    );
  });
});

describe("list_executions", () => {
  it("maps params and caps quantity", async () => {
    const seen: any = {};
    mockClient("get", (_url, params) => {
      Object.assign(seen, params);
      return {
        items: [{ id: 5, status: "FINISHED", job_id: 2, job: { type: "RUN" }, report: { total_fails: 1 } }],
        total: 60,
      };
    });
    const result = await tools.listExecutions({
      job_id: 2,
      status: ["FINISHED"],
      from_: "2026-01-01",
      to: "2026-02-01",
      visibility: "public",
      severity: 0,
      playbook: "satori://a.yml",
      tags: ["env:prod"],
      id_gt: 10,
      id_lt: 99,
      global_: true,
      quantity: 500,
    });
    expect(seen).toMatchObject({
      quantity: 25,
      from: "2026-01-01",
      job_id: 2,
      order: "DESC",
      visibility: "PUBLIC",
      severity: 0,
      playbook: "satori://a.yml",
      tags: ["env:prod"],
      id_gt: 10,
      id_lt: 99,
      global: true,
    });
    expect(result.next_page).toBe(2);
    expect(result.items[0].total_fails).toBe(1);
    expect(result.items[0].job_type).toBe("RUN");
  });

  it("validates input", async () => {
    expect((await tools.listExecutions({ report_status: "MAYBE" })).error).toBe(
      "report_status must be one of ('PASS', 'FAIL')",
    );
    expect((await tools.listExecutions({ job_type: "X" })).error).toContain("job_type");
    expect((await tools.listExecutions({ visibility: "SECRET" })).error).toContain("visibility");
    expect((await tools.listExecutions({ order: "up" })).error).toContain("order");
    expect((await tools.listExecutions({ severity: 9 })).error).toContain("severity");
    expect((await tools.listExecutions({ from_: "2026-02-01", to: "2026-01-01" })).error).toContain("earlier");
  });
});

it("stop_execution only patches RUNNING", async () => {
  const patches: unknown[] = [];
  let status = "FINISHED";
  mockClient("get", () => ({ status }));
  mockClient("patch", (url, body) => {
    patches.push([url, body]);
    return {};
  });
  expect((await tools.stopExecution({ execution_id: 3 })).stopped).toBe(false);
  expect(patches).toEqual([]);
  status = "RUNNING";
  expect((await tools.stopExecution({ execution_id: 3 })).stopped).toBe(true);
  expect(patches).toEqual([["/executions/3", { status: "CANCELED" }]]);
});

it("get_execution_playbook truncates", async () => {
  mockClient("getText", () => "x".repeat(shaping.MAX_PLAYBOOK_CHARS + 10));
  const result = await tools.getExecutionPlaybook({ execution_id: 4 });
  expect(result.truncated).toBe(true);
  expect(result.yaml).toContain("truncated");
  mockClient("getText", () => "a: 1");
  expect(await tools.getExecutionPlaybook({ execution_id: 4 })).toEqual({
    execution_id: 4,
    yaml: "a: 1",
    truncated: false,
  });
});

describe("update_finding_status", () => {
  it("rejects invalid status without calling the API", async () => {
    expect((await tools.updateFindingStatus({ finding_id: 1, status: "DONE" })).error).toContain("status must be");
  });

  it("sends only the status, then the comment", async () => {
    const calls: unknown[] = [];
    mockClient("patch", (url, body) => {
      calls.push(["patch", url, body]);
      return { status: "TP" };
    });
    mockClient("post", (url, body) => {
      calls.push(["post", url, body]);
      return { id: 5 };
    });
    const result = await tools.updateFindingStatus({ finding_id: 3, status: "tp", comment: "confirmed" });
    expect(calls).toEqual([
      ["patch", "/findings/3", { status: "TP" }],
      ["post", "/findings/3/comments", { body: "confirmed" }],
    ]);
    expect(result).toEqual({ id: 3, status: "TP", comment_id: 5 });
  });

  it("keeps the status when the comment fails", async () => {
    mockClient("patch", () => ({ status: "FP" }));
    mockClient("post", () => {
      throw new HttpStatusError(500, "nope", "http://x");
    });
    const result = await tools.updateFindingStatus({ finding_id: 3, status: "FP", comment: "x" });
    expect(result.status).toBe("FP");
    expect(result.comment_error).toBe("nope");
  });
});

it("get_finding includes a capped timeline", async () => {
  mockClient("get", (url) =>
    url.endsWith("/timeline") ? Array(100).fill({ kind: "event", type: "T", payload: {} }) : { id: 1, title: "t" },
  );
  const result = await tools.getFinding({ finding_id: 1 });
  expect(result.timeline).toHaveLength(20);
  expect(result.timeline_truncated).toBe(true);
  expect(await tools.getFinding({ finding_id: 1, include_timeline: false })).not.toHaveProperty("timeline");
});

it("get_finding_timeline shapes history", async () => {
  mockClient("get", (url) => {
    expect(url).toBe("/findings/7/timeline");
    return [
      { kind: "comment", body: "hi", created_at: "t1", display_name: "a" },
      { kind: "event", type: "STATUS", payload: { to: "TP" } },
    ];
  });
  const result = await tools.getFindingTimeline({ finding_id: 7 });
  expect(result.timeline_total).toBe(2);
  expect(result.timeline_truncated).toBe(false);
  expect(result.timeline[0]).toMatchObject({ kind: "comment", body: "hi", by: "a" });
  expect(result.timeline[1].type).toBe("STATUS");
});

describe("add_finding_comment", () => {
  it("posts the body", async () => {
    const seen: any = {};
    mockClient("post", (url, body) => {
      Object.assign(seen, { url, body });
      return { id: 42 };
    });
    expect(await tools.addFindingComment({ finding_id: 3, body: "looks real" })).toEqual({
      finding_id: 3,
      comment_id: 42,
    });
    expect(seen).toEqual({ url: "/findings/3/comments", body: { body: "looks real" } });
  });

  it("rejects empty and overlong comments", async () => {
    expect((await tools.addFindingComment({ finding_id: 1, body: "   " })).error).toContain("non-empty");
    expect((await tools.addFindingComment({ finding_id: 1, body: "" })).error).toContain("non-empty");
    const long = "x".repeat(shaping.MAX_COMMENT_CHARS + 1);
    expect((await tools.addFindingComment({ finding_id: 1, body: long })).error).toContain("exceeds");
  });
});

it("list_jobs caps quantity and validates type", async () => {
  const seen: any = {};
  mockClient("get", (_url, params) => {
    Object.assign(seen, params);
    return { total: 100, items: [{ id: 1, type: "RUN" }] };
  });
  const result = await tools.listJobs({ type: "RUN", visibility: "public", quantity: 500 });
  expect(seen).toMatchObject({ quantity: 25, type: "RUN", visibility: "PUBLIC" });
  expect(result.next_page).toBe(2);
  expect((await tools.listJobs({ type: "LOCAL" })).error).toContain("type must be");
  expect((await tools.listJobs({ visibility: "SECRET" })).error).toContain("visibility");
});

it("get_job combines the job and its recent executions", async () => {
  mockClient("get", (url) =>
    url === "/executions" ? { items: [{ id: 9, status: "FINISHED" }] } : { id: 4, type: "SCAN", status: "FINISHED" },
  );
  const result = await tools.getJob({ job_id: 4 });
  expect(result.type).toBe("SCAN");
  expect(result.executions[0].id).toBe(9);
});

describe("scan_repository", () => {
  it("validates and caps", async () => {
    expect((await tools.scanRepository({ repository: "nope", playbook_uri: "satori://a.yml" })).error).toContain(
      "owner/repo",
    );
    expect(
      (await tools.scanRepository({ repository: "o/r", playbook_uri: "satori://a.yml", playbook_yaml: "cmd: []" }))
        .error,
    ).toContain("at most one");

    const seen: any = {};
    mockClient("post", (url, body) => {
      Object.assign(seen, { url, body });
      return { id: 3, status: "QUEUED", playbook_source: "satori://a.yml" };
    });
    const result = await tools.scanRepository({ repository: "o/r", playbook_uri: "satori://a.yml", quantity: 99 });
    expect(seen.url).toBe("/jobs/scans");
    expect(seen.body.repository_data).toEqual({ repository: "o/r" });
    expect(seen.body.criteria).toEqual({ quantity: 10 });
    expect(seen.body.playbook_source).toBe("satori://a.yml");
    expect(result.job_id).toBe(3);
  });

  it("omits the source without a playbook", async () => {
    const seen: any = {};
    mockClient("post", (url, body) => {
      Object.assign(seen, { url, body });
      return { id: 4, status: "QUEUED", playbook_source: "bundle://from-repo" };
    });
    const result = await tools.scanRepository({ repository: "o/r" });
    expect(seen.body).not.toHaveProperty("playbook_source");
    expect(result.job_id).toBe(4);
    expect(result.playbook_source).toBe("bundle://from-repo");
  });

  it("forces quantity 1 for owner wildcards", async () => {
    const seen: any = {};
    mockClient("post", (_url, body) => {
      Object.assign(seen, body);
      return { id: 5, status: "QUEUED" };
    });
    await tools.scanRepository({ repository: "octo/*", quantity: 7 });
    expect(seen.criteria).toEqual({ quantity: 1 });
  });
});

it("list_playbooks filters and pages", async () => {
  const catalog = [
    ...Array.from({ length: 10 }, (_, i) => ({
      uri: `satori://api/p${i}.yml`,
      id: `api/p${i}.yml`,
      name: `P${i}`,
      category: "api",
      description: i % 2 ? "openapi" : "other",
    })),
    { uri: "satori://code/c.yml", id: "code/c.yml", name: "C", category: "code", description: "" },
  ];
  vi.spyOn(playbooksClient, "get").mockResolvedValue({ playbooks: catalog });
  const result = await tools.listPlaybooks({ q: "OpenAPI", category: "api", quantity: 2 });
  expect(result.total).toBe(5);
  expect(result.items).toHaveLength(2);
  expect(result.next_page).toBe(2);
  expect(result.items[0]).not.toHaveProperty("content");
});

it("get_playbook clips the YAML", async () => {
  const get = vi
    .spyOn(playbooksClient, "get")
    .mockResolvedValue({ uri: "satori://a.yml", name: "A", content: "x".repeat(100_000) });
  const result = await tools.getPlaybook({ playbook_uri: "satori://a.yml" });
  expect(get).toHaveBeenCalledWith("/playbooks/a.yml");
  expect(result.truncated).toBe(true);
  expect(result.yaml.length).toBeLessThan(20_100);
});

describe("list_findings", () => {
  it("uppercases source and order", async () => {
    const seen: any = {};
    mockClient("get", (_url, params) => {
      Object.assign(seen, params);
      return { total: 0, items: [] };
    });
    await tools.listFindings({ source: "tool", order: "asc" });
    expect(seen.source).toBe("TOOL");
    expect(seen.order).toBe("ASC");
    expect((await tools.listFindings({ source: "X" })).error).toContain("source must be");
    expect((await tools.listFindings({ order: "up" })).error).toContain("order must be");
  });

  it("accepts severity names", async () => {
    const seen: any = {};
    mockClient("get", (_url, params) => {
      Object.assign(seen, params);
      return { total: 0, items: [] };
    });
    await tools.listFindings({ severity: ["HIGH", "low", 5] });
    expect(seen.severity).toEqual([2, 4, 5]);
    expect((await tools.listFindings({ severity: ["NOPE"] })).error).toContain("Invalid severity");
    expect((await tools.listFindings({ severity: [9] })).error).toContain("0-5");
  });
});

it("list_advisories validates and omits long text", async () => {
  const seen: any = {};
  mockClient("get", (url, params) => {
    Object.assign(seen, { url, ...params });
    return { total: 1, items: [{ id: 1, kind: "ISSUE", title: "t", description: "d".repeat(9999) }] };
  });
  const result = await tools.listAdvisories({ kind: "issue", execution_id: 5, quantity: 99 });
  expect(seen).toMatchObject({ url: "/external_issues", kind: "ISSUE", quantity: 25, execution_id: 5 });
  expect(result.items[0]).not.toHaveProperty("description");
  expect((await tools.listAdvisories({ kind: "PR" })).error).toContain("kind must be");
});

it("list_monitors and list_scans filter by job type", async () => {
  const seen: any = {};
  mockClient("get", (_url, params) => {
    Object.assign(seen, params);
    return { total: 1, items: [{ id: 1, type: "MONITOR", expression: "rate(1 hours)" }] };
  });
  const result = await tools.listMonitors({ visibility: "private" });
  expect(seen).toMatchObject({ type: "MONITOR", visibility: "PRIVATE" });
  expect(result.items[0].expression).toBe("rate(1 hours)");
  await tools.listScans({ visibility: "unlisted" });
  expect(seen).toMatchObject({ type: "SCAN", visibility: "UNLISTED" });
});

it("list_repos validates order and caps at 50", async () => {
  const seen: any = {};
  mockClient("get", (url, params) => {
    Object.assign(seen, { url, ...params });
    return { total: 0, items: [] };
  });
  await tools.listRepos({ order: "asc", quantity: 500 });
  expect(seen).toMatchObject({ url: "/repos", order: "ASC", quantity: 50 });
  expect((await tools.listRepos({ order: "up" })).error).toContain("order must be");
});

it("auth errors become a login hint", async () => {
  const { AuthError } = await import("../src/errors.js");
  mockClient("get", () => {
    throw new AuthError("Login required");
  });
  expect((await tools.whoami()).error).toBe("Not logged in. Run: satori-v2 config token <token>");
});

it("doc pages and prompt mention tool output", () => {
  expect(tools.DOC_PAGES["tool-output"]).toBe("playbooks/tool-output");
  const text = tools.writeAndRunPlaybookPrompt("scan for secrets");
  expect(text).toContain("satori-docs://playbooks/tool-output");
  expect(text).toContain("JSON");
});

describe("run_local", () => {
  it("validates input", async () => {
    expect((await tools.runLocal({ playbook_yaml: "x", repository: "a/b", directory: "/" })).error).toContain(
      "only one",
    );
    expect((await tools.runLocal({ playbook_yaml: "x", repository: "nope" })).error).toContain("owner/repo");
    expect((await tools.runLocal({ playbook_yaml: "x", repository: "a/*" })).error).toContain("wildcard");
    expect((await tools.runLocal({ playbook_yaml: "x", directory: "/nonexistent-dir" })).error).toContain(
      "existing directory",
    );
    expect((await tools.runLocal()).error).toContain("exactly one");
  });

  it("returns the run_playbook shape", async () => {
    const write = vi.spyOn(process.stdout, "write");
    const runLocalJob = vi
      .spyOn(tools.deps, "runLocalJob")
      .mockResolvedValue({ job: { id: 5 }, executionId: 77, report: { total_fails: 0 }, timedOut: false });
    mockClient("postForm", () => "b1");
    mockClient("get", () => ({ id: 77, status: "FINISHED", report: { total_fails: 0 } }));

    const result = await tools.runLocal({ playbook_yaml: "cmd: [echo hi]\n", directory: tmp, run: ["a"] });
    expect(result.execution_id).toBe(77);
    expect(result.job_id).toBe(5);
    expect(result.execution.id).toBe(77);
    expect(result.report_url).toBeTruthy();
    expect(result.hint).toContain("get_execution_output");
    expect(runLocalJob.mock.calls[0][0]).toBe("bundle://b1");
    expect(runLocalJob.mock.calls[0][1]).toMatchObject({ workdir: tmp, run: ["a"], timeout: 300 });
    expect(write).not.toHaveBeenCalled();
  });
});

describe("create_ssh_session", () => {
  it("drops unset settings, polls until READY and strips the token", async () => {
    const post = mockClient("post", () => ({ id: 5, status: "PREPARING" }));
    const states = [{ status: "PREPARING" }, { status: "READY" }, { status: "READY", host: "10.0.0.1", token: "jwt" }];
    const get = mockClient("get", (url) => {
      expect(url).toBe("/ssh_sessions/5");
      return { id: 5, ...states.shift() };
    });
    const result = await tools.createSshSession({ cpu: 512, memory: null, image: "alpine", regions: [] });
    expect(post).toHaveBeenCalledWith("/ssh_sessions", {
      save_files: false,
      container_settings: { cpu: 512, image: "alpine" },
    });
    expect(get).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("READY");
    expect(result.host).toBe("10.0.0.1");
    expect(result).not.toHaveProperty("token");
    expect(result.hint).toContain("exec_in_session");
  });

  it("returns a hint when still PREPARING after wait_seconds", async () => {
    mockClient("post", () => ({ id: 5, status: "PREPARING" }));
    mockClient("get", () => ({ id: 5, status: "PREPARING" }));
    let t = 0;
    vi.spyOn(tools.deps, "now").mockImplementation(() => (t += 1000));
    const result = await tools.createSshSession({ wait_seconds: 3 });
    expect(result.status).toBe("PREPARING");
    expect(result.hint).toContain("get_ssh_session");
  });

  it("treats READY without a host as still starting", async () => {
    mockClient("get", () => ({ id: 5, status: "READY", host: null }));
    expect((await tools.getSshSession({ session_id: 5 })).hint).toContain("no host yet");
  });
});

describe("list_ssh_sessions", () => {
  it("pages summarized sessions", async () => {
    const get = mockClient("get", () => ({ total: 11, items: [{ id: 1, status: "FINISHED", token: "x" }] }));
    const result = await tools.listSshSessions({});
    expect(get).toHaveBeenCalledWith("/ssh_sessions", { quantity: 10, page: 1 });
    expect(result.items[0]).not.toHaveProperty("token");
    expect(result.next_page).toBe(2);
  });
});

describe("exec_in_session", () => {
  const respond = (body: string) => ({ json: async () => JSON.parse(body) }) as Response;

  it("allows for the command timeout and parses keepalive-prefixed JSON", async () => {
    const request = vi.spyOn(client, "request").mockResolvedValue(
      respond(`   ${JSON.stringify({ stdout: "hi\n", stderr: "", return_code: 0, timed_out: false, truncated: false, duration: 0.1 })}`),
    );
    const result = await tools.execInSession({ session_id: 3, command: "echo hi", timeout: 90 });
    expect(request).toHaveBeenCalledWith("POST", "/ssh_sessions/3/exec", {
      json: { command: "echo hi", timeout: 90 },
      timeoutMs: 120_000,
    });
    expect(result).toMatchObject({ return_code: 0, stdout: "hi\n", timed_out: false, truncated: false });
  });

  it("surfaces an error sent after the stream started", async () => {
    vi.spyOn(client, "request").mockResolvedValue(respond('{"error": "boom"}'));
    expect(await tools.execInSession({ session_id: 3, command: "x" })).toEqual({ session_id: 3, error: "boom" });
  });

  it("caps long output", async () => {
    const stdout = "a".repeat(shaping.MAX_OUTPUT_CHARS + 10);
    vi.spyOn(client, "request").mockResolvedValue(respond(JSON.stringify({ stdout, stderr: "", return_code: 0 })));
    const result = await tools.execInSession({ session_id: 3, command: "x" });
    expect(result.stdout).toContain("chars truncated");
    expect(result.truncated).toBe(true);
  });
});

describe("stop_ssh_session", () => {
  it("accepts an empty 202", async () => {
    const request = vi.spyOn(client, "request").mockResolvedValue(new Response(null, { status: 202 }));
    expect((await tools.stopSshSession({ session_id: 4 })).stopped).toBe(true);
    expect(request).toHaveBeenCalledWith("POST", "/ssh_sessions/4/stop");
  });

  it("reports an already finished session", async () => {
    vi.spyOn(client, "request").mockRejectedValue(new HttpStatusError(409, "finished", "http://x"));
    expect(await tools.stopSshSession({ session_id: 4 })).toMatchObject({ stopped: false, status: "FINISHED" });
  });
});

describe("ssh_into_execution", () => {
  it("returns short-lived credentials", async () => {
    mockClient("get", (url) => {
      expect(url).toBe("/executions/8/ssh");
      return { host: "1.2.3.4", token: "jwt" };
    });
    expect(await tools.sshIntoExecution({ execution_id: 8 })).toMatchObject({
      host: "1.2.3.4",
      username: "root",
      password: "jwt",
    });
  });

  it("explains when the execution is not running", async () => {
    mockClient("get", () => {
      throw new HttpStatusError(503, "Execution not running", "http://x");
    });
    expect(await tools.sshIntoExecution({ execution_id: 8 })).toEqual({ error: "Execution not running", status: 503 });
  });
});
