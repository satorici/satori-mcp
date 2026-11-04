import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { client as api } from "../src/api.js";
import { createServer, INSTRUCTIONS } from "../src/server.js";
import * as tools from "../src/tools.js";

let client: Client;

beforeEach(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
});

afterEach(() => vi.restoreAllMocks());

it("exposes every tool, resource and prompt of the Python server", async () => {
  const { tools: listed } = await client.listTools();
  expect(listed.map((t) => t.name).sort()).toEqual(
    [
      "whoami",
      "recommend_playbook",
      "run_playbook",
      "run_local",
      "get_execution",
      "list_executions",
      "list_reports",
      "stop_execution",
      "update_execution_visibility",
      "delete_execution",
      "delete_executions",
      "get_execution_playbook",
      "get_execution_output",
      "list_findings",
      "get_finding",
      "get_finding_timeline",
      "update_finding_status",
      "update_finding",
      "list_finding_events",
      "add_finding_comment",
      "edit_finding_comment",
      "delete_finding_comment",
      "get_finding_ai_analysis",
      "analyze_finding",
      "analyze_execution",
      "list_jobs",
      "get_job",
      "delete_job",
      "scan_repository",
      "list_scans",
      "stop_scan",
      "stop_run",
      "stop_all_runs",
      "pause_scan",
      "resume_scan",
      "clean_scan",
      "clean_monitor",
      "list_playbooks",
      "get_playbook",
      "list_advisories",
      "get_advisory",
      "create_security_advisory",
      "publish_security_advisory",
      "get_advisory_status",
      "update_advisory_visibility",
      "update_advisory",
      "delete_security_advisory",
      "list_monitors",
      "create_monitor",
      "list_repos",
      "list_organizations",
      "get_organization",
      "list_organization_members",
      "create_organization",
      "rename_organization",
      "delete_organization",
      "add_organization_member",
      "update_organization_member_role",
      "remove_organization_member",
      "use_organization",
      "use_personal_account",
      "list_saved_inputs",
      "save_parameter",
      "delete_parameter",
      "save_secret",
      "delete_secret",
      "create_ssh_session",
      "get_ssh_session",
      "list_ssh_sessions",
      "exec_in_session",
      "stop_ssh_session",
      "ssh_into_execution",
    ].sort(),
  );
  const scan = listed.find((t) => t.name === "scan_repository")!;
  expect(scan.inputSchema.required).toEqual(["repository"]);
  const listExecutions = listed.find((t) => t.name === "list_executions")!;
  expect(Object.keys(listExecutions.inputSchema.properties!)).toContain("from_");
  expect(listExecutions.inputSchema.required ?? []).toEqual([]);
  const exec = listed.find((t) => t.name === "exec_in_session")!;
  expect(exec.inputSchema.required).toEqual(["session_id", "command"]);

  const { resources } = await client.listResources();
  expect(resources.map((r) => r.uri).sort()).toEqual(
    Object.keys(tools.DOC_PAGES)
      .map((p) => `satori-docs://playbooks/${p}`)
      .sort(),
  );

  const { prompts } = await client.listPrompts();
  expect(prompts.map((p) => p.name)).toEqual(["write_and_run_playbook"]);
  expect(client.getInstructions()).toBe(INSTRUCTIONS);
});

it("returns tool results as JSON text, applying schema defaults", async () => {
  const get = vi.spyOn(api, "get").mockResolvedValue({ total: 30, items: [] });
  const result = await client.callTool({ name: "list_jobs", arguments: { visibility: "private" } });
  expect(get).toHaveBeenCalledWith("/jobs", { quantity: 25, page: 1, order: "DESC", visibility: "PRIVATE" });
  const content = result.content as { type: string; text: string }[];
  expect(JSON.parse(content[0].text)).toEqual({ items: [], total: 30, page: 1, next_page: 2 });
});

it("renders the prompt", async () => {
  const prompt = await client.getPrompt({ name: "write_and_run_playbook", arguments: { goal: "scan" } });
  const message = prompt.messages[0].content as { type: string; text: string };
  expect(message.text.startsWith("Goal: scan\n\n1.")).toBe(true);
});

const PUBLIC_ID_PARAMS: Record<string, string[]> = {
  get_execution: ["execution_id"],
  list_executions: ["job_id", "id_gt", "id_lt"],
  list_reports: ["job_id", "id_gt", "id_lt"],
  stop_execution: ["execution_id"],
  update_execution_visibility: ["execution_id"],
  delete_execution: ["execution_id"],
  delete_executions: ["execution_ids[]"],
  get_execution_playbook: ["execution_id"],
  get_execution_output: ["execution_id"],
  list_findings: ["execution_id"],
  get_finding: ["finding_id"],
  get_finding_timeline: ["finding_id"],
  update_finding_status: ["finding_id"],
  update_finding: ["finding_id"],
  list_finding_events: ["execution_id"],
  add_finding_comment: ["finding_id"],
  edit_finding_comment: ["finding_id"],
  delete_finding_comment: ["finding_id"],
  get_finding_ai_analysis: ["finding_id"],
  analyze_finding: ["finding_id"],
  analyze_execution: ["execution_id", "finding_ids[]"],
  get_job: ["job_id"],
  delete_job: ["job_id"],
  stop_scan: ["scan_id"],
  stop_run: ["run_id"],
  pause_scan: ["scan_id"],
  resume_scan: ["scan_id"],
  clean_scan: ["scan_id"],
  clean_monitor: ["monitor_id"],
  list_advisories: ["execution_id", "finding_id"],
  get_advisory: ["advisory_id"],
  create_security_advisory: ["finding_id"],
  publish_security_advisory: ["finding_id"],
  get_advisory_status: ["advisory_id"],
  update_advisory_visibility: ["advisory_id"],
  update_advisory: ["advisory_id"],
  delete_security_advisory: ["finding_id"],
  ssh_into_execution: ["execution_id"],
};

it("types job, execution, finding and advisory IDs as 21-char public IDs", async () => {
  const { tools: listed } = await client.listTools();
  for (const [name, params] of Object.entries(PUBLIC_ID_PARAMS)) {
    const props = listed.find((t) => t.name === name)!.inputSchema.properties as Record<string, any>;
    for (const param of params) {
      const isArray = param.endsWith("[]");
      let schema = props[param.replace("[]", "")];
      if (schema.anyOf) schema = schema.anyOf.find((s: any) => s.type !== "null");
      if (isArray) schema = schema.items;
      expect(schema, `${name}.${param}`).toMatchObject({
        type: "string",
        pattern: "^[0-9A-Za-z]{21}$",
        description: "ID de 21 caracteres alfanuméricos",
      });
    }
  }
  const comment = listed.find((t) => t.name === "delete_finding_comment")!.inputSchema.properties as any;
  expect(comment.comment_id.type).toBe("integer");
});

it("rejects integer and malformed public IDs before calling the API", async () => {
  const get = vi.spyOn(api, "get").mockResolvedValue({ id: "V1StGXR8Z5jdHi6BmyT7k", status: "FINISHED" });
  for (const execution_id of [42, "42", "V1StGXR8Z5jdHi6BmyT7-", "V1StGXR8Z5jdHi6BmyT7kX"]) {
    const result = await client.callTool({ name: "get_execution", arguments: { execution_id } });
    expect(result.isError, String(execution_id)).toBe(true);
  }
  expect(get).not.toHaveBeenCalled();

  const ok = await client.callTool({ name: "get_execution", arguments: { execution_id: "V1StGXR8Z5jdHi6BmyT7k" } });
  expect(ok.isError).toBeFalsy();
  expect(get).toHaveBeenCalledWith("/executions/V1StGXR8Z5jdHi6BmyT7k");
});
