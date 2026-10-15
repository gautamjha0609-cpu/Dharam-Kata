import { describe, expect, it } from "vitest";
import { ticketPreset } from "@dk/print-template";
import { AgentCore, mapPrintError, sanitizeValues, type Api, type ClaimedJob, type EventStatus, type Journal, type PendingAck, type PrinterPort } from "./core";

const baseJob = (over: Partial<ClaimedJob> = {}): ClaimedJob => ({
  id: "11111111-1111-1111-1111-111111111111",
  lease_token: "22222222-2222-2222-2222-222222222222",
  attempt: 1,
  job_type: "original",
  payload: { serial: "VNK/26-27/000125", vehicle: "RJ14GD9158", party: "GANPATI PLAS", gross_weight: "34210", tare_weight: "15105", net_weight: "19105", charge: "350", _calibration: { x: 1, y: 1 } },
  template: null,
  printer: { os_name: "EPSON LQ-310", paper_w_mm: 170, paper_h_mm: 95, offset_x_mm: 1.5, offset_y_mm: -0.5 },
  ...over,
});

function harness(opts: { job?: ClaimedJob | null; installed?: string[]; printOk?: boolean; eventFailsFor?: EventStatus[]; rejectEvents?: boolean; preflight?: string | null; selected?: (refresh: boolean) => Promise<string | null> } = {}) {
  const events: { status: EventStatus; code?: string }[] = [];
  const printed: { html: string; deviceName: string; w: number; h: number; copies: number; fileName?: string }[] = [];
  let pending: PendingAck[] = [];
  const submitted = new Set<string>();
  const failFor = new Set(opts.eventFailsFor ?? []);
  const api: Api = {
    claim: async () => (opts.job === undefined ? baseJob() : opts.job),
    event: async (_id, _lease, status, code) => {
      if (opts.rejectEvents) throw { status: 403 };
      if (failFor.has(status)) throw new Error("network down");
      events.push({ status, code });
    },
  };
  const printer: PrinterPort = {
    list: async () => opts.installed ?? ["EPSON LQ-310", "Microsoft Print to PDF"],
    check: async () => opts.preflight ?? null,
    print: async (html, o) => {
      printed.push({ html, deviceName: o.deviceName, w: o.widthMm, h: o.heightMm, copies: o.copies, fileName: o.fileName });
      return opts.printOk === false ? { ok: false, error: "printer offline" } : { ok: true };
    },
  };
  const journal: Journal = {
    pending: () => pending,
    add: (a) => { pending.push(a); },
    remove: (id) => { pending = pending.filter((p) => p.jobId !== id); },
    submitted: (id) => submitted.has(id),
    markSubmitted: (id) => { submitted.add(id); },
  };
  return { core: new AgentCore(api, printer, journal, () => {}, undefined, () => new Date(), opts.selected), events, printed, journal, submitted, setFail: (s: EventStatus) => failFor.delete(s) };
}

describe("AgentCore", () => {
  it("idle when there is no job", async () => {
    const h = harness({ job: null });
    expect(await h.core.tick()).toBe("idle");
    expect(h.printed).toHaveLength(0);
  });

  it("happy path: rendering -> submitting -> submitted_to_spooler, exact device and 170x95 page", async () => {
    const h = harness();
    expect(await h.core.tick()).toBe("printed");
    expect(h.events.map((e) => e.status)).toEqual(["rendering", "submitting", "submitted_to_spooler"]);
    expect(h.printed[0]).toMatchObject({ deviceName: "EPSON LQ-310", w: 170, h: 95 });
    expect(h.printed[0]!.html).toContain("VNK/26-27/000125");
    expect(h.printed[0]!.html).toContain("@page{size:170mm 95mm;margin:0}");
  });

  it("applies the printer calibration offset in mm", async () => {
    const h = await Promise.resolve(harness());
    await h.core.tick();
    expect(h.printed[0]!.html).toContain("left:27.50mm"); // area 10 + serial x 16 + calibration 1.5
  });

  it("fails (not retried blindly) when the printer is not installed on this PC", async () => {
    const h = harness({ installed: ["Other"] });
    expect(await h.core.tick()).toBe("failed");
    expect(h.events).toEqual([{ status: "failed", code: "printer_missing" }]);
    expect(h.printed).toHaveLength(0);
  });

  it("reports a driver error as failed with a safe code", async () => {
    const h = harness({ printOk: false });
    expect(await h.core.tick()).toBe("failed");
    expect(h.events.at(-1)).toEqual({ status: "failed", code: "printer_offline" });
    expect(h.submitted.size).toBe(0);
  });

  it("rejects an invalid/hostile template instead of printing", async () => {
    const h = harness({ job: baseJob({ template: { version: 1, paper: { w: 99999 } } }) });
    expect(await h.core.tick()).toBe("failed");
    expect(h.events[0]).toEqual({ status: "failed", code: "invalid_template" });
  });

  it("refuses to print when text cannot fit (no truncated invoices)", async () => {
    const h = harness({ job: baseJob({ payload: { serial: "X".repeat(250), vehicle: "RJ14" } }) });
    expect(await h.core.tick()).toBe("failed");
    expect(h.events.at(-1)!.code).toBe("layout_overflow");
    expect(h.printed).toHaveLength(0);
  });

  it("network loss after printing: ack is journaled, then delivered later, and the job is NOT printed again", async () => {
    const h = harness({ eventFailsFor: ["submitted_to_spooler"] });
    expect(await h.core.tick()).toBe("printed");
    expect(h.journal.pending()).toHaveLength(1);
    expect(h.printed).toHaveLength(1);
    h.setFail("submitted_to_spooler");
    await h.core.flushAcks();
    expect(h.journal.pending()).toHaveLength(0);
    expect(h.events.at(-1)!.status).toBe("submitted_to_spooler");
    expect(h.printed).toHaveLength(1);
  });

  it("a re-claimed job already sent to Windows is confirmed, never printed twice", async () => {
    const h = harness();
    h.submitted.add(baseJob().id);
    expect(await h.core.tick()).toBe("skipped_duplicate");
    expect(h.printed).toHaveLength(0);
  });

  it("drops a journaled ack once the server rejects the lease", async () => {
    const h = harness({ rejectEvents: true });
    h.journal.add({ jobId: "x", lease: "y", status: "submitted_to_spooler" });
    await h.core.flushAcks();
    expect(h.journal.pending()).toHaveLength(0);
  });
});

describe("printer status, copies and reprint marking", () => {
  it("pre-flight paper_out fails BEFORE anything is sent (safe to retry)", async () => {
    const h = harness({ preflight: "paper_out" });
    expect(await h.core.tick()).toBe("failed");
    expect(h.events).toEqual([{ status: "failed", code: "paper_out" }]);
    expect(h.printed).toHaveLength(0);
  });
  const tpl = (over: object = {}) => ({ ...ticketPreset(), copies: 2, reprintMark: { enabled: true, text: "DUPLICATE", x: 100, y: 30, w: 40, h: 8, pt: 14 }, ...over });
  it("passes the layout's copy count to the printer", async () => {
    const h = harness({ job: baseJob({ template: tpl() }) });
    await h.core.tick();
    expect(h.printed[0]!.copies).toBe(2);
  });
  it("marks a reprint DUPLICATE but never the original", async () => {
    const orig = harness({ job: baseJob({ template: tpl() }) });
    await orig.core.tick();
    expect(orig.printed[0]!.html).not.toContain("DUPLICATE");
    const re = harness({ job: baseJob({ job_type: "reprint", template: tpl() }) });
    await re.core.tick();
    expect(re.printed[0]!.html).toContain("DUPLICATE");
    expect(re.printed[0]!.html).toContain("VNK/26-27/000125"); // original invoice number untouched
  });
  it("maps driver messages to safe codes", () => {
    expect(mapPrintError("Printer is out of paper")).toBe("paper_out");
    expect(mapPrintError("paper jam detected")).toBe("paper_jam");
    expect(mapPrintError("printer offline")).toBe("printer_offline");
  });
});

describe("PDF printers", () => {
  it("gets a file name of the form invoice no._vehicle no_date, and an opening slip is told apart", async () => {
    const h = harness({ job: baseJob({ payload: { ...baseJob().payload, vehicle: "RJ14 GD 9158" } }) });
    await h.core.tick();
    expect(h.printed[0]!.fileName).toMatch(/^VNK_26-27_000125_RJ14_GD_9158_[0-9]{2}-[0-9]{2}-[0-9]{4}$/);
    const o = harness({ job: baseJob({ payload: { ...baseJob().payload, stage: "open" } }) });
    await o.core.tick();
    expect(o.printed[0]!.fileName).toMatch(/_opening$/);
  });
});

describe("sanitizeValues", () => {
  it("keeps strings, drops internals/non-strings/control chars", () => {
    expect(sanitizeValues({ serial: "A1", _calibration: { x: 1 }, n: 5 as unknown as string, bad: "a\u0007b", ok: "नमस्ते" })).toEqual({ serial: "A1", ok: "नमस्ते" });
  });

  it("prints only to the printer this PC was approved for", async () => {
    const h = harness({ selected: async () => "Canon MF3010", installed: ["EPSON LQ-310", "Canon MF3010"] });
    expect(await h.core.tick()).toBe("failed");
    expect(h.printed).toHaveLength(0);
    expect(h.events.at(-1)).toEqual({ status: "failed", code: "printer_not_selected" });
  });

  it("asks the server again before refusing (a printer change was just approved)", async () => {
    let approved = "Canon MF3010";
    const asked: boolean[] = [];
    const h = harness({ selected: async (refresh) => { asked.push(refresh); if (refresh) approved = "EPSON LQ-310"; return approved; } });
    expect(await h.core.tick()).toBe("printed");
    expect(asked).toEqual([false, true]);
    expect(h.printed[0]!.deviceName).toBe("EPSON LQ-310");
  });

  it("a PC paired before 0.1.5 (no printer chosen) keeps printing as before", async () => {
    const h = harness({ selected: async () => null });
    expect(await h.core.tick()).toBe("printed");
  });

  it("a renamed printer (Canon MF3010 -> Canon MF3010 (Copy 1)) is never replaced by another one", async () => {
    const h = harness({ selected: async () => "Canon MF3010", installed: ["Canon MF3010 (Copy 1)", "EPSON LQ-310"], job: baseJob({ printer: { os_name: "Canon MF3010", paper_w_mm: 170, paper_h_mm: 95, offset_x_mm: 0, offset_y_mm: 0 } }) });
    expect(await h.core.tick()).toBe("failed");
    expect(h.printed).toHaveLength(0);
    expect(h.events.at(-1)).toEqual({ status: "failed", code: "printer_missing" });
  });
});
