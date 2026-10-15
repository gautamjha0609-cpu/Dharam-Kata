import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Local backup on the PRINT PC. After every print job the day's Excel file is rebuilt:
 *   <root>/FY 2026-27/10 October/12-10-2026.xlsx     (one workbook per day, named with that day's date)
 * The JSON sidecar (<root>/FY .../.data/12-10-2026.json) is the source of truth; the .xlsx is regenerated from it,
 * so a locked/open Excel file never loses data: it is simply refreshed on the next job (or on startup).
 */

export interface BackupEntry {
  jobId: string;
  invoiceId?: string;
  jobType: "original" | "reprint" | "test";
  /** submitted_to_spooler | failed:<code> | skipped_duplicate */
  status: string;
  printedAtIso: string;
  printer: string;
  values: Record<string, string>;
}

const IST = "Asia/Kolkata";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** India financial year: April–March. */
export function dayParts(at: Date): { fy: string; month: string; day: string; ymd: string } {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (t: string) => Number(f.find((p) => p.type === t)!.value);
  const y = get("year"), mo = get("month"), d = get("day");
  const fyStart = mo >= 4 ? y : y - 1;
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    fy: `FY ${fyStart}-${pad((fyStart + 1) % 100)}`,
    month: `${pad(mo)} ${MONTHS[mo - 1]}`,
    day: `${pad(d)}-${pad(mo)}-${y}`,
    ymd: `${y}-${pad(mo)}-${pad(d)}`,
  };
}

const num = (s?: string) => (s !== undefined && s !== "" && !Number.isNaN(Number(s)) ? Number(s) : null);
const hhmm = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: IST, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(iso));

export interface BackupResult { jsonOk: boolean; xlsxOk: boolean; xlsxPath: string }

export class DailyBackup {
  constructor(
    private root: string,
    private now: () => Date = () => new Date(),
    private log: (m: string) => void = () => {},
  ) {}

  setRoot(root: string) { this.root = root; }
  getRoot() { return this.root; }

  private dayDir(parts: { fy: string; month: string }) { return join(this.root, parts.fy, parts.month); }
  private jsonPath(parts: { fy: string; month: string; day: string }) { return join(this.dayDir(parts), ".data", `${parts.day}.json`); }
  private xlsxPath(parts: { fy: string; month: string; day: string }) { return join(this.dayDir(parts), `${parts.day}.xlsx`); }

  /** Directory where PDF copies of printed slips are saved: <root>/FY 2026-27/10 October/PDFs */
  pdfDir(at: Date = this.now()): string {
    const parts = dayParts(at);
    return join(this.dayDir(parts), "PDFs");
  }

  /** Full path to save a PDF slip: <root>/FY 2026-27/10 October/PDFs/<cleanName>.pdf */
  pdfPath(fileName: string, at: Date = this.now()): string {
    const clean = fileName.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120) || "slip";
    const name = clean.toLowerCase().endsWith(".pdf") ? clean : `${clean}.pdf`;
    return join(this.pdfDir(at), name);
  }

  private readEntries(p: string): BackupEntry[] {
    try { return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as BackupEntry[]) : []; } catch { return []; }
  }

  /** Adds (or updates, by job id) one print result and refreshes that day's Excel file. Never throws. */
  async record(entry: BackupEntry): Promise<BackupResult> {
    const when = new Date(entry.printedAtIso || this.now().toISOString());
    const parts = dayParts(when);
    const json = this.jsonPath(parts);
    const xlsx = this.xlsxPath(parts);
    try {
      mkdirSync(join(this.dayDir(parts), ".data"), { recursive: true });
      const list = this.readEntries(json);
      const i = list.findIndex((e) => e.jobId === entry.jobId);
      if (i >= 0) list[i] = entry; else list.push(entry);
      list.sort((a, b) => a.printedAtIso.localeCompare(b.printedAtIso));
      writeFileSync(json + ".tmp", JSON.stringify(list));
      renameSync(json + ".tmp", json);
      this.markStale(parts.fy, parts.month, parts.day, true);
    } catch (e) {
      this.log(`backup: could not save data for ${parts.day}: ${(e as Error).message}`);
      return { jsonOk: false, xlsxOk: false, xlsxPath: xlsx };
    }
    const xlsxOk = await this.buildExcel(parts.fy, parts.month, parts.day);
    return { jsonOk: true, xlsxOk, xlsxPath: xlsx };
  }

  private stalePath() { return join(this.root, ".stale.json"); }
  private markStale(fy: string, month: string, day: string, on: boolean) {
    let s: string[] = [];
    try { s = existsSync(this.stalePath()) ? JSON.parse(readFileSync(this.stalePath(), "utf8")) : []; } catch { s = []; }
    const k = `${fy}|${month}|${day}`;
    s = on ? [...new Set([...s, k])] : s.filter((x) => x !== k);
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.stalePath(), JSON.stringify(s));
  }

  /** Re-tries Excel files that could not be written earlier (e.g. the file was open in Excel). Call on start-up / each tick. */
  async flush(): Promise<void> {
    let s: string[] = [];
    try { s = existsSync(this.stalePath()) ? JSON.parse(readFileSync(this.stalePath(), "utf8")) : []; } catch { return; }
    for (const k of s) { const [fy, month, day] = k.split("|") as [string, string, string]; await this.buildExcel(fy, month, day); }
  }

  /** Builds <day>.xlsx from the sidecar JSON. Returns false (and keeps the day marked stale) if the file is locked. */
  private async buildExcel(fy: string, month: string, day: string): Promise<boolean> {
    const parts = { fy, month, day };
    const entries = this.readEntries(this.jsonPath(parts));
    const out = this.xlsxPath(parts);
    const tmp = out + ".tmp";
    try {
      // the Excel library is large: it is loaded the first time a file is written, not at start-up (faster start, less memory while idle)
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      wb.creator = "Dharam Kata Print Agent";
      const ws = wb.addWorksheet("Invoices", { views: [{ state: "frozen", ySplit: 1 }] });
      // the firm's own extra fields (x1..x8) get their own columns when any entry has them
      const xKeys = [...new Set(entries.flatMap((e) => Object.keys(e.values).filter((k) => /^x[1-8]$/.test(k))))].sort();
      ws.columns = [
        { header: "S.No", key: "n", width: 6 }, { header: "Print time (IST)", key: "t", width: 12 }, { header: "Invoice no", key: "no", width: 22 },
        { header: "Type", key: "type", width: 10 }, { header: "Vehicle", key: "veh", width: 16 }, { header: "Party", key: "party", width: 24 }, { header: "Material", key: "mat", width: 20 },
        { header: "Loaded / first weight (kg)", key: "g", width: 17 }, { header: "Weighed date", key: "gd", width: 12 }, { header: "Weighed time", key: "gt", width: 11 },
        { header: "Empty (kg)", key: "tw", width: 13 }, { header: "Empty date", key: "td", width: 12 }, { header: "Empty time", key: "tt", width: 11 },
        { header: "Net (kg)", key: "net", width: 13 }, { header: "Amount (INR)", key: "chg", width: 14 }, { header: "Payment", key: "pay", width: 10 },
        { header: "Notes", key: "notes", width: 22 }, ...xKeys.map((k) => ({ header: `Extra field ${k.slice(1)}`, key: k, width: 20 })), { header: "Printer", key: "pr", width: 22 }, { header: "Print result", key: "st", width: 26 },
      ];
      ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
      ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B2D4C" } };
      entries.forEach((e, i) => {
        const v = e.values;
        ws.addRow({
          n: i + 1, t: hhmm(e.printedAtIso), no: v.serial ?? "", type: e.jobType === "reprint" ? "REPRINT" : e.jobType === "test" ? "TEST" : v.stage === "open" ? "Opening" : "Closing",
          veh: v.vehicle ?? "", party: v.party ?? "", mat: v.material ?? "", g: num(v.gross_weight), gd: v.gross_date ?? "", gt: v.gross_time ?? "",
          tw: num(v.tare_weight), td: v.tare_date ?? "", tt: v.tare_time ?? "", net: num(v.net_weight), chg: num(v.charge), pay: v.payment_mode ?? "",
          notes: v.notes ?? "", ...Object.fromEntries(xKeys.map((k) => [k, (v as Record<string, string>)[k] ?? ""])), pr: e.printer, st: e.status === "submitted_to_spooler" ? "Sent to Windows print queue" : e.status.replace(/^failed:/, "FAILED: "),
        });
      });
      for (const k of ["g", "tw", "net"]) ws.getColumn(k).numFmt = "#,##0.###";
      ws.getColumn("chg").numFmt = "#,##0.00";

      // totals count each INVOICE once (reprints/retries never double-count) and use its LAST printed amount:
      // the closing slip if there is one, else the opening slip (entries are sorted by print time)
      const seen = new Map<string, BackupEntry>();
      for (const e of entries) if (e.jobType !== "test") seen.set(e.values.serial ?? e.jobId, e);
      const inv = [...seen.values()];
      const sum = (f: (e: BackupEntry) => number) => inv.reduce((a, e) => a + f(e), 0);
      const sm = wb.addWorksheet("Summary");
      sm.columns = [{ width: 34 }, { width: 22 }];
      const rows: [string, string | number][] = [
        ["Date", day], ["Financial year", fy.replace("FY ", "")], ["", ""],
        ["Invoices", inv.length],
        ["Total net weight (kg)", sum((e) => num(e.values.net_weight) ?? 0)],
        ["Total amount (INR)", sum((e) => num(e.values.charge) ?? 0)],
        ["Cash invoices (INR)", sum((e) => (e.values.payment_mode === "cash" ? num(e.values.charge) ?? 0 : 0))],
        ["Credit invoices (INR)", sum((e) => (e.values.payment_mode === "credit" ? num(e.values.charge) ?? 0 : 0))],
        ["Reprints", entries.filter((e) => e.jobType === "reprint").length],
        ["Print jobs that failed", entries.filter((e) => e.status.startsWith("failed")).length],
        ["", ""], ["Last updated (IST)", `${hhmm(this.now().toISOString())}`],
        ["Note", "Backup of printed slips. Collections after printing are not included here."],
      ];
      rows.forEach((r) => sm.addRow(r));
      sm.getColumn(1).font = { bold: true };
      for (const r of [5, 6, 7, 8]) sm.getRow(r).getCell(2).numFmt = "#,##0.00";

      await wb.xlsx.writeFile(tmp);
      renameSync(tmp, out); // fails on Windows if the target is open in Excel -> caught below
      this.markStale(fy, month, day, false);
      return true;
    } catch (e) {
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
      this.log(`backup: ${day}.xlsx is busy or unwritable (${(e as Error).message}); it will be refreshed on the next print`);
      return false;
    }
  }

  /** For the UI: newest backup file and how many days are stored. */
  summary(): { days: number; latest?: string } {
    let days = 0; let latest: { p: string; m: number } | undefined;
    const walk = (dir: string, depth: number) => {
      let names: string[] = [];
      try { names = readdirSync(dir); } catch { return; }
      for (const n of names) {
        if (n.startsWith(".")) continue;
        const p = join(dir, n);
        let st; try { st = statSync(p); } catch { continue; }
        if (st.isDirectory() && depth < 2) walk(p, depth + 1);
        else if (n.endsWith(".xlsx")) { days++; if (!latest || st.mtimeMs > latest.m) latest = { p, m: st.mtimeMs }; }
      }
    };
    walk(this.root, 0);
    return { days, latest: latest?.p };
  }
}
