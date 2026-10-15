import ExcelJS from "exceljs";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DailyBackup, dayParts, type BackupEntry } from "./backup";
import { AgentCore, type Api, type ClaimedJob, type Journal, type PrinterPort } from "./core";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dk-backup-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const at = "2026-10-12T04:30:00.000Z"; // 10:00 IST
const entry = (over: Partial<BackupEntry> = {}): BackupEntry => ({
  jobId: "job-1", invoiceId: "inv-1", jobType: "original", status: "submitted_to_spooler", printedAtIso: at, printer: "EPSON LX-310",
  values: { serial: "VNK/26-27/000125", vehicle: "RJ14 GD 9158", party: "GANPATI", material: "SCRAP", gross_weight: "34210", tare_weight: "15105", net_weight: "19105", charge: "6686.75", payment_mode: "cash", gross_date: "12/10/2026", gross_time: "09:00" },
  ...over,
});

async function readXlsx(p: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  return wb;
}

describe("dayParts (Indian financial year, IST)", () => {
  it("12 Oct 2026 -> FY 2026-27 / 10 October / 12-10-2026", () => {
    expect(dayParts(new Date(at))).toMatchObject({ fy: "FY 2026-27", month: "10 October", day: "12-10-2026" });
  });
  it("Jan-Mar belong to the previous April's FY", () => {
    expect(dayParts(new Date("2027-02-05T06:00:00Z"))).toMatchObject({ fy: "FY 2026-27", month: "02 February", day: "05-02-2027" });
  });
  it("1 April starts the new FY, using IST not UTC", () => {
    expect(dayParts(new Date("2027-03-31T19:00:00Z")).fy).toBe("FY 2027-28"); // 00:30 IST on 1 April
    expect(dayParts(new Date("2027-03-31T17:00:00Z")).fy).toBe("FY 2026-27"); // 22:30 IST on 31 March
  });
});

describe("DailyBackup", () => {
  it("creates one workbook per day, named with that day's date, inside FY / month folders", async () => {
    const b = new DailyBackup(dir, () => new Date(at));
    const r = await b.record(entry());
    expect(r.xlsxOk).toBe(true);
    expect(r.xlsxPath).toBe(join(dir, "FY 2026-27", "10 October", "12-10-2026.xlsx"));
    const wb = await readXlsx(r.xlsxPath);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Invoices", "Summary"]);
    const row = wb.getWorksheet("Invoices")!.getRow(2);
    expect(row.getCell("C").value).toBe("VNK/26-27/000125");
    expect(row.getCell("N").value).toBe(19105);
  });

  it("resolves PDF folder and file paths inside FY / month / PDFs", () => {
    const b = new DailyBackup(dir, () => new Date(at));
    expect(b.pdfDir()).toBe(join(dir, "FY 2026-27", "10 October", "PDFs"));
    expect(b.pdfPath("168_RJ14GE1248_12-10-2026")).toBe(
      join(dir, "FY 2026-27", "10 October", "PDFs", "168_RJ14GE1248_12-10-2026.pdf")
    );
  });

  it("appends every print to the SAME day's file and updates a job instead of duplicating it", async () => {
    const b = new DailyBackup(dir, () => new Date(at));
    await b.record(entry());
    await b.record(entry({ jobId: "job-2", values: { ...entry().values, serial: "VNK/26-27/000126", charge: "100", net_weight: "1000" }, printedAtIso: "2026-10-12T05:00:00.000Z" }));
    await b.record(entry({ status: "failed:paper_out" })); // same job-1 again with a new status
    const r = await b.record(entry({ jobId: "job-1", status: "submitted_to_spooler" }));
    const ws = (await readXlsx(r.xlsxPath)).getWorksheet("Invoices")!;
    expect(ws.rowCount).toBe(3); // header + 2 jobs
    expect(ws.getRow(2).getCell("S").value).toBe("Sent to Windows print queue");
  });

  it("summary counts each invoice once, even with reprints, and splits cash / credit", async () => {
    const b = new DailyBackup(dir, () => new Date(at));
    await b.record(entry());
    await b.record(entry({ jobId: "job-r", jobType: "reprint", printedAtIso: "2026-10-12T06:00:00.000Z" })); // same invoice number
    await b.record(entry({ jobId: "job-3", values: { ...entry().values, serial: "VNK/26-27/000127", charge: "228", payment_mode: "credit", net_weight: "19000" }, printedAtIso: "2026-10-12T07:00:00.000Z" }));
    const r = await b.record(entry({ jobId: "job-x", jobType: "test", values: { serial: "TEST-000", charge: "9999" }, printedAtIso: "2026-10-12T08:00:00.000Z" }));
    const sm = (await readXlsx(r.xlsxPath)).getWorksheet("Summary")!;
    const get = (label: string) => { let v: unknown; sm.eachRow((row) => { if (row.getCell(1).value === label) v = row.getCell(2).value; }); return v; };
    expect(get("Invoices")).toBe(2);
    expect(get("Total amount (INR)")).toBeCloseTo(6914.75);
    expect(get("Cash invoices (INR)")).toBeCloseTo(6686.75);
    expect(get("Credit invoices (INR)")).toBeCloseTo(228);
    expect(get("Reprints")).toBe(1);
  });

  it("an entry printed twice (opening + closing) counts once, with the LAST amount, and is labelled Opening / Closing", async () => {
    const b = new DailyBackup(dir, () => new Date(at));
    const open = { serial: "VNK/26-27/000200", vehicle: "RJ14 GD 1", stage: "open", gross_weight: "34210", gross_date: "12/10/2026", gross_time: "09:00", charge: "350", payment_mode: "cash" };
    await b.record(entry({ jobId: "j-open", values: open, printedAtIso: "2026-10-12T04:30:00.000Z" }));
    const r = await b.record(entry({ jobId: "j-close", values: { ...open, stage: undefined, tare_weight: "15105", net_weight: "19105", charge: "500" } as never, printedAtIso: "2026-10-12T09:30:00.000Z" }));
    const wb = await readXlsx(r.xlsxPath);
    const ws = wb.getWorksheet("Invoices")!;
    expect(ws.getRow(2).getCell("D").value).toBe("Opening");
    expect(ws.getRow(3).getCell("D").value).toBe("Closing");
    const sm = wb.getWorksheet("Summary")!;
    const get = (label: string) => { let v: unknown; sm.eachRow((row) => { if (row.getCell(1).value === label) v = row.getCell(2).value; }); return v; };
    expect(get("Invoices")).toBe(1);
    expect(get("Total amount (INR)")).toBeCloseTo(500);
  });

  it("puts prints from different days into different files", async () => {
    const b = new DailyBackup(dir, () => new Date(at));
    const a = await b.record(entry());
    const c = await b.record(entry({ jobId: "job-n", printedAtIso: "2026-10-13T04:30:00.000Z" }));
    expect(a.xlsxPath).not.toBe(c.xlsxPath);
    expect(c.xlsxPath.endsWith("13-10-2026.xlsx")).toBe(true);
  });

  it("never loses data when the Excel file cannot be written; it catches up later", async () => {
    const b = new DailyBackup(dir, () => new Date(at));
    const target = join(dir, "FY 2026-27", "10 October", "12-10-2026.xlsx");
    mkdirSync(target, { recursive: true }); // a directory where the file should go: writing/renaming over it fails like a locked file
    const r = await b.record(entry());
    expect(r.jsonOk).toBe(true);
    expect(r.xlsxOk).toBe(false);
    rmSync(target, { recursive: true, force: true });
    await b.flush();
    expect(existsSync(target)).toBe(true);
    const wb = await readXlsx(target);
    expect(wb.getWorksheet("Invoices")!.rowCount).toBe(2);
  });

  it("reports how many days are stored", async () => {
    const b = new DailyBackup(dir, () => new Date(at));
    await b.record(entry());
    await b.record(entry({ jobId: "j2", printedAtIso: "2026-10-13T04:30:00.000Z" }));
    expect(b.summary().days).toBe(2);
  });
});

describe("AgentCore + backup", () => {
  const job = (over: Partial<ClaimedJob> = {}): ClaimedJob => ({
    id: "j-1", lease_token: "l", attempt: 1, job_type: "original", invoice_id: "inv-1",
    payload: { serial: "VNK/26-27/000125", vehicle: "RJ14", charge: "350", net_weight: "100" }, template: null,
    printer: { os_name: "EPSON LX-310", paper_w_mm: 170, paper_h_mm: 95, offset_x_mm: 0, offset_y_mm: 0 }, ...over,
  });
  const mk = (printOk: boolean, sink: { record: (e: never) => Promise<unknown> }) => {
    const api: Api = { claim: async () => job(), event: async () => {} };
    const printer: PrinterPort = { list: async () => ["EPSON LX-310"], print: async () => (printOk ? { ok: true } : { ok: false, error: "printer offline" }) };
    const journal: Journal = { pending: () => [], add: () => {}, remove: () => {}, submitted: () => false, markSubmitted: () => {} };
    return new AgentCore(api, printer, journal, () => {}, sink as never, () => new Date(at));
  };

  it("backs up every successful print", async () => {
    const got: BackupEntry[] = [];
    await mk(true, { record: async (e) => { got.push(e as unknown as BackupEntry); } }).tick();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ status: "submitted_to_spooler", invoiceId: "inv-1", printer: "EPSON LX-310" });
    expect(got[0]!.values.serial).toBe("VNK/26-27/000125");
  });
  it("also records a failed print with its reason", async () => {
    const got: BackupEntry[] = [];
    await mk(false, { record: async (e) => { got.push(e as unknown as BackupEntry); } }).tick();
    expect(got[0]!.status).toBe("failed:printer_offline");
  });
  it("a broken backup never stops printing", async () => {
    const r = await mk(true, { record: async () => { throw new Error("disk full"); } }).tick();
    expect(r).toBe("printed");
  });
});
