import { homedir } from "node:os";
import { join } from "node:path";

export const SATORI_HOME = join(homedir(), ".satori");

export const API_URL = process.env.SATORI_ENDPOINT ?? "https://api-v2.satori.ci";

export const PLAYBOOKS_API_URL =
  process.env.SATORI_PLAYBOOKS_ENDPOINT ?? "https://h71qr5shr9.execute-api.us-east-1.amazonaws.com";

export const DASHBOARD_URL = process.env.SATORI_DASHBOARD_URL ?? "https://dashboard.satori.ci";

export const DOCS_URL = (process.env.SATORI_DOCS_URL ?? "https://docs-v2.satori.ci").replace(/\/+$/, "");

export function reportUrl(executionId: number): string {
  return `${DASHBOARD_URL}/reports/${executionId}`;
}
