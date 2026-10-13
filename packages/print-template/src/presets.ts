import { DEFAULT_LABELS, LayoutSchema, autoReprintMark, type Decor, type Layout, type LayoutField } from "./layout";

type Box = Pick<LayoutField, "x" | "y" | "w" | "h">;

function f(key: LayoutField["key"], b: Box, maxPt: number, extra: Partial<LayoutField> = {}): LayoutField {
  return {
    id: key, key, visible: true, order: 0, ...b, showLabel: false,
    labelEn: (DEFAULT_LABELS as Record<string, { en: string; hi: string }>)[key]!.en || undefined, labelHi: (DEFAULT_LABELS as Record<string, { en: string; hi: string }>)[key]!.hi || undefined,
    font: { family: "Courier New", minPt: 8, maxPt, bold: false },
    align: "left", fit: "shrink", maxLines: 1, lineHeight: 1.1, ...extra,
  };
}

/**
 * "Vinayak Pre-printed Ticket 170 x 95 mm" (SRS A2.3): full paper 170x95, variable-data area 150x50.
 * The ticket's header, logo and footer are pre-printed and are NOT sent to the printer.
 *
 * Positions were measured from the supplied sample ticket photo (1210x674 px = 170x95 mm, 7.12 px/mm):
 * serial/vehicle on the top line, "MATERIAL :" and "PARTY :" lines (these two labels are printed by the
 * dot-matrix in the sample), then the loaded / empty / net weight rows and the charge.
 * They are still estimates from a photo: calibrate the X/Y offset on the real printer before go-live.
 */
export function ticketPreset(): Layout {
  const fields = [
    f("serial", { x: 16, y: 3, w: 30, h: 5 }, 11),
    f("vehicle", { x: 58, y: 4, w: 54, h: 5.5 }, 13, { font: { family: "Courier New", minPt: 8, maxPt: 13, bold: true } }),
    f("material", { x: 2, y: 8.5, w: 57, h: 5 }, 11, { showLabel: true, label: "MATERIAL :", labelEn: "MATERIAL :", labelHi: "माल :" }),
    f("party", { x: 60, y: 9.5, w: 62, h: 5 }, 11, { showLabel: true, label: "PARTY      :", labelEn: "PARTY      :", labelHi: "विक्रेता :" }),
    f("gross_weight", { x: 5.4, y: 14.5, w: 24, h: 6 }, 13),
    f("gross_date", { x: 53, y: 15.8, w: 26, h: 5 }, 11),
    f("gross_time", { x: 84, y: 15.8, w: 16, h: 5 }, 11),
    f("tare_weight", { x: 5.4, y: 21.5, w: 24, h: 6 }, 13),
    f("tare_date", { x: 53, y: 23, w: 26, h: 5 }, 11),
    f("tare_time", { x: 84, y: 23, w: 16, h: 5 }, 11),
    f("net_weight", { x: 5.4, y: 28, w: 24, h: 6 }, 13, { font: { family: "Courier New", minPt: 8, maxPt: 13, bold: true } }),
    f("charge", { x: 31, y: 38, w: 18, h: 5 }, 11),
  ].map((x, i) => ({ ...x, order: i }));
  return LayoutSchema.parse({
    version: 1,
    name: "Pre-printed ticket 170 x 95 mm",
    paper: { w: 170, h: 95 },
    printArea: { x: 10, y: 32, w: 150, h: 50 },
    offset: { x: 0, y: 0 },
    orientation: "landscape",
    scale: 1,
    legibilityFloorPt: 8,
    fields,
  });
}

/** The firm's own header / footer wording. Empty text prints nothing; the firm fills it in once in the designer. */
export interface DesignContent { title: string; address: string; line2: string; phone: string; note1: string; note2: string; signature: string }
export const BLANK_CONTENT: DesignContent = { title: "", address: "", line2: "", phone: "", note1: "", note2: "", signature: "Authorised signature" };
const CONTENT_IDS: Record<keyof DesignContent, string> = { title: "firm", address: "addr", line2: "govt", phone: "phone", note1: "n1", note2: "n2", signature: "sign" };
/** Wording currently in a layout's design elements (so re-fitting to a new paper keeps what the firm typed). */
export function contentFromLayout(layout: Pick<Layout, "decor">): Partial<DesignContent> {
  const out: Partial<DesignContent> = {};
  for (const k of Object.keys(CONTENT_IDS) as (keyof DesignContent)[]) {
    const d = layout.decor.find((x) => x.id === CONTENT_IDS[k]);
    if (d && d.type === "text") out[k] = d.text;
  }
  return out;
}

const hiText = (id: string, x: number, y: number, w: number, h: number, text: string, pt: number, bold = false, align: "left" | "center" | "right" = "center"): Decor => ({
  id, type: "text", x, y, w, h, text, font: { family: "Nirmala UI", pt, bold }, align,
});

/**
 * "Vinayak ticket 170 x 95 mm, blank paper" for a printer that cannot take the pre-printed form (e.g. a laser such as the
 * Canon imageCLASS MF3010): SAME paper size and the SAME field positions as the pre-printed ticket, but the software also
 * draws the firm header, frame, notes and signature line, and prints Hindi headings. Header text is compact so the
 * variable area stays where the pre-printed version has it.
 */
export function blankTicketPreset(): Layout {
  const heading = { family: "Nirmala UI" as const, minPt: 7, maxPt: 11, bold: false };
  const val = (key: LayoutField["key"], b: Box, extra: Partial<LayoutField> = {}) =>
    f(key, b, 11, { showLabel: true, font: heading, ...extra });
  const fields = [
    val("serial", { x: 2, y: 2, w: 62, h: 5.5 }),
    val("vehicle", { x: 66, y: 2, w: 82, h: 5.5 }, { font: { ...heading, bold: true } }),
    val("material", { x: 2, y: 9, w: 70, h: 5.5 }),
    val("party", { x: 74, y: 9, w: 74, h: 5.5 }),
    val("gross_weight", { x: 2, y: 16, w: 48, h: 5.5 }),
    val("gross_date", { x: 52, y: 16, w: 52, h: 5.5 }),
    val("gross_time", { x: 106, y: 16, w: 42, h: 5.5 }),
    val("tare_weight", { x: 2, y: 23, w: 48, h: 5.5 }),
    val("tare_date", { x: 52, y: 23, w: 52, h: 5.5 }),
    val("tare_time", { x: 106, y: 23, w: 42, h: 5.5 }),
    val("net_weight", { x: 2, y: 30, w: 48, h: 6 }, { font: { ...heading, bold: true } }),
    val("charge", { x: 52, y: 30, w: 70, h: 6 }, { font: { ...heading, bold: true } }),
  ].map((x, i) => ({ ...x, order: i }));

  const decor: Decor[] = [
    { id: "frame", type: "rect", x: 3, y: 2, w: 164, h: 91, weight: 0.3 },
    hiText("firm", 6, 3.5, 158, 8, "", 15, true),
    hiText("addr", 6, 12, 158, 4.5, "", 8),
    hiText("govt", 6, 16.5, 158, 4, "", 7),
    { id: "phone", type: "text", x: 6, y: 20.5, w: 158, h: 4, text: "", font: { family: "Nirmala UI", pt: 7, bold: true }, align: "center" },
    { id: "rule1", type: "line", x: 3, y: 26, w: 164, h: 0, weight: 0.25 },
    { id: "rule2", type: "line", x: 3, y: 82, w: 164, h: 0, weight: 0.25 },
    hiText("n1", 5, 83, 110, 3.5, "", 6, false, "left"),
    hiText("n2", 5, 87, 110, 3.5, "", 6, false, "left"),
    hiText("sign", 116, 85, 48, 5, "Authorised signature", 8, true, "right"),
  ];

  return LayoutSchema.parse({
    version: 1,
    name: "Blank paper ticket 170 x 95 mm (laser)",
    paper: { w: 170, h: 95 },
    printArea: { x: 10, y: 28, w: 150, h: 54 },
    offset: { x: 0, y: 0 },
    orientation: "landscape",
    scale: 1,
    legibilityFloorPt: 7,
    mode: "blank",
    labelLang: "hi",
    decor,
    fields,
    reprintMark: { enabled: true, text: "DUPLICATE", x: 100, y: 38, w: 44, h: 9, pt: 14 },
  });
}

export class DesignError extends Error {}

/**
 * "Print the full design": draws the firm's header, frame, notes and signature line AND the details, scaled to ANY paper
 * size. The paper is split into header (top), printing area (middle, where the details go) and footer (bottom). Existing
 * field styling (bold/italic/size/headings) is kept; only positions are recomputed. Replaces the layout's static design
 * elements, sets mode "blank" and the printing area. Narrow paper (< 120 mm wide, e.g. 80 mm rolls) is refused: use a
 * simple details-only layout there.
 */
export function applyFullDesign(layout: Layout, defaults: Partial<DesignContent> = {}): Layout {
  const c: DesignContent = { ...BLANK_CONTENT, ...defaults, ...contentFromLayout(layout) };
  const { w, h } = layout.paper;
  if (w < 120) throw new DesignError("This paper is too narrow for the full header design. Use the details-only option, or a wider paper.");
  const k = Math.min(1.5, Math.max(0.65, w / 170)); // text scale relative to the 170 mm ticket
  const r2 = (n: number) => Math.round(n * 2) / 2;
  const inset = Math.min(5, Math.max(2.5, w * 0.018));
  const headH = Math.min(48, Math.max(24, h * 0.28));
  const footH = Math.min(22, Math.max(11, h * 0.115));
  const areaX = inset + 3;
  const areaY = inset + headH + 2;
  const areaW = w - 2 * areaX;
  const areaH = h - areaY - (footH + inset + 2);
  if (areaH < 24) throw new DesignError("This paper is too short for the full design. Use the details-only option, or a taller paper.");

  const inner = w - 2 * (inset + 3);
  const bottom = h - inset - footH;
  const decor: Decor[] = [
    { id: "frame", type: "rect", x: inset, y: inset, w: w - 2 * inset, h: h - 2 * inset, weight: 0.3 },
    hiText("firm", inset + 3, inset + 1.5, inner, 8.5 * k, c.title, r2(15 * k), true),
    hiText("addr", inset + 3, inset + 1.5 + 9.5 * k, inner, 4.6 * k, c.address, r2(8 * k)),
    hiText("govt", inset + 3, inset + 1.5 + 14.2 * k, inner, 4.2 * k, c.line2, r2(7 * k)),
    { id: "phone", type: "text", x: inset + 3, y: inset + 1.5 + 18.6 * k, w: inner, h: 4.2 * k, text: c.phone, font: { family: "Nirmala UI", pt: r2(7 * k), bold: true }, align: "center" },
    { id: "rule1", type: "line", x: inset, y: inset + headH, w: w - 2 * inset, h: 0, weight: 0.25 },
    { id: "rule2", type: "line", x: inset, y: bottom, w: w - 2 * inset, h: 0, weight: 0.25 },
    hiText("n1", inset + 2, bottom + 1, (w - 2 * inset) * 0.64, 3.8 * k, c.note1, Math.max(5, r2(6 * k)), false, "left"),
    hiText("n2", inset + 2, bottom + 1 + 4.2 * k, (w - 2 * inset) * 0.64, 3.8 * k, c.note2, Math.max(5, r2(6 * k)), false, "left"),
    hiText("sign", inset + (w - 2 * inset) * 0.66, bottom + (footH - 5 * k) / 2, (w - 2 * inset) * 0.32, 5 * k, c.signature, Math.max(6, r2(8 * k)), true, "right"),
  ];

  // reposition the existing fields proportionally from the reference (150 x 54 mm) arrangement
  const ref = blankTicketPreset();
  const sx = areaW / ref.printArea.w;
  const sy = Math.min(3, Math.max(0.5, areaH / ref.printArea.h));
  const fields = layout.fields.map((f) => {
    const b = ref.fields.find((x) => x.key === f.key);
    if (!b) return f;
    const pt = Math.min(18, Math.max(8, r2(b.font.maxPt * k)));
    return { ...f, x: b.x * sx, y: b.y * sy, w: b.w * sx, h: Math.min(b.h * Math.min(sy, 1.5), areaH - b.y * sy), showLabel: true, font: { ...f.font, maxPt: pt, minPt: Math.min(f.font.minPt, pt) } };
  });

  const r1 = (n: number) => Math.round(n * 10) / 10;
  const roundBox = <T extends { x?: number; y?: number; w?: number; h?: number }>(o: T): T => ({ ...o, ...(o.x !== undefined && { x: r1(o.x) }), ...(o.y !== undefined && { y: r1(o.y) }), ...(o.w !== undefined && { w: r1(o.w) }), ...(o.h !== undefined && { h: r1(o.h) }) });
  const rm = layout.reprintMark;
  return LayoutSchema.parse({
    ...layout,
    mode: "blank",
    printArea: { x: r1(areaX), y: r1(areaY), w: r1(areaW), h: r1(areaH) },
    decor: decor.map(roundBox),
    fields: fields.map(roundBox),
    reprintMark: autoReprintMark({ w: r1(areaW), h: r1(areaH) }),
  });
}
