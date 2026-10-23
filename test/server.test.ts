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
      "get_execution_playbook",
      "get_execution_output",
      "list_findings",
      "get_finding",
      "get_finding_timeline",
      "update_finding_status",
      "add_finding_comment",
      "list_jobs",
      "get_job",
      "scan_repository",
      "list_scans",
      "list_playbooks",
      "get_playbook",
      "list_advisories",
      "list_monitors",
      "list_repos",
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
