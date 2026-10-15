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
  /** `pdfTarget` resolves where each PDF file goes (full file path). */
  constructor(private readonly pdfTarget: (fileName: string) => string = () => "") {}

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
   * Silent print:
   * 1. Generates and saves a local PDF copy in the Financial Year folder.
   * 2. If physical printer, sends silently to Windows print spooler. If PDF/file printer, finishes with the saved PDF.
   */
  async print(html: string, o: { deviceName: string; widthMm: number; heightMm: number; copies: number; fileName?: string }): Promise<{ ok: boolean; error?: string; note?: string }> {
    // JavaScript is disabled in the render window: layout HTML is data, never executable.
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false, contextIsolation: true } });
    try {
      await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));

      // 1. Generate and save the local PDF copy into the Financial Year folder
      let savedPdfPath: string | undefined;
      const target = this.pdfTarget ? this.pdfTarget(safeName(o.fileName || "slip")) : "";
      if (target) {
        try {
          const pdfBuf = await win.webContents.printToPDF({
            printBackground: true,
            pageSize: { width: Math.round(o.widthMm * 1000), height: Math.round(o.heightMm * 1000) },
            margins: { marginType: "none" },
            landscape: false,
          });
          mkdirSync(join(target, ".."), { recursive: true });
          writeFileSync(target, pdfBuf);
          savedPdfPath = target;
        } catch {
          // PDF save error is ignored so it never blocks physical printing
        }
      }

      // 2. If it is a file printer (e.g. Microsoft Print to PDF, Adobe PDF), we already wrote the PDF file!
      if (isFilePrinter(o.deviceName)) {
        // a PDF printer prints nothing on paper: without the saved file the slip is lost, so that is a failure
        return savedPdfPath ? { ok: true, note: `PDF saved: ${savedPdfPath}` } : { ok: false, error: "pdf save failed" };
      }

      // 3. Otherwise send to physical printer (Windows spooler)
      return await new Promise<{ ok: boolean; error?: string; note?: string }>((resolve) => {
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
            resolve(success ? { ok: true, note: savedPdfPath ? `Printed & PDF saved: ${savedPdfPath}` : undefined } : { ok: false, error: reason });
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
