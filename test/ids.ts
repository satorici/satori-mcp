/** A deterministic public ID (21 chars of 0-9A-Za-z) for test fixtures. */
export const pid = (n: number): string => `P${String(n).padStart(20, "0")}`;
