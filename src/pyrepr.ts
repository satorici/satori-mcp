/**
 * Python-style repr, so error messages read exactly like the Python server's
 * (e.g. "status must be one of ('OPEN', 'TP')").
 */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return pyStr(value);
  if (value instanceof Uint8Array) return `b${pyStr(new TextDecoder().decode(value))}`;
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") {
    const items = Object.entries(value).map(([k, v]) => `${pyStr(k)}: ${pyRepr(v)}`);
    return `{${items.join(", ")}}`;
  }
  return String(value);
}

export function pyTuple(values: readonly unknown[]): string {
  if (values.length === 1) return `(${pyRepr(values[0])},)`;
  return `(${values.map(pyRepr).join(", ")})`;
}

function pyStr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return quote + (quote === "'" ? escaped.replace(/'/g, "\\'") : escaped) + quote;
}

/** str.splitlines(): every Python line boundary, no trailing empty line. */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
