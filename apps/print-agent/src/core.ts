import { LayoutSchema, renderHtml, ticketPreset, getModel, matchPrinterModel, maxPrintableWidthMm, type Layout, type PrintValues } from "@dk/print-template";

/** What the server returns from POST /agent/jobs/claim. Treated as untrusted data and re-validated. */
export interface ClaimedJob {
  id: string;
  lease_token: string;
  attempt: number;
  invoice_id?: string;
  job_type: "original" | "reprint" | "test";
  payload: Record<string, unknown>;
  template: unknown | null;
  printer: { os_name: string; paper_w_mm: number; paper_h_mm: number; offset_x_mm: number; offset_y_mm: number; model_key?: string | null; legibility_floor_pt?: number | string | null };
}

export type EventStatus = "rendering" | "submitting" | "submitted_to_spooler" | "failed";

export interface Api {
  claim(): Promise<ClaimedJob | null>;
  event(jobId: string, lease: string, status: EventStatus, errorCode?: string): Promise<void>;
}
export interface PrinterPort {
  list(): Promise<string[]>;
  /** Optional pre-flight: a safe-failure code if Windows reports the printer offline / out of paper / jammed, else null. */
  check?(name: string): Promise<string | null>;
  /** Resolves when the OS print subsystem accepted (or rejected) the job. Never proves paper came out. */
  print(html: string, opts: { deviceName: string; widthMm: number; heightMm: number; copies: number; /** file name (without extension) when the printer is a PDF printer */ fileName?: string }): Promise<{ ok: boolean; error?: string; /** what happened, for the activity log (e.g. the PDF file that was written) */ note?: string }>;
}
/** Durable record of jobs whose final status still has to reach the server (survives restarts). */
export interface Journal {
  pending(): PendingAck[];
  add(a: PendingAck): void;
  remove(jobId: string): void;
  /** job ids this PC already submitted to the spooler: never print the same job twice. */
  submitted(jobId: string): boolean;
  markSubmitted(jobId: string): void;
}
export interface PendingAck { jobId: string; lease: string; status: EventStatus; errorCode?: string }

const SAFE_VALUE = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F]{0,300}$/;

export function sanitizeValues(payload: Record<string, unknown>): PrintValues {
  const out: PrintValues = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k.startsWith("_")) continue; // internal metadata
    if (typeof v !== "string" || !SAFE_VALUE.test(v)) continue;
    (out as Record<string, string>)[k] = v;
  }
  return out;
}

/** Local backup sink (the print PC's daily Excel). Failures must never affect printing. */
export interface BackupSink {
  record(e: { jobId: string; invoiceId?: string; jobType: "original" | "reprint" | "test"; status: string; printedAtIso: string; printer: string; values: Record<string, string> }): Promise<unknown>;
}

export type TickResult = "idle" | "printed" | "failed" | "skipped_duplicate";

export class AgentCore {
  constructor(
    private readonly api: Api,
    private readonly printer: PrinterPort,
    private readonly journal: Journal,
    private readonly log: (m: string) => void = () => {},
    private readonly backup?: BackupSink,
    private readonly now: () => Date = () => new Date(),
    /**
     * The one printer this PC was approved for (null = not chosen yet, agents paired before 0.1.5). `refresh` asks the server again,
     * e.g. right after an owner approved a printer change. A job for any other printer is refused: never print elsewhere.
     */
    private readonly selectedPrinter?: (refresh: boolean) => Promise<string | null>,
  ) {}

  private lastFailCode = "";

  /** PDF file name: invoice no._vehicle no_date (an opening slip gets _opening so it never overwrites the closing slip). */
  private pdfName(v: Record<string, string | undefined>, jobType: ClaimedJob["job_type"] = "original"): string {
    const d = this.now();
    const date = `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
    const part = (s?: string) => (s ?? "").replace(/[^A-Za-z0-9.-]+/g, "_").replace(/^_+|_+$/g, "");
    // a reprint gets its own file (time added), so the original slip's PDF is never overwritten
    const reprint = jobType === "reprint" ? `_duplicate_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}` : "";
    return [part(v.serial) || "invoice", part(v.vehicle) || "vehicle", date].join("_") + (v.stage === "open" ? "_opening" : "") + reprint;
  }

  /** Retry delivering final statuses that failed to reach the server (e.g. network drop after printing). */
  async flushAcks(): Promise<void> {
    for (const a of this.journal.pending()) {
      try {
        await this.api.event(a.jobId, a.lease, a.status, a.errorCode);
        this.journal.remove(a.jobId);
      } catch (e) {
        if (isRejected(e)) this.journal.remove(a.jobId); // lease gone: server already decided (unknown/failed)
        else break; // still offline, keep for next tick
      }
    }
  }

  async tick(): Promise<TickResult> {
    await this.flushAcks();
    const job = await this.api.claim();
    if (!job) return "idle";
    return this.process(job);
  }

  private async report(job: ClaimedJob, status: EventStatus, errorCode?: string): Promise<void> {
    try {
      await this.api.event(job.id, job.lease_token, status, errorCode);
    } catch (e) {
      if (status === "submitted_to_spooler" || status === "failed") {
        if (!isRejected(e)) this.journal.add({ jobId: job.id, lease: job.lease_token, status, errorCode });
      } else throw e;
    }
  }

  private async fail(job: ClaimedJob, code: string): Promise<TickResult> {
    this.lastFailCode = code;
    this.log(`job ${job.id} failed: ${code}`);
    // "claimed" -> failed is a legal transition, so this works at any pre-submit stage
    await this.report(job, "failed", code);
    return "failed";
  }

  async process(job: ClaimedJob): Promise<TickResult> {
    this.lastFailCode = "";
    const result = await this.processInner(job);
    // Back up every outcome that carried invoice data. A backup problem is logged, never thrown.
    try {
      const values = sanitizeValues(job.payload ?? {});
      if (this.backup && Object.keys(values).length > 0) {
        await this.backup.record({
          jobId: job.id, invoiceId: job.invoice_id, jobType: job.job_type, printedAtIso: this.now().toISOString(), printer: job.printer?.os_name ?? "", values,
          status: result === "failed" ? `failed:${this.lastFailCode}` : "submitted_to_spooler",
        });
      }
    } catch (e) {
      this.log(`backup error: ${(e as Error).message}`);
    }
    return result;
  }

  private async processInner(job: ClaimedJob): Promise<TickResult> {
    if (this.journal.submitted(job.id)) {
      // We already handed this job to Windows; do not print again. Just (re)confirm to the server.
      await this.report(job, "submitting").catch(() => {});
      await this.report(job, "submitted_to_spooler");
      return "skipped_duplicate";
    }

    // 1. validate everything that came from the server
    let layout: Layout;
    try {
      layout = job.template ? LayoutSchema.parse(job.template) : ticketPreset();
    } catch {
      return this.fail(job, "invalid_template");
    }
    if (!job.printer?.os_name) return this.fail(job, "no_printer");
    if (this.selectedPrinter) {
      let mine = await this.selectedPrinter(false);
      if (mine && mine !== job.printer.os_name) mine = await this.selectedPrinter(true);
      if (mine && mine !== job.printer.os_name) return this.fail(job, "printer_not_selected");
    }
    const values = sanitizeValues(job.payload ?? {});
    if (Object.keys(values).length === 0 && job.job_type !== "test") return this.fail(job, "invalid_payload");

    // 2. printer must exist on THIS machine (exact Windows device name)
    const installed = await this.printer.list();
    if (!installed.includes(job.printer.os_name)) return this.fail(job, "printer_missing");
    // pre-flight status: failing BEFORE anything is sent is always safe to retry (nothing can have printed)
    const bad = await this.printer.check?.(job.printer.os_name);
    if (bad) return this.fail(job, bad);

    // 2b. paper size compatibility check: layout paper must physically fit the printer carriage/tray
    const model = getModel(job.printer.model_key) ?? matchPrinterModel(job.printer.os_name);
    const maxW = maxPrintableWidthMm(model);
    if (layout.paper.w > maxW + 5) {
      return this.fail(job, "paper_width_exceeds_printer");
    }

    // 3. render from the bundled allow-listed template engine
    await this.report(job, "rendering");
    const floor = Number(job.printer.legibility_floor_pt ?? 0);
    const calibrated: Layout = {
      ...layout,
      legibilityFloorPt: Math.max(layout.legibilityFloorPt, Number.isFinite(floor) ? floor : 0), // printer environment: smaller text only produces a warning
      offset: { x: layout.offset.x + job.printer.offset_x_mm, y: layout.offset.y + job.printer.offset_y_mm },
    };
    const { html, warnings } = renderHtml(calibrated, values, { reprint: job.job_type === "reprint" });
    if (warnings.some((w) => w.kind === "overflow")) return this.fail(job, "layout_overflow"); // never print truncated invoice data

    // 4. hand to the OS. If we crash after this line the server turns the job UNKNOWN (never auto-retried).
    await this.report(job, "submitting");
    const res = await this.printer.print(html, { deviceName: job.printer.os_name, widthMm: layout.paper.w, heightMm: layout.paper.h, copies: layout.copies, fileName: this.pdfName(values, job.job_type) });
    if (!res.ok) {
      const code = mapPrintError(res.error);
      // Windows did not answer in time: the slip may still come out, so this PC never prints it again and the server marks it
      // "unknown" (check the paper first) instead of offering "Print again".
      if (code === "print_timeout") this.journal.markSubmitted(job.id);
      return this.fail(job, code);
    }
    if (res.note) this.log(res.note);
    this.journal.markSubmitted(job.id);
    await this.report(job, "submitted_to_spooler");
    return "printed";
  }
}

function isRejected(e: unknown): boolean {
  return typeof e === "object" && e !== null && "status" in e && [403, 409].includes((e as { status: number }).status);
}

export function mapPrintError(raw?: string): string {
  const m = (raw ?? "").toLowerCase();
  if (m.includes("timeout")) return "print_timeout";
  if (m.includes("invalid") && m.includes("printer")) return "printer_invalid";
  if (m.includes("cancel")) return "print_cancelled";
  if (m.includes("offline")) return "printer_offline";
  if (m.includes("paper") && m.includes("jam")) return "paper_jam";
  if (m.includes("paper")) return "paper_out";
  if (m.includes("access") || m.includes("denied")) return "permission_denied";
  return "driver_failure";
}
