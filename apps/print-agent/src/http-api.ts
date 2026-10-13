import { net } from "electron";
import type { Api, ClaimedJob, EventStatus } from "./core";

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function assertSafeUrl(base: string) {
  const u = new URL(base);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !local) throw new Error("The server address must use HTTPS");
}

async function call<T>(base: string, path: string, init: RequestInit & { token?: string }): Promise<T> {
  assertSafeUrl(base);
  // Chromium's network stack: it follows the PC's proxy settings and the Windows certificate store (office networks), unlike Node's own fetch
  const res = await net.fetch(new URL(path, base).toString(), {
    ...init,
    headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json().catch(() => null)) as { data?: T; error?: { message?: string } } | null;
  if (!res.ok) throw new HttpError(res.status, j?.error?.message ?? `HTTP ${res.status}`);
  return (j?.data ?? null) as T;
}

export async function pair(base: string, code: string, label: string, os: string) {
  return call<{ agent_id: string; token: string }>(base, "/api/v1/agent/pair", { method: "POST", body: JSON.stringify({ code, label, os }) });
}

export class HttpApi implements Api {
  constructor(private base: string, private token: string) {}
  claim() { return call<ClaimedJob | null>(this.base, "/api/v1/agent/jobs/claim", { method: "POST", token: this.token, body: "{}" }); }
  async event(jobId: string, lease: string, status: EventStatus, errorCode?: string) {
    await call(this.base, `/api/v1/agent/jobs/${jobId}/events`, { method: "POST", token: this.token, body: JSON.stringify({ lease_token: lease, status, error_code: errorCode }) });
  }
  heartbeat(version: string, os: string, printers: { name: string; status: string }[]) {
    return call(this.base, "/api/v1/agent/heartbeat", { method: "POST", token: this.token, body: JSON.stringify({ version, os, printers }) });
  }
}
