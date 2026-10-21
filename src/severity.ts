import { pyRepr } from "./pyrepr.js";

// The position is the numeric severity: 0 = BLOCKER (worst) … 5 = INFO.
export const SEVERITY_ALIASES = ["BLOCKER", "CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;

/** Normalize ints/names to severity ints. Returns an error string on failure. */
export function normalizeSeverities(values: (number | string)[]): number[] | string {
  const result: number[] = [];
  for (const value of values) {
    let index: number;
    if (typeof value === "number" && Number.isInteger(value)) {
      if (value < 0 || value > 5) return `severity ints must be 0-5; got ${value}.`;
      index = value;
    } else if (typeof value === "string") {
      index = (SEVERITY_ALIASES as readonly string[]).indexOf(value.toUpperCase());
      if (index === -1) {
        return `Invalid severity ${pyRepr(value)}. Choose from ${SEVERITY_ALIASES.join(", ")} or ints 0-5.`;
      }
    } else {
      return `severity entries must be ints or names; got ${typeof value}.`;
    }
    if (!result.includes(index)) result.push(index);
  }
  return result;
}
