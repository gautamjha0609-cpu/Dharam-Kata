// Dev check: renders a real print payload with the SAME engine the agent uses, to a 170x95 mm PDF via Electron.
// Run: pnpm exec esbuild scripts/render-check.ts --bundle --platform=node --external:electron --outfile=dist-check/check.js && npx electron dist-check/check.js
import { app, BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import { applyFullDesign, renderHtml, blankTicketPreset, ticketPreset } from "@dk/print-template";

const payload = JSON.parse(process.env.PAYLOAD ?? "{}");
const off = JSON.parse(process.env.OFFSET ?? "{\"x\":0,\"y\":0}");
const out = process.env.OUT ?? "check.pdf";

app.whenReady().then(async () => {
  const [pw, ph] = (process.env.PAPER ?? "170x95").split("x").map(Number) as [number, number];
  const base = { ...(process.env.PRESET === "blank" ? blankTicketPreset() : ticketPreset()), paper: { w: pw, h: ph } };
  const layout = process.env.PRESET === "fulldesign" ? applyFullDesign(base) : base;
  layout.offset = { x: off.x, y: off.y };
  const values = Object.fromEntries(Object.entries(payload).filter(([k, v]) => !k.startsWith("_") && typeof v === "string"));
  const { html, warnings } = renderHtml(layout, values);
  console.log("warnings:", JSON.stringify(warnings));
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  const pdf = await win.webContents.printToPDF({ pageSize: { width: pw / 25.4, height: ph / 25.4 }, margins: { marginType: "none" }, printBackground: true });
  writeFileSync(out, pdf);
  const shot = new BrowserWindow({ show: false, width: Math.round(pw * 3.78), height: Math.round(ph * 3.78), useContentSize: true, webPreferences: { javascript: false, offscreen: false } });
  await shot.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  shot.webContents.setZoomFactor(1200 / (pw * 3.78));
  shot.setContentSize(1200, Math.round((1200 * ph) / pw));
  await new Promise((r) => setTimeout(r, 600));
  writeFileSync(out.replace(/.pdf$/, ".png"), (await shot.webContents.capturePage()).toPNG());
  console.log("wrote", out, pdf.length, "bytes");
  app.quit();
});
