import { FONT_FAMILIES, type FontFamily, type LayoutField } from "./layout";

export const PT_TO_MM = 25.4 / 72;

/** Returns the rendered width of `text` in mm at `pt` points. Inject canvas-based metrics in a browser/Electron. */
export type Measure = (text: string, family: FontFamily, pt: number, bold: boolean) => number;

/**
 * Deterministic fallback metrics. Monospace fonts are exact (0.6 em/char, Courier New).
 * Proportional fonts use a conservative (slightly wide) average so we err toward shrinking, never overflow.
 * Devanagari glyphs are wider; treat any non-ASCII char as 0.75 em.
 */
export const approxMeasure: Measure = (text, family, pt, bold) => {
  const em = pt * PT_TO_MM;
  if (FONT_FAMILIES[family].mono) {
    let units = 0;
    for (const ch of text) units += ch.charCodeAt(0) > 127 ? 0.8 : 0.6; // Courier-style fonts fall back to a wider Hindi font
    return units * em;
  }
  let units = 0;
  for (const ch of text) units += ch.charCodeAt(0) > 127 ? 0.75 : /[A-Z0-9]/.test(ch) ? 0.62 : 0.52;
  return units * em * (bold ? 1.08 : 1);
};

export interface FitResult {
  pt: number;
  lines: string[];
  /** true when the text could not fit even at the minimum size (clipped/truncated). */
  overflow: boolean;
  /** true when the chosen size is below the layout's legibility floor. */
  belowFloor: boolean;
}

const STEP = 0.25;

function wrap(text: string, maxW: number, m: (s: string) => number, maxLines: number): string[] | null {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (m(t) <= maxW) cur = t;
    else {
      if (cur) lines.push(cur);
      if (m(w) > maxW) return null; // single word wider than the box
      cur = w;
    }
    if (lines.length >= maxLines) return null;
  }
  if (cur) lines.push(cur);
  return lines.length <= maxLines ? lines : null;
}

/**
 * Pick the LARGEST size in [minPt, maxPt] at which `text` fits the field box
 * (width for single line; width + height for wrapped text). If nothing fits,
 * uses minPt and flags overflow so the designer/agent can warn instead of printing garbage.
 */
export function fitText(
  text: string,
  f: Pick<LayoutField, "w" | "h" | "font" | "fit" | "maxLines" | "lineHeight">,
  floorPt: number,
  measure: Measure = approxMeasure,
): FitResult {
  const { family, minPt, maxPt, bold } = f.font;
  const fam = family as FontFamily;
  const clean = text.replace(/\s+/g, " ").trim();
  const fitsHeight = (pt: number, n: number) => n * pt * PT_TO_MM * f.lineHeight <= f.h + 1e-6;

  for (let pt = maxPt; pt >= minPt - 1e-9; pt -= STEP) {
    const m = (s: string) => measure(s, fam, pt, bold);
    if (f.fit === "wrap" && f.maxLines > 1) {
      const lines = wrap(clean, f.w, m, f.maxLines);
      if (lines && fitsHeight(pt, lines.length)) return { pt, lines, overflow: false, belowFloor: pt < floorPt };
    } else if (m(clean) <= f.w + 1e-6 && fitsHeight(pt, 1)) {
      return { pt, lines: [clean], overflow: false, belowFloor: pt < floorPt };
    } else if (!fitsHeight(pt, 1)) {
      continue; // too tall at this size; go smaller
    }
  }
  // Nothing fit at minPt: truncate with an ellipsis-free hard cut so we never overflow the box.
  const m = (s: string) => measure(s, fam, minPt, bold);
  let cut = clean;
  while (cut.length > 0 && m(cut) > f.w) cut = cut.slice(0, -1);
  return { pt: minPt, lines: [cut], overflow: true, belowFloor: minPt < floorPt };
}
