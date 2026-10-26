import { describe, expect, it } from "vitest";
import * as shaping from "../src/shaping.js";

describe("tailLines", () => {
  it("pages backwards", () => {
    const text = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
    const first = shaping.tailLines(text, 3);
    expect(first.text).toBe("l7\nl8\nl9");
    expect(first.next_offset_from_end).toBe(3);
    expect(first.truncated).toBe(true);
    const second = shaping.tailLines(text, 3, first.next_offset_from_end);
    expect(second.text).toBe("l4\nl5\nl6");
  });

  it("returns the whole text untruncated", () => {
    const result = shaping.tailLines("a\nb", 100);
    expect(result.text).toBe("a\nb");
    expect(result.truncated).toBe(false);
    expect(result.next_offset_from_end).toBeNull();
  });

  it("caps chars and lines", () => {
    const text = Array.from({ length: 1000 }, () => "x".repeat(100)).join("\n");
    const result = shaping.tailLines(text, 10_000, 0, 1000);
    expect(result.text.length).toBeLessThanOrEqual(1000);
    expect(result.truncated).toBe(true);
    expect(result.next_offset_from_end).toBe(result.shown_lines);
  });
});

it("summarizeExecution caps tests and drops logs", () => {
  const detail: any[] = Array.from({ length: 80 }, (_, i) => ({
    path: `cmd.${i}`,
    output: { stdout: "x".repeat(10_000) },
  }));
  detail[0].asserts = [{ msg: "y".repeat(5000) }];
  const summary = shaping.summarizeExecution(
    { id: 1, status: "FINISHED", report: { total_fails: 2, detail } },
    "http://r/1",
  );
  expect(summary.tests).toHaveLength(shaping.MAX_TESTS);
  expect(summary.truncated).toBe(true);
  expect(summary.tests_total).toBe(80);
  expect(summary.tests[0]).not.toHaveProperty("output");
  expect(summary.tests[0].asserts[0].msg.length).toBeLessThan(600);
  expect(summary.report_url).toBe("http://r/1");
});

it("outputIndex has counts, not content", () => {
  expect(shaping.outputIndex([{ path: "cmd.0", output: { stdout: "a\nb\nc", stderr: "" } }])).toEqual([
    { path: "cmd.0", stdout_lines: 3 },
  ]);
});

it("detailFinding clips the snapshot", () => {
  const result = shaping.detailFinding({ id: 1, snapshot: "z".repeat(100_000) });
  expect(result.snapshot.length).toBeLessThan(shaping.MAX_SNAPSHOT_CHARS + 100);
});

it("summarizeExecutionRow works without a report", () => {
  const row = shaping.summarizeExecutionRow({ id: 1, status: "QUEUED" }, "u");
  expect(row.id).toBe(1);
  expect(row.total_fails).toBeNull();
  expect(row.job_type).toBeNull();
});

it("summarizeTimeline keeps the last 20 and clips", () => {
  const items: any[] = Array.from({ length: 100 }, (_, i) => ({
    kind: "comment",
    body: "c".repeat(5000),
    created_at: String(i),
  }));
  items[99] = { kind: "event", type: "STATUS", payload: { x: "p".repeat(5000) } };
  const result = shaping.summarizeTimeline(items);
  expect(result.timeline).toHaveLength(20);
  expect(result.timeline_total).toBe(100);
  expect(result.timeline_truncated).toBe(true);
  expect(result.timeline[0].body.length).toBeLessThan(600);
  expect(result.timeline[19].payload.x.length).toBeLessThan(600);
});

it("summarizeJob keeps compact fields", () => {
  const job = shaping.summarizeJob({ id: 1, type: "RUN", status: "FINISHED", container_settings: { big: 1 } });
  expect(job.id).toBe(1);
  expect(job).not.toHaveProperty("container_settings");
});

it("clip reports how much was cut", () => {
  expect(shaping.clip("abcdef", 2)).toBe("ab... [4 chars truncated]");
  expect(shaping.clip(5)).toBe(5);
});

it("detailAdvisory clips description and keeps list fields", () => {
  const result = shaping.detailAdvisory(
    {
      id: 1,
      title: "t",
      description: "d".repeat(10_000),
      vulnerabilities: [{ package_name: "p", note: "n".repeat(2000) }],
    },
    "http://dash/advisories/1",
  );
  expect(result.description.length).toBeLessThan(shaping.MAX_ADVISORY_DESCRIPTION_CHARS + 100);
  expect(result.vulnerabilities[0].note.length).toBeLessThan(600);
  expect(result.advisory_url).toBe("http://dash/advisories/1");
  expect(shaping.summarizeAdvisory({ id: 1, description: "long" })).not.toHaveProperty("description");
});

it("summarizeAiAnalysis clips text, caps fix_steps, and keeps useful data", () => {
  const result = shaping.summarizeAiAnalysis({
    id: 1,
    finding_id: 9,
    model: "m",
    status: "COMPLETED",
    risk: "HIGH",
    false_positive_likelihood: 0.2,
    suggested_status: "TP",
    summary: "s".repeat(2000),
    root_cause: "r".repeat(2000),
    fix_steps: Array.from({ length: 15 }, (_, i) => `step ${i} ${"x".repeat(600)}`),
    data: { provider: "openai", usage: { tokens: 1 }, cost: 0.01, error: undefined, noise: "drop" },
  });
  expect(result.summary.length).toBeLessThan(600);
  expect(result.root_cause.length).toBeLessThan(600);
  expect(result.fix_steps).toHaveLength(shaping.MAX_AI_FIX_STEPS);
  expect(result.fix_steps_truncated).toBe(true);
  expect(result.fix_steps[0].length).toBeLessThan(600);
  expect(result.data).toEqual({ provider: "openai", usage: { tokens: 1 }, cost: 0.01 });
  expect(result.hint).toContain("advisory");
});
