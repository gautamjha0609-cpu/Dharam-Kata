/**
 * Paper sizes that are realistically used to print a weighbridge invoice in India. Not a complete ISO list on purpose.
 * Any other size is possible with "Custom size" in the designer.
 */
export interface PaperSize {
  id: string;
  label: string;
  /** width x height in mm (as the form is fed/printed) */
  w: number;
  h: number;
  /** who uses it: shown under the dropdown so the owner picks the right one */
  note: string;
}

export const PAPER_SIZES: PaperSize[] = [
  { id: "ticket-170x95", label: "Ticket — 170 × 95 mm", w: 170, h: 95, note: "A small slip: pre-printed (dot-matrix) or printed in full on blank paper (laser)." },
  { id: "a4", label: "A4 — 210 × 297 mm", w: 210, h: 297, note: "Any laser or inkjet printer. Laser printers cannot print the outer ~5 mm." },
  { id: "a5-portrait", label: "A5 portrait — 148 × 210 mm", w: 148, h: 210, note: "Half of an A4 sheet, taller than wide." },
  { id: "a5-landscape", label: "A5 landscape — 210 × 148 mm", w: 210, h: 148, note: "Half of an A4 sheet, wider than tall." },
  { id: "cont-8x12", label: "8 × 12 in weighbridge slip — 203 × 305 mm", w: 203, h: 305, note: "Common pre-printed dot-matrix weighbridge slip stationery." },
  { id: "cont-95x11", label: "9.5 × 11 in continuous — 241 × 279 mm", w: 241, h: 279, note: "Full-size dot-matrix tractor paper." },
  { id: "cont-95x55", label: "9.5 × 5.5 in continuous — 241 × 140 mm", w: 241, h: 140, note: "Half-size dot-matrix tractor paper." },
  { id: "roll-80", label: "80 mm thermal roll — 80 × 200 mm", w: 80, h: 200, note: "Receipt-style printers. Length is automatic; keep the layout narrow." },
];

/** The preset that matches a size (within 0.6 mm), or undefined for a custom size. */
export function matchPaperSize(w: number, h: number): PaperSize | undefined {
  return PAPER_SIZES.find((p) => Math.abs(p.w - w) < 0.6 && Math.abs(p.h - h) < 0.6);
}
