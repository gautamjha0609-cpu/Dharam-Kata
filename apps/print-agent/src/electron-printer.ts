import { BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PrinterPort } from "./core";

/**
 * "Microsoft Print to PDF", "Adobe PDF", "CutePDF" ... are file printers: Windows opens a "Save print output as" window for every job, which a
 * silent agent can never answer (the job then ends as "Print job canceled"). For these the agent writes the PDF itself, straight into a folder.
 */
export const isFilePrinter = (name: string) => /pdf|xps document writer|print to file/i.test(name);
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120) || "slip";

let host: BrowserWindow | null = null;
function hostWindow(): BrowserWindow {
  if (!host || host.isDestroyed()) {
    host = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false, contextIsolation: true } });
    // if the helper page ever crashes, the next call simply makes a new one
    host.webContents.on("render-process-gone", () => { if (host && !host.isDestroyed()) host.destroy(); host = null; });
  }
  return host;
}

/** Windows PRINTER_STATUS_* bits we trust enough to act on. */
const OFFLINE = 0x80, PAPER_OUT = 0x10, PAPER_JAM = 0x8, NOT_AVAILABLE = 0x1000;

export class ElectronPrinter implements PrinterPort {
  /** `pdfDir` tells where PDF files go (a folder on this PC; created when needed). */
  constructor(private readonly pdfDir: () => string = () => "") {}

  async list(): Promise<string[]> {
    const printers = await hostWindow().webContents.getPrintersAsync();
    return printers.map((p) => p.name);
  }

  async listWithStatus(): Promise<{ name: string; status: string }[]> {
    const printers = await hostWindow().webContents.getPrintersAsync();
    return printers.map((p) => ({ name: p.name, status: statusText(p.status ?? 0) }));
  }

  async check(name: string): Promise<string | null> {
    const p = (await hostWindow().webContents.getPrintersAsync()).find((x) => x.name === name);
    return p ? statusCode(p.status ?? 0) : "printer_missing";
  }

  /**
   * Silent print: no dialog, exact Windows device name, fixed page size in microns, zero margins, 100% scale.
   * The callback means the OS print subsystem accepted/rejected the job. It is NOT proof of paper output.
   */
  async print(html: string, o: { deviceName: string; widthMm: number; heightMm: number; copies: number; fileName?: string }): Promise<{ ok: boolean; error?: string; note?: string }> {
    // JavaScript is disabled in the render window: layout HTML is data, never executable.
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false, contextIsolation: true } });
    try {
      await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
      const dir = this.pdfDir();
      if (dir && isFilePrinter(o.deviceName)) {
        // the page size comes from the layout's own @page rule (paper size in mm, zero margins), so the PDF is exactly the slip
        const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        const d = new Date();
        const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const folder = join(dir, day);
        mkdirSync(folder, { recursive: true });
        const file = join(folder, `${safeName(o.fileName ?? `slip_${d.getHours()}${d.getMinutes()}${d.getSeconds()}`)}.pdf`);
        writeFileSync(file, pdf);
        return { ok: true, note: `${o.deviceName} cannot print silently, so the slip was saved as a PDF file: ${file}` };
      }
      return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, error: "print timeout" }), 60_000);
        win.webContents.print(
          {
            silent: true,
            deviceName: o.deviceName,
            printBackground: true,
            margins: { marginType: "none" },
            pageSize: { width: Math.round(o.widthMm * 1000), height: Math.round(o.heightMm * 1000) },
            scaleFactor: 100,
            copies: Math.max(1, Math.min(5, o.copies)),
            landscape: false,
          },
          (success, reason) => {
            clearTimeout(timer);
            resolve(success ? { ok: true } : { ok: false, error: reason });
          },
        );
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "render failed" };
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }
}

function statusCode(s: number): string | null {
  if (s & PAPER_JAM) return "paper_jam";
  if (s & PAPER_OUT) return "paper_out";
  if (s & (OFFLINE | NOT_AVAILABLE)) return "printer_offline";
  return null;
}
function statusText(s: number): string {
  return statusCode(s) ?? "ready";
}
