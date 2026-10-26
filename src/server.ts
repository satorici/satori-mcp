/** Local stdio MCP server: registers the Satori tools, doc resources and prompt. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as tools from "./tools.js";

export const INSTRUCTIONS =
  "Satori CI. Write a playbook (read the satori-docs://playbooks/language resource), " +
  "call run_playbook, then get_execution for pass/fail and get_execution_output " +
  "with a `test` filter for logs. When a playbook runs a security/analysis tool, " +
  "prefer that tool's JSON/JSONL stdout flags (read satori-docs://playbooks/tool-output). " +
  "In Satori, reports = executions; use " +
  "list_executions (or list_reports) to list reports. Use get_execution_playbook " +
  "to read the YAML of a run, and stop_execution to cancel a running one. " +
  "Use list_jobs/get_job to find a job and its executions, and " +
  "update_finding_status to triage a finding (only when asked). " +
  "Use add_finding_comment to comment without changing status, and " +
  "get_finding_timeline for status/comment history. " +
  "analyze_finding / analyze_execution queue server-side AI analysis with the account's AI key " +
  "(only when asked); get_finding_ai_analysis reads the latest. suggested_status is advisory — " +
  "do not call update_finding_status unless the user asked to triage. " +
  "create_security_advisory / publish_security_advisory / update_advisory_visibility only when asked " +
  "(no delete); get_advisory and get_advisory_status are read-only. " +
  "list_playbooks/get_playbook browse ready-made catalog playbooks (use via " +
  "playbook_uri); scan_repository scans one named owner/repo. " +
  "run_local runs a playbook's commands on THIS machine (results are uploaded; " +
  "analyze them with get_execution_output/list_findings). " +
  "recommend_playbook inspects a repo and proposes a lint/format/types/unit/security " +
  "playbook for .satori-llm.yml (or changes to an existing one); .satori.yml is for " +
  "CI/manual and should import file://.satori-llm.yml. Relay `questions` to the user, " +
  "call again with `prefs`, and write files only with their approval. " +
  "Before editing code, run_local .satori-llm.yml once as a baseline; afterwards fix " +
  "only failures that were not in the baseline. " +
  "Saved parameters/secrets (list_saved_inputs) are applied to every new job automatically; " +
  "change them with save_parameter/save_secret/delete_* only when asked. " +
  "Playbooks read both as ${{NAME}}. " +
  "create_ssh_session starts a remote sandbox container: run commands in it with " +
  "exec_in_session and always stop_ssh_session when done. ssh_into_execution returns " +
  "short-lived SSH credentials for a RUNNING execution (live debugging). " +
  "Output is always capped.";

const int = () => z.number().int();
const optStr = () => z.string().nullish();
const optInt = () => int().nullish();
const parameters = () => z.record(z.string(), z.array(z.string())).nullish();
const secrets = () => z.record(z.string(), z.string()).nullish();
const playbookSource = {
  playbook_path: optStr(),
  playbook_yaml: optStr(),
  playbook_uri: optStr(),
};
const paging = (quantity = 25) => ({ quantity: int().default(quantity), page: int().default(1) });

const listExecutionsShape = {
  job_id: optInt(),
  status: z.array(z.string()).nullish(),
  report_status: optStr(),
  job_type: optStr(),
  from_: optStr(),
  to: optStr(),
  q: optStr(),
  visibility: optStr(),
  severity: optInt(),
  playbook: optStr(),
  tags: z.array(z.string()).nullish(),
  id_gt: optInt(),
  id_lt: optInt(),
  global_: z.boolean().default(false),
  order: optStr(),
  ...paging(),
};

const LIST_EXECUTIONS_DESCRIPTION = `List reports (executions), newest first.

In Satori, reports = executions. Use list_executions (or list_reports) to list reports.
status: any of QUEUED, RUNNING, FINISHED, CANCELED. report_status: PASS or FAIL.
job_type: RUN, SCAN, MONITOR, GITHUB or LOCAL. from_/to: ISO datetimes (from_ < to).
visibility: PUBLIC, PRIVATE or UNLISTED. severity: report severity 0-5 (0=Blocker, 1=Critical, 2=High, 3=Medium, 4=Low, 5=Info).
playbook: playbook filter. tags: key:value strings. id_gt/id_lt: id range.
global_: include public executions from others. order: ASC or DESC (default DESC).
q: free-text search. Max 25 per page; use next_page to continue.`;

function asContent(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "satori", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  ) => {
    server.registerTool(name, { description, inputSchema }, (async (args: any) =>
      asContent(await handler(args))) as any);
  };

  tool("whoami", "Show which Satori account, profile and endpoint this server is using.", {}, () =>
    tools.whoami(),
  );

  tool(
    "recommend_playbook",
    `Recommend a quality-check playbook (lint, format, types, unit, security) for a repo.

Detects the stack in \`directory\` (default: the server's current directory) for Python,
JS/TS, Go, Java, C#, Rust, Ruby, PHP, Swift, C/C++ (CMake), Solidity (Foundry) or
Dart/Flutter, and
returns content for \`.satori-llm.yml\` plus a \`checks\` list explaining why each check
is there. \`.satori.yml\` is reserved for CI/manual runs and should
\`import: [file://.satori-llm.yml]\`.

If \`.satori-llm.yml\` already exists (or a legacy \`.satori.yml\` with
\`# satori:recommended\`), returns \`changes\` instead of the full file; merge into
\`.satori-llm.yml\` yourself. Only questions the repo cannot answer come back in
\`questions\`: ask the user in chat, then call again with \`prefs\` (e.g.
{"formatter": "black", "dead_code": false}). Prefs are saved in the LLM playbook's
\`# satori:recommended\` header. Never write files without the user's approval.
Workflow: run_local \`.satori-llm.yml\` BEFORE changing code to capture a baseline,
and after each change fix only the failures that are not in the baseline.`,
    { directory: optStr(), prefs: z.record(z.string(), z.any()).nullish() },
    (args) => tools.recommendPlaybook(args),
  );

  tool(
    "run_playbook",
    `Run a playbook on Satori and (optionally) wait for the result.

Provide EXACTLY ONE of playbook_path (local .yml file), playbook_yaml (inline YAML) or
playbook_uri (a catalog playbook such as satori://code/python/pyspector_v2.yml; see list_playbooks).
\`repository\` is an optional "owner/repo" to associate the run with (see list_repos).
If the run is still going after wait_seconds (max 600), call get_execution later.
Playbook syntax: read the satori-docs://playbooks/language resource first.
For security/analysis tools, prefer JSON/JSONL stdout flags
(satori-docs://playbooks/tool-output).
\`secrets\` (NAME -> value) are read like parameters (\${{NAME}}) but never stored with
the job and redacted from output; saved parameters/secrets are added automatically.`,
    {
      ...playbookSource,
      repository: optStr(),
      parameters: parameters(),
      secrets: secrets(),
      regions: z.array(z.string()).nullish(),
      wait: z.boolean().default(true),
      wait_seconds: int().default(120),
    },
    (args) => tools.runPlaybook(args),
  );

  tool(
    "run_local",
    `Run a playbook's commands on THIS machine, upload the results and return the execution.

Unlike run_playbook, commands execute locally with the user's privileges, so only run
playbooks the user asked for or that you wrote for them. Provide EXACTLY ONE of
playbook_path, playbook_yaml or playbook_uri. Working directory: \`repository\`
("owner/repo", shallow-cloned to a temp dir) OR \`directory\` (existing local dir);
default is the server's current directory. \`run\` limits execution to test paths with
those prefixes. timeout_seconds max 3600.
Returns the same shape as run_playbook; analyze with get_execution_output and list_findings.`,
    {
      ...playbookSource,
      repository: optStr(),
      directory: optStr(),
      parameters: parameters(),
      run: z.array(z.string()).nullish(),
      timeout_seconds: int().default(tools.LOCAL_DEFAULT_TIMEOUT),
    },
    (args) => tools.runLocal(args),
  );

  tool(
    "get_execution",
    "Status and assertion results of an execution (no logs; use get_execution_output).",
    { execution_id: int() },
    (args) => tools.getExecution(args),
  );

  tool("list_executions", LIST_EXECUTIONS_DESCRIPTION, listExecutionsShape, (args) => tools.listExecutions(args));

  tool(
    "list_reports",
    "Alias for list_executions. In Satori, reports = executions.",
    listExecutionsShape,
    (args) => tools.listExecutions(args),
  );

  tool(
    "stop_execution",
    "Cancel a RUNNING execution (e.g. after run_playbook with wait=false).",
    { execution_id: int() },
    (args) => tools.stopExecution(args),
  );

  tool(
    "get_execution_playbook",
    "The playbook YAML an execution ran (capped), to debug or iterate on it.",
    { execution_id: int() },
    (args) => tools.getExecutionPlaybook(args),
  );

  tool(
    "get_execution_output",
    `Read execution logs, always capped.

Without \`test\`, returns only an index of tests with line counts per stream.
With \`test\` (a test path such as "cmd.0", or "cmd.0.stderr" to pick a stream),
returns the last \`tail_lines\` (max 500, 20k chars) lines of \`stream\`.
Use offset_from_end (from next_offset_from_end) to page backwards.`,
    {
      execution_id: int(),
      test: optStr(),
      stream: z.string().default("stdout"),
      tail_lines: int().default(100),
      offset_from_end: int().default(0),
    },
    (args) => tools.getExecutionOutput(args),
  );

  tool(
    "list_findings",
    `List findings (severity 0-5, where 0=BLOCKER … 5=INFO, or the names).

status: OPEN, INVESTIGATING, TP, FIXED, FP, ACCEPTED.
source: ASSERT (playbook assertion failures) or TOOL (findings parsed from tool output).
order: ASC or DESC by creation time.`,
    {
      execution_id: optInt(),
      severity: z.array(z.union([int(), z.string()])).nullish(),
      status: optStr(),
      source: optStr(),
      order: optStr(),
      ...paging(),
    },
    (args) => tools.listFindings(args),
  );

  tool(
    "get_finding",
    "Details of one finding plus its recent timeline (status changes and comments).",
    { finding_id: int(), include_timeline: z.boolean().default(true) },
    (args) => tools.getFinding(args),
  );

  tool(
    "get_finding_timeline",
    `Status changes and comments for a finding (capped), without the finding body.

Prefer this when you only need history; use get_finding for full details.`,
    { finding_id: int() },
    (args) => tools.getFindingTimeline(args),
  );

  tool(
    "update_finding_status",
    `Triage a finding: set its status, optionally adding a comment explaining why.

status: OPEN, INVESTIGATING, TP (true positive), FIXED, FP (false positive) or ACCEPTED.
Changes shared triage state; use only when the user asked to triage this finding.`,
    { finding_id: int(), status: z.string(), comment: optStr() },
    (args) => tools.updateFindingStatus(args),
  );

  tool(
    "add_finding_comment",
    `Post a comment on a finding without changing its status.

Use only when the user asked to comment. To triage and comment together, use
update_finding_status with comment=... instead.`,
    { finding_id: int(), body: z.string() },
    (args) => tools.addFindingComment(args),
  );

  tool(
    "get_finding_ai_analysis",
    `Latest AI analysis for a finding (PENDING, COMPLETED or FAILED).

Uses the account's configured AI provider. 404 if none exists yet — call
analyze_finding when the user asks to analyze. suggested_status is advisory only.`,
    { finding_id: int() },
    (args) => tools.getFindingAiAnalysis(args),
  );

  tool(
    "analyze_finding",
    `Queue AI analysis for one finding (uses the account's AI API key; costs apply).

Only when the user asked to analyze. force=true queues again even if one is pending
or completed. With wait (default true), polls until COMPLETED/FAILED or wait_seconds
(max 600). suggested_status is advisory — do not update_finding_status unless asked.`,
    {
      finding_id: int(),
      force: z.boolean().default(false),
      wait: z.boolean().default(true),
      wait_seconds: int().default(tools.AI_ANALYSIS_DEFAULT_WAIT),
    },
    (args) => tools.analyzeFinding(args),
  );

  tool(
    "analyze_execution",
    `Queue AI analysis for an execution's findings in one provider call (account AI key; costs apply).

Only when the user asked to analyze. Optional finding_ids (max 20); otherwise the API
picks up to 20 by severity. force, wait and wait_seconds work as in analyze_finding.
Returns items, skipped and omitted. suggested_status is advisory only.`,
    {
      execution_id: int(),
      finding_ids: z.array(int()).nullish(),
      force: z.boolean().default(false),
      wait: z.boolean().default(true),
      wait_seconds: int().default(tools.AI_ANALYSIS_DEFAULT_WAIT),
    },
    (args) => tools.analyzeExecution(args),
  );

  tool(
    "list_jobs",
    `List jobs, newest first (a job is the parent of executions; use it to recover a job_id).

type: RUN, SCAN or MONITOR. visibility: PUBLIC, PRIVATE or UNLISTED.
Max 25 per page; use next_page to continue.`,
    { type: optStr(), visibility: optStr(), ...paging() },
    (args) => tools.listJobs(args),
  );

  tool(
    "get_job",
    "A job and its 5 most recent executions (no playbook body; see get_execution_playbook).",
    { job_id: int() },
    (args) => tools.getJob(args),
  );

  tool(
    "scan_repository",
    `Start a scan of a GitHub repository with a playbook. Returns immediately.

\`repository\` is required, as "owner/repo" (see list_repos), or "owner/*" to scan
the HEAD of every repository of owner (up to 100) in one job; only use "owner/*"
when the user asked for all of an owner's repositories. Optionally provide
EXACTLY ONE of playbook_path, playbook_yaml or playbook_uri (e.g.
satori://code/python/pyspector_v2.yml, see list_playbooks). When none are given,
the API uses the repository root .satori.yml (each repository's own for "owner/*",
skipping repositories without one). \`quantity\` is how many executions to create
(max 10; always 1 per repository for "owner/*"). Poll with get_job(job_id) /
list_executions(job_id=...); results via get_execution.
\`secrets\` work as in run_playbook; saved parameters/secrets for each repository are
added automatically.`,
    {
      repository: z.string(),
      ...playbookSource,
      parameters: parameters(),
      secrets: secrets(),
      regions: z.array(z.string()).nullish(),
      quantity: int().default(1),
    },
    (args) => tools.scanRepository(args),
  );

  tool(
    "list_scans",
    "List scan jobs, newest first (same as list_jobs with type=SCAN).",
    { visibility: optStr(), ...paging() },
    (args) => tools.listScans(args),
  );

  tool(
    "list_playbooks",
    `Search the catalog of ready-made playbooks (satori://...) instead of writing YAML.

q: case-insensitive match on id, name or description. category: e.g. api, code, cloud.
Run one with run_playbook/scan_repository(playbook_uri=...); read details with get_playbook.`,
    { q: optStr(), category: optStr(), ...paging() },
    (args) => tools.listPlaybooks(args),
  );

  tool(
    "get_playbook",
    "Details and YAML of a catalog playbook (satori://... URI or its id), capped.",
    { playbook_uri: z.string() },
    (args) => tools.getPlaybook(args),
  );

  tool(
    "list_advisories",
    `List external issues you already created from findings (read-only).

kind: SECURITY_ADVISORY or ISSUE. provider: GITHUB. order: ASC or DESC.
Optional finding_id or execution_id filters. Returns titles and links (external_url),
not the full advisory text; use get_advisory for details.`,
    {
      execution_id: optInt(),
      finding_id: optInt(),
      kind: optStr(),
      provider: optStr(),
      order: optStr(),
      ...paging(),
    },
    (args) => tools.listAdvisories(args),
  );

  tool(
    "get_advisory",
    "Details of one external issue / security advisory (description capped), with advisory_url.",
    { advisory_id: int() },
    (args) => tools.getAdvisory(args),
  );

  tool(
    "create_security_advisory",
    `Create a local GitHub security-advisory draft from a finding (PRO/ENTERPRISE).

Only when the user asked. Derives title/description from the finding (and completed AI
analysis if any). Optional visibility (PUBLIC, PRIVATE, UNLISTED; default UNLISTED).
Does not contact GitHub — call publish_security_advisory when asked to publish.
Creating a draft can promote a PRIVATE execution to UNLISTED. If one already exists
for the finding, returns the existing row.`,
    { finding_id: int(), visibility: optStr() },
    (args) => tools.createSecurityAdvisory(args),
  );

  tool(
    "publish_security_advisory",
    `Submit an existing security-advisory draft to GitHub (PRO/ENTERPRISE; needs GitHub PAT in Settings).

Only when the user asked to publish. Uses finding_id (not advisory_id). Requires a
prior create_security_advisory draft. Returns external_url on success.`,
    { finding_id: int() },
    (args) => tools.publishSecurityAdvisory(args),
  );

  tool(
    "get_advisory_status",
    `Live remote GitHub status for a published security advisory (e.g. triage).

Needs a GitHub PAT in Settings. advisory_id from get_advisory / list_advisories.
The state is not stored locally.`,
    { advisory_id: int() },
    (args) => tools.getAdvisoryStatus(args),
  );

  tool(
    "update_advisory_visibility",
    `Change an advisory's visibility (PUBLIC, PRIVATE or UNLISTED).

Only when the user asked. Does not change the GitHub remote advisory.`,
    { advisory_id: int(), visibility: z.string() },
    (args) => tools.updateAdvisoryVisibility(args),
  );

  tool(
    "list_monitors",
    "List monitor jobs with their schedule `expression` (read-only; same as list_jobs type=MONITOR).",
    { visibility: optStr(), ...paging() },
    (args) => tools.listMonitors(args),
  );

  tool(
    "list_repos",
    `List repositories (owner/repo) Satori can target, with their last execution.

order: ASC or DESC by last activity.`,
    { order: optStr(), ...paging(50) },
    (args) => tools.listRepos(args),
  );

  const savedRepository = { repository: optStr() };
  const savedScopeDoc = `Without \`repository\` these are the user's own values, applied to every job;
with "owner/repo" they apply only to that repository's runs and scans. Request values win
over saved ones, and a repository's over the user's.`;

  tool(
    "list_saved_inputs",
    `List saved parameters (with values) and saved secrets (names only; values are write-only).

${savedScopeDoc}`,
    savedRepository,
    (args) => tools.listSavedInputs(args),
  );

  tool(
    "save_parameter",
    `Save (create or replace) a parameter added to every new job. Only when the user asks.

Parameters are stored with each job and shown in its details: use save_secret for
credentials. ${savedScopeDoc}`,
    { name: z.string(), values: z.array(z.string()).min(1), ...savedRepository },
    (args) => tools.saveParameter(args),
  );

  tool(
    "delete_parameter",
    "Delete a saved parameter (only when the user asks). `repository` selects the scope.",
    { name: z.string(), ...savedRepository },
    (args) => tools.deleteParameter(args),
  );

  tool(
    "save_secret",
    `Save (create or replace) a secret added to every new job. Only when the user asks.

The value is encrypted and can't be read back; playbooks read it as \${{NAME}} and it is
redacted from output. NAME: letters, digits and _, not starting with a digit.
Local runs (run_local) don't get secrets. ${savedScopeDoc}`,
    { name: z.string(), value: z.string().min(1), ...savedRepository },
    (args) => tools.saveSecret(args),
  );

  tool(
    "delete_secret",
    "Delete a saved secret (only when the user asks). `repository` selects the scope.",
    { name: z.string(), ...savedRepository },
    (args) => tools.deleteSecret(args),
  );

  tool(
    "create_ssh_session",
    `Start a remote sandbox container on Satori and (optionally) wait until it accepts commands
(READY with a host; startup can take a few minutes).

Container settings are optional: cpu (256, 512, 1024, 2048, 4096, 8192 or 16384; default 1024),
memory in MiB (default 2048; must be a valid Fargate pair with cpu), storage in GiB (20-200),
image (default ubuntu:noble), os (linux or windows), environment_variables.
\`regions\` limits where it may run; \`timeout\` is the session lifetime in seconds.
With save_files, changed files are kept after the session stops.
Then run commands with exec_in_session, and ALWAYS call stop_ssh_session when done.`,
    {
      cpu: optInt(),
      memory: optInt(),
      storage: optInt(),
      image: optStr(),
      os: z.enum(["linux", "windows"]).nullish(),
      environment_variables: z.record(z.string(), z.string()).nullish(),
      regions: z.array(z.string()).nullish(),
      timeout: optInt(),
      save_files: z.boolean().default(false),
      wait: z.boolean().default(true),
      wait_seconds: int().default(300),
    },
    (args) => tools.createSshSession(args),
  );

  tool(
    "get_ssh_session",
    "Status (PREPARING, READY or FINISHED), region and settings of an SSH session.",
    { session_id: int() },
    (args) => tools.getSshSession(args),
  );

  tool(
    "list_ssh_sessions",
    "List SSH sessions, newest first.",
    { ...paging(10) },
    (args) => tools.listSshSessions(args),
  );

  tool(
    "exec_in_session",
    `Run a shell command in a READY SSH session and return stdout, stderr and return_code.

Each call is a fresh shell (no state between calls except the filesystem); stdin is closed.
\`timeout\` is in seconds (1-3600, default 60); on timeout the command is killed and
timed_out is true. Output is capped.`,
    { session_id: int(), command: z.string().min(1), timeout: int().default(60) },
    (args) => tools.execInSession(args),
  );

  tool(
    "stop_ssh_session",
    "Stop an SSH session and release its container. Stopping is asynchronous.",
    { session_id: int() },
    (args) => tools.stopSshSession(args),
  );

  tool(
    "ssh_into_execution",
    `Short-lived (5 min) SSH credentials for a RUNNING execution, for live debugging.

Returns host, username and a password token for an interactive shell; this tool cannot
run commands itself. Only call it when the user asks to debug a running execution.`,
    { execution_id: int() },
    (args) => tools.sshIntoExecution(args),
  );

  const docs: [string, string, string][] = [
    ["doc_language", "language", "Playbook language reference."],
    ["doc_asserts", "asserts", "Playbook asserts reference."],
    ["doc_inputs", "inputs", "Playbook inputs reference."],
    ["doc_settings", "settings", "Playbook settings reference."],
    ["doc_execution", "execution", "Playbook execution reference."],
    ["doc_tool_output", "tool-output", "Prefer JSON tool stdout so Satori can parse TOOL findings."],
  ];
  for (const [name, page, description] of docs) {
    const uri = `satori-docs://playbooks/${page}`;
    server.registerResource(name, uri, { description, mimeType: "text/plain" }, async (url) => ({
      contents: [{ uri: url.href, mimeType: "text/plain", text: await tools.fetchDoc(page) }],
    }));
  }

  server.registerPrompt(
    "write_and_run_playbook",
    {
      description: "Write a Satori playbook for a goal, run it and report the result.",
      argsSchema: { goal: z.string() },
    },
    ({ goal }) => ({
      messages: [{ role: "user", content: { type: "text", text: tools.writeAndRunPlaybookPrompt(goal) } }],
    }),
  );

  return server;
}
