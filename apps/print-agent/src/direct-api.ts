import type { Api, ClaimedJob, EventStatus } from "./core";
import { HttpError, type AgentState } from "./http-api";

/**
 * The agent talks to the database directly (PostgREST "rpc" calls with the public key), not through the website.
 * Every dka_* function checks this PC's own secret credential first, exactly like the website's agent routes do, and answers with the
 * same HTTP statuses (401 revoked, 403 / 409 job lease rejected), so the rest of the agent behaves exactly as before.
 * No website server time is used for printing, heartbeats or weight requests.
 */
export interface DirectConfig { url: string; key: string }

/** What the heartbeat ("ping") answers. */
export interface Ping {
  state: AgentState | null;
  /** this PC's secret Realtime topic for the "check now" signal */
  topic: string | null;
  /** a print job / weight request is waiting (safety net if a signal was missed) */
  jobs: boolean;
  weights: boolean;
  /** a job waits for an automatic retry: claim it in this many ms */
  next_job_in_ms: number | null;
}

export interface PingInfo {
  version: string; os: string; printers: { name: string; status: string }[]; machine_id: string; scale?: Record<string, unknown> | null;
}

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

/**
 * The direct route is unusable right now (no network to the database, the database does not have the functions yet, or a gateway
 * error): the caller then uses the website instead, as all agents before 0.1.9 did.
 */
export class DirectUnavailable extends Error {}

export class DirectApi implements Api {
  constructor(private readonly cfg: DirectConfig, private readonly token: string, private readonly fetchFn: FetchFn) {}

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await this.fetchFn(`${this.cfg.url.replace(/\/+$/, "")}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: { "content-type": "application/json", apikey: this.cfg.key, authorization: `Bearer ${this.cfg.key}` },
        body: JSON.stringify({ p_token: this.token, ...args }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new DirectUnavailable(e instanceof Error ? e.message : "network error");
    }
    const body = (await res.json().catch(() => null)) as unknown;
    if (res.ok) return body as T;
    const err = (body ?? {}) as { code?: string; message?: string };
    // function missing (database not updated yet) or a gateway / server problem: not this PC's fault, use the website instead
    if (err.code === "PGRST202" || res.status >= 500) throw new DirectUnavailable(`${res.status} ${err.code ?? ""} ${err.message ?? ""}`.trim());
    throw new HttpError(res.status, err.message ?? `HTTP ${res.status}`);
  }

  async ping(info: PingInfo | null): Promise<Ping> {
    const r = await this.rpc<Partial<Ping> | null>("dka_ping", { p_info: info });
    return {
      state: r?.state ?? null, topic: typeof r?.topic === "string" ? r.topic : null, jobs: !!r?.jobs, weights: !!r?.weights,
      next_job_in_ms: typeof r?.next_job_in_ms === "number" ? r.next_job_in_ms : null,
    };
  }
  claim() { return this.rpc<ClaimedJob | null>("dka_claim", {}); }
  async event(jobId: string, lease: string, status: EventStatus, errorCode?: string) {
    await this.rpc("dka_event", { p_job: jobId, p_lease: lease, p_status: status, p_error: errorCode ?? null });
  }
  nextWeightRead() { return this.rpc<{ id: string } | null>("dka_weight_next", {}); }
  async finishWeightRead(id: string, r: { ok: boolean; kg?: number; raw?: string; frames?: number; code?: string }) {
    await this.rpc("dka_weight_finish", { p_id: id, p_ok: r.ok, p_weight: r.kg ?? null, p_raw: r.raw ?? null, p_frames: r.frames ?? null, p_error: r.code ?? null });
  }
  requestPrinter(printer: string) { return this.rpc<{ state?: AgentState | null }>("dka_request_printer", { p_printer: printer }); }
}

/**
 * The same calls, routed: directly to the database when possible, otherwise through the website (exactly as before 0.1.9).
 * After the direct route fails it is left alone for a while (`retryMs`), so a blocked network does not cost a failed try on every call.
 */
export class Router implements Api {
  private directDownUntil = 0;
  constructor(
    private readonly direct: () => DirectApi | null,
    private readonly website: () => {
      claim(): Promise<ClaimedJob | null>;
      event(jobId: string, lease: string, status: EventStatus, errorCode?: string): Promise<void>;
      nextWeightRead(): Promise<{ id: string } | null>;
      finishWeightRead(id: string, r: { ok: boolean; kg?: number; raw?: string; frames?: number; code?: string }): Promise<void>;
      requestPrinter(printer: string): Promise<{ state?: AgentState | null }>;
    },
    private readonly log: (m: string) => void = () => {},
    private readonly now: () => number = () => Date.now(),
    private readonly retryMs = 10 * 60_000,
  ) {}

  /** The direct route can be used now. */
  usable(): DirectApi | null {
    return this.now() >= this.directDownUntil ? this.direct() : null;
  }
  /** Marks the direct route as unusable for a while. */
  down(e: unknown) {
    if (this.now() >= this.directDownUntil) this.log(`Direct database route unavailable (${e instanceof Error ? e.message : "error"}); using the website for now.`);
    this.directDownUntil = this.now() + this.retryMs;
  }

  private async go<T>(viaDirect: (d: DirectApi) => Promise<T>, viaWebsite: () => Promise<T>): Promise<T> {
    const d = this.usable();
    if (d) {
      try { return await viaDirect(d); } catch (e) {
        if (!(e instanceof DirectUnavailable)) throw e; // a real answer (401 / 403 / 409 ...) is final, exactly as from the website
        this.down(e);
      }
    }
    return viaWebsite();
  }

  claim() { return this.go((d) => d.claim(), () => this.website().claim()); }
  event(jobId: string, lease: string, status: EventStatus, errorCode?: string) {
    return this.go((d) => d.event(jobId, lease, status, errorCode), () => this.website().event(jobId, lease, status, errorCode));
  }
  nextWeightRead() { return this.go((d) => d.nextWeightRead(), () => this.website().nextWeightRead()); }
  finishWeightRead(id: string, r: { ok: boolean; kg?: number; raw?: string; frames?: number; code?: string }) {
    return this.go((d) => d.finishWeightRead(id, r), () => this.website().finishWeightRead(id, r));
  }
  requestPrinter(printer: string) { return this.go((d) => d.requestPrinter(printer), () => this.website().requestPrinter(printer)); }
}

/**
 * What the heartbeat must send in full (printers, version, scale ...). Only a change is sent at once; the full details are also sent
 * every few minutes. The scale's "last data at" time changes with every frame and is not a change.
 */
export function infoSignature(info: PingInfo): string {
  const scale = info.scale ? { ...info.scale, last_data_at: undefined } : info.scale;
  return JSON.stringify({ ...info, scale });
}
