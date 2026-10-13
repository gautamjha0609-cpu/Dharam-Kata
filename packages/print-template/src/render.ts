import { approxMeasure, fitText, PT_TO_MM, type Measure } from "./fit";
import { fieldText, type Layout, type PrintValues } from "./layout";

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export interface RenderWarning {
  fieldId: string;
  kind: "overflow" | "below_floor";
}

export interface RenderOptions {
  measure?: Measure;
  /** Draws field boxes. Never used for real invoices. */
  debugBoxes?: boolean;
  /** Optional faint scan of the pre-printed ticket under the print layer (designer preview only). */
  underlayDataUrl?: string;
  /** Reprint: adds the layout's reprint mark (if enabled). The invoice number/values are never changed. */
  reprint?: boolean;
}

const mmStr = (n: number) => n.toFixed(2) + "mm";

/**
 * Layout JSON + values -> fixed-size HTML (mm). Only allow-listed CSS is emitted and
 * every value is HTML-escaped, so a party name like "<script>" can never execute (SRS §7.1).
 * In "blank" mode the static decor (text/lines/boxes) is drawn too; in "preprinted" mode it is skipped.
 */
export function renderHtml(layout: Layout, values: PrintValues, opts: RenderOptions = {}): { html: string; warnings: RenderWarning[] } {
  const measure = opts.measure ?? approxMeasure;
  const warnings: RenderWarning[] = [];
  const ox = layout.printArea.x + layout.offset.x;
  const oy = layout.printArea.y + layout.offset.y;
  const parts: string[] = [];

  if (layout.mode === "blank") {
    for (const d of layout.decor) {
      const px = layout.offset.x + d.x;
      const py = layout.offset.y + d.y;
      if (d.type === "text") {
        const fit = fitText(d.text, { w: d.w, h: d.h, font: { family: d.font.family, minPt: 5, maxPt: d.font.pt, bold: d.font.bold }, fit: "shrink", maxLines: 1, lineHeight: 1.1 }, 5, measure);
        parts.push(`<div style="position:absolute;left:${mmStr(px)};top:${mmStr(py)};width:${mmStr(d.w)};height:${mmStr(d.h)};font-family:'${d.font.family}','Nirmala UI',monospace;font-size:${fit.pt}pt;line-height:${mmStr(fit.pt * PT_TO_MM * 1.1)};font-weight:${d.font.bold ? 700 : 400};font-style:${d.font.italic ? "italic" : "normal"};text-decoration:${d.font.underline ? "underline" : "none"};text-align:${d.align};white-space:pre;overflow:hidden">${esc(fit.lines.join("\n"))}</div>`);
      } else if (d.type === "line") {
        const horizontal = d.h <= d.w;
        parts.push(`<div style="position:absolute;left:${mmStr(px)};top:${mmStr(py)};width:${horizontal ? mmStr(d.w) : "0"};height:${horizontal ? "0" : mmStr(d.h)};${horizontal ? `border-top:${mmStr(d.weight)} solid #000` : `border-left:${mmStr(d.weight)} solid #000`}"></div>`);
      } else {
        parts.push(`<div style="position:absolute;left:${mmStr(px)};top:${mmStr(py)};width:${mmStr(d.w)};height:${mmStr(d.h)};border:${mmStr(d.weight)} solid #000;box-sizing:border-box"></div>`);
      }
    }
  }

  for (const f of [...layout.fields].filter((x) => x.visible).sort((a, b) => a.order - b.order)) {
    const raw = values[f.key];
    if (raw === undefined || raw === "") continue;
    const text = fieldText(layout, f, raw, values.stage);
    const fit = fitText(text, f, layout.legibilityFloorPt, measure);
    if (fit.overflow) warnings.push({ fieldId: f.id, kind: "overflow" });
    else if (fit.belowFloor) warnings.push({ fieldId: f.id, kind: "below_floor" });
    const lineMm = fit.pt * PT_TO_MM * f.lineHeight;
    const css = [
      "position:absolute",
      `left:${mmStr(ox + f.x)}`,
      `top:${mmStr(oy + f.y)}`,
      `width:${mmStr(f.w)}`,
      `height:${mmStr(f.h)}`,
      `font-family:'${f.font.family}','Nirmala UI',monospace`, // Hindi characters always fall back to Nirmala UI (installed with Windows 10/11)
      `font-size:${fit.pt}pt`,
      `line-height:${lineMm.toFixed(3)}mm`,
      `font-weight:${f.font.bold ? 700 : 400}`,
      `font-style:${f.font.italic ? "italic" : "normal"}`,
      `text-decoration:${f.font.underline ? "underline" : "none"}`,
      `text-align:${f.align}`,
      "white-space:pre",
      "overflow:hidden",
      opts.debugBoxes ? "outline:0.2mm dashed #19B957" : "",
    ]
      .filter(Boolean)
      .join(";");
    parts.push(`<div style="${css}">${fit.lines.map(esc).join("\n")}</div>`);
  }

  const rm = layout.reprintMark;
  if (opts.reprint && rm?.enabled) {
    parts.push(
      `<div style="position:absolute;left:${mmStr(ox + rm.x)};top:${mmStr(oy + rm.y)};width:${mmStr(rm.w)};height:${mmStr(rm.h)};font-family:'Courier New','Nirmala UI',monospace;font-size:${rm.pt}pt;font-weight:700;text-align:center;white-space:pre;overflow:hidden;border:0.3mm solid #000">${esc(rm.text)}</div>`,
    );
  }

  const { w, h } = layout.paper;
  const underlay = opts.underlayDataUrl?.startsWith("data:image/")
    ? `<img src="${esc(opts.underlayDataUrl)}" style="position:absolute;left:0;top:0;width:${w}mm;height:${h}mm;opacity:.25"/>`
    : "";
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
    `@page{size:${w}mm ${h}mm;margin:0}` +
    `html,body{margin:0;padding:0;background:#fff;color:#000}` +
    `.sheet{position:relative;width:${w}mm;height:${h}mm;overflow:hidden}` +
    `</style></head><body><div class="sheet">${underlay}${parts.join("")}</div></body></html>`;
  return { html, warnings };
}

/**
 * Calibration sheet: clearly labelled TEST. Rulers (1 mm ticks, numbered every 10 mm) along the top and left edges,
 * a 10 mm grid, the printable-area frame with corner alignment marks, and a 100 mm measuring bar so a ruler held
 * against the paper reveals any scaling error. A line-spacing block lets you check feed distance.
 */
export function renderCalibrationHtml(layout: Layout): string {
  const { w, h } = layout.paper;
  const a = layout.printArea;
  const ox = a.x + layout.offset.x;
  const oy = a.y + layout.offset.y;
  const out: string[] = [];
  const div = (css: string, inner = "") => out.push(`<div style="position:absolute;${css}">${inner}</div>`);

  for (let x = 0; x <= w; x += 10) div(`left:${x}mm;top:0;width:0;height:${h}mm;border-left:0.08mm solid #999`);
  for (let y = 0; y <= h; y += 10) div(`top:${y}mm;left:0;height:0;width:${w}mm;border-top:0.08mm solid #999`);
  // top + left rulers
  for (let x = 0; x <= w; x++) {
    const len = x % 10 === 0 ? 4 : x % 5 === 0 ? 3 : 1.6;
    div(`left:${x}mm;top:0;width:0;height:${len}mm;border-left:0.12mm solid #000`);
    if (x % 10 === 0) div(`left:${x + 0.4}mm;top:4.2mm;font:5pt monospace`, String(x));
  }
  for (let y = 0; y <= h; y++) {
    const len = y % 10 === 0 ? 4 : y % 5 === 0 ? 3 : 1.6;
    div(`top:${y}mm;left:0;height:0;width:${len}mm;border-top:0.12mm solid #000`);
    if (y % 10 === 0 && y > 0) div(`top:${y + 0.3}mm;left:4.4mm;font:5pt monospace`, String(y));
  }
  // printable area frame + corner alignment marks (crosshair + corner ticks)
  div(`left:${ox}mm;top:${oy}mm;width:${a.w}mm;height:${a.h}mm;border:0.4mm solid #000;box-sizing:border-box`);
  for (const [cx, cy] of [[ox, oy], [ox + a.w, oy], [ox, oy + a.h], [ox + a.w, oy + a.h]] as const) {
    div(`left:${cx - 3}mm;top:${cy}mm;width:6mm;height:0;border-top:0.2mm solid #000`);
    div(`left:${cx}mm;top:${cy - 3}mm;width:0;height:6mm;border-left:0.2mm solid #000`);
  }
  // 100 mm (or 50 mm) measuring bar
  const bar = w >= 120 ? 100 : 50;
  const by = oy + a.h - 9;
  div(`left:${ox + 4}mm;top:${by}mm;width:${bar}mm;height:0;border-top:0.5mm solid #000`);
  div(`left:${ox + 4}mm;top:${by - 2}mm;width:0;height:4mm;border-left:0.3mm solid #000`);
  div(`left:${ox + 4 + bar}mm;top:${by - 2}mm;width:0;height:4mm;border-left:0.3mm solid #000`);
  div(`left:${ox + 4}mm;top:${by + 1}mm;font:6pt monospace;white-space:pre`, `${bar} mm - measure this bar with a ruler`);
  // line-spacing block: 5 lines at 5 mm pitch
  for (let i = 0; i < 5; i++) div(`left:${ox + a.w - 40}mm;top:${oy + 8 + i * 5}mm;font:6pt monospace;white-space:pre`, `LINE ${i + 1} = ${(8 + i * 5).toFixed(0)} mm from top`);
  div(`left:${ox + 3}mm;top:${oy + 2}mm;font:bold 8pt monospace;white-space:pre`, `*** CALIBRATION TEST - NOT AN INVOICE *** area ${a.w}x${a.h} mm, offset ${layout.offset.x}/${layout.offset.y}`);
  return `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:${w}mm ${h}mm;margin:0}html,body{margin:0;background:#fff}.sheet{position:relative;width:${w}mm;height:${h}mm;overflow:hidden}</style></head><body><div class="sheet">${out.join("")}</div></body></html>`;
}
