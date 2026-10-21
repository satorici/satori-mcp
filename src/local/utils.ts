import type { ResultCache } from "./models.js";

const RESULT_REF_PATTERN = /\$\{\{\w+(?:\.\w+)*\.(?:std(?:out|err)(?:\.strip\(\))?|return_code)\}\}/g;

type Field = "stdout" | "stderr" | "return_code";

const decoder = new TextDecoder();

export function parseResultRef(ref: string): [string, Field, string | null] {
  const parts = ref.slice(3, -2).split(".");
  const [y, z] = parts.slice(-2);
  if (y === "stdout" || y === "stderr") return [parts.slice(0, -2).join("."), y, z];
  if (z === "stdout" || z === "stderr" || z === "return_code") return [parts.slice(0, -1).join("."), z, null];
  throw new Error("Bad ref format");
}

const OPERATIONS: Record<string, (x: string) => string> = {
  "strip()": (x) => x.trim(),
};

function replaceResult(orig: string, ref: string, value: Uint8Array | number | null, operation: string | null) {
  if (value === null || value === undefined) return orig.split(ref).join("");
  let replacement = value instanceof Uint8Array ? decoder.decode(value) : String(value);
  if (operation && operation in OPERATIONS) replacement = OPERATIONS[operation](replacement);
  return orig.split(ref).join(replacement);
}

export function replaceResults(orig: string, cache: ResultCache): string {
  for (const ref of new Set(orig.match(RESULT_REF_PATTERN) ?? [])) {
    const [path, field, operation] = parseResultRef(ref);
    const result = cache.get(path);
    if (result) orig = replaceResult(orig, ref, result[field], operation);
  }
  return orig;
}

export function replaceTestcase(orig: string, testcase: Record<string, Uint8Array | string>): string {
  for (const [name, value] of Object.entries(testcase)) {
    const text = value instanceof Uint8Array ? decoder.decode(value) : String(value);
    orig = orig.split(`\${{${name}}}`).join(text);
  }
  return orig;
}
