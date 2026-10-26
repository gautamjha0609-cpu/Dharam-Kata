import { describe, expect, it } from "vitest";
import { DirectApi, DirectUnavailable, Router, infoSignature } from "./direct-api";
import { HttpError } from "./http-api";

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };
const TOKEN = "t".repeat(64);
const CFG = { url: "https://db.example.supabase.co/", key: "public-key" };

/** A fake network: answers each call with the next queued response (or throws to simulate no network). */
function fakeFetch(answers: ({ status: number; body: unknown } | Error)[]) {
  const calls: Call[] = [];
  const fn = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const a = answers.shift();
    if (!a) throw new Error("no answer queued");
    if (a instanceof Error) throw a;
    return { status: a.status, ok: a.status >= 200 && a.status < 300, json: async () => a.body };
  };
  return { fn, calls };
}

const website = (log: string[]) => ({
  claim: async () => { log.push("website.claim"); return null; },
  event: async () => { log.push("website.event"); },
  nextWeightRead: async () => { log.push("website.weight"); return null; },
  finishWeightRead: async () => { log.push("website.finish"); },
  requestPrinter: async () => { log.push("website.printer"); return { state: null }; },
});

describe("DirectApi", () => {
  it("calls the database function with this PC's credential and the public key", async () => {
    const f = fakeFetch([{ status: 200, body: null }]);
    const d = new DirectApi(CFG, TOKEN, f.fn);
    expect(await d.claim()).toBeNull();
    expect(f.calls[0]!.url).toBe("https://db.example.supabase.co/rest/v1/rpc/dka_claim");
    expect(f.calls[0]!.body).toEqual({ p_token: TOKEN });
    expect(f.calls[0]!.headers.apikey).toBe("public-key");
  });

  it("returns the same statuses as the website: 401 revoked, 403 / 409 lease rejected", async () => {
    const f = fakeFetch([
      { status: 401, body: { code: "PT401", message: "unauthenticated" } },
      { status: 403, body: { code: "PT403", message: "event_rejected" } },
      { status: 409, body: { code: "PT409", message: "event_rejected" } },
    ]);
    const d = new DirectApi(CFG, TOKEN, f.fn);
    await expect(d.claim()).rejects.toMatchObject({ status: 401 });
    await expect(d.event("j", "l", "submitting")).rejects.toMatchObject({ status: 403 });
    const e = await d.event("j", "l", "failed", "paper_out").catch((x) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect(e.status).toBe(409);
    expect(f.calls[2]!.body).toEqual({ p_token: TOKEN, p_job: "j", p_lease: "l", p_status: "failed", p_error: "paper_out" });
  });

  it("no network, a missing function (database not updated yet) or a server error means: use the website", async () => {
    const f = fakeFetch([new Error("ENOTFOUND"), { status: 404, body: { code: "PGRST202" } }, { status: 503, body: null }]);
    const d = new DirectApi(CFG, TOKEN, f.fn);
    for (let i = 0; i < 3; i++) await expect(d.claim()).rejects.toBeInstanceOf(DirectUnavailable);
  });

  it("a 'not found' from the function itself is a real answer, not a reason to switch", async () => {
    const f = fakeFetch([{ status: 404, body: { code: "PT404", message: "not_found" } }]);
    const d = new DirectApi(CFG, TOKEN, f.fn);
    await expect(d.finishWeightRead("x", { ok: false, code: "no_data" })).rejects.toMatchObject({ status: 404 });
  });

  it("ping: full details only when given, and a well-formed answer", async () => {
    const f = fakeFetch([{ status: 200, body: { state: { approval: "approved", printer: "P", request: null }, topic: "dk-agent-x", jobs: true, weights: false, next_job_in_ms: 1500 } }]);
    const d = new DirectApi(CFG, TOKEN, f.fn);
    const r = await d.ping(null);
    expect(f.calls[0]!.body).toEqual({ p_token: TOKEN, p_info: null });
    expect(r).toEqual({ state: { approval: "approved", printer: "P", request: null }, topic: "dk-agent-x", jobs: true, weights: false, next_job_in_ms: 1500 });
  });
});

describe("Router", () => {
  it("uses the database directly while it works", async () => {
    const log: string[] = [];
    const f = fakeFetch([{ status: 200, body: null }]);
    const r = new Router(() => new DirectApi(CFG, TOKEN, f.fn), () => website(log));
    await r.claim();
    expect(f.calls).toHaveLength(1);
    expect(log).toEqual([]);
  });

  it("falls back to the website at once, and leaves the direct route alone for a while", async () => {
    const log: string[] = [];
    let now = 0;
    const f = fakeFetch([new Error("blocked"), { status: 200, body: null }]);
    const r = new Router(() => new DirectApi(CFG, TOKEN, f.fn), () => website(log), () => {}, () => now, 60_000);
    await r.claim();
    expect(log).toEqual(["website.claim"]); // the job is still claimed
    await r.claim();
    expect(f.calls).toHaveLength(1); // not tried again yet
    now = 61_000;
    await r.claim();
    expect(f.calls).toHaveLength(2); // tried again after the pause
    expect(log).toEqual(["website.claim", "website.claim"]);
  });

  it("a real refusal (revoked PC) is final and is not retried through the website", async () => {
    const log: string[] = [];
    const f = fakeFetch([{ status: 401, body: { code: "PT401", message: "unauthenticated" } }]);
    const r = new Router(() => new DirectApi(CFG, TOKEN, f.fn), () => website(log));
    await expect(r.claim()).rejects.toMatchObject({ status: 401 });
    expect(log).toEqual([]);
  });

  it("without the database address the website is used, as by every agent before 0.1.9", async () => {
    const log: string[] = [];
    const r = new Router(() => null, () => website(log));
    await r.nextWeightRead();
    await r.requestPrinter("P");
    expect(log).toEqual(["website.weight", "website.printer"]);
  });
});

describe("infoSignature", () => {
  const base = { version: "0.1.9", os: "Windows 10", printers: [{ name: "P", status: "ready" }], machine_id: "a".repeat(64) };
  it("the scale's 'last data' time is not a change; anything else is", () => {
    const a = infoSignature({ ...base, scale: { enabled: true, state: "stable", last_data_at: "2026-10-26T10:00:00Z" } });
    const b = infoSignature({ ...base, scale: { enabled: true, state: "stable", last_data_at: "2026-10-26T10:00:05Z" } });
    const c = infoSignature({ ...base, scale: { enabled: true, state: "moving", last_data_at: "2026-10-26T10:00:05Z" } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(infoSignature({ ...base, printers: [{ name: "P", status: "printer_offline" }] })).not.toBe(infoSignature(base));
  });
});
