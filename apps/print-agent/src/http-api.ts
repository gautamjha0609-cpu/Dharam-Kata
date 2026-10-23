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

/** What the server says about this PC (returned with every heartbeat). */
/** Where the server sends the "check now" signal for this PC (Supabase Realtime broadcast topic). */
export interface Signal { url: string; key: string; topic: string }
export interface AgentState { approval: string; printer: string | null; request: { kind: string; printer: string | null; at: string } | null }

export async function pair(base: string, code: string, label: string, os: string, machineId: string, printer: string) {
  return call<{ agent_id: string; token: string; approval?: string }>(base, "/api/v1/agent/pair", { method: "POST", body: JSON.stringify({ code, label, os, machine_id: machineId, printer }) });
}

export class HttpApi implements Api {
  constructor(private base: string, private token: string) {}
  claim() { return call<ClaimedJob | null>(this.base, "/api/v1/agent/jobs/claim", { method: "POST", token: this.token, body: "{}" }); }
  async event(jobId: string, lease: string, status: EventStatus, errorCode?: string) {
    await call(this.base, `/api/v1/agent/jobs/${jobId}/events`, { method: "POST", token: this.token, body: JSON.stringify({ lease_token: lease, status, error_code: errorCode }) });
  }
  heartbeat(version: string, os: string, printers: { name: string; status: string }[], machineId: string, scale?: Record<string, unknown> | null) {
    return call<{ state?: AgentState | null; signal?: Signal | null }>(this.base, "/api/v1/agent/heartbeat", { method: "POST", token: this.token, body: JSON.stringify({ version, os, printers, machine_id: machineId, ...(scale ? { scale } : {}) }) });
  }
  /** The oldest "Detect weight" request from the website for this PC, or null. */
  nextWeightRead() { return call<{ id: string } | null>(this.base, "/api/v1/agent/weight/next", { method: "POST", token: this.token, body: "{}" }); }
  /** The answer: the steady weight in kg, or why there is none. */
  async finishWeightRead(id: string, r: { ok: boolean; kg?: number; raw?: string; frames?: number; code?: string }) {
    await call(this.base, `/api/v1/agent/weight/${id}`, { method: "POST", token: this.token, body: JSON.stringify({ ok: r.ok, weight_kg: r.kg ?? null, raw: r.raw ?? null, frames: r.frames ?? null, error_code: r.code ?? null }) });
  }
  /** "Change printer": the owner approves it on the website. */
  requestPrinter(printer: string) {
    return call<{ state?: AgentState | null }>(this.base, "/api/v1/agent/printer", { method: "POST", token: this.token, body: JSON.stringify({ printer }) });
  }
}
