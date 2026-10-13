import ExcelJS from "exceljs";
import JSZip from "jszip";
import { PT_TO_MM } from "./fit";
import { DEFAULT_LABELS, LayoutSchema, type FieldKey, type Layout, type LayoutField } from "./layout";

/**
 * Imports an Excel ticket template (labels + value cells + merged ranges) into a Layout.
 * Geometry: Excel column widths / row heights -> mm, scaled into the printable area.
 * Text sizes are NOT blindly scaled: maxPt = min(Excel size, what fits the scaled box height),
 * and the shared fit engine shrinks per value at print time (SRS A2 / owner requirement).
 */

type Kind = FieldKey | "date" | "time" | "unit" | null;

const LABELS: Array<[RegExp, Kind]> = [
  [/क्रम|serial|sr\.?\s*no|invoice\s*no/i, "serial"],
  [/विक्रेता|party|seller|customer/i, "party"],
  [/माल|material|goods/i, "material"],
  [/वाहन|vehicle/i, "vehicle"],
  [/भरा|loaded|gross/i, "gross_weight"],
  [/खाली|empty|tare/i, "tare_weight"],
  [/शुद्ध|net/i, "net_weight"],
  [/नोट|notes?|remark/i, "notes"],
  [/तारीख|date/i, "date"],
  [/समय|time/i, "time"],
  [/कि\.?\s*ग्रा|^\s*kgs?\s*$/i, "unit"],
];

function classify(text: string): Kind {
  const t = text.replace(/[:：]\s*$/, "").trim();
  for (const [re, kind] of LABELS) if (re.test(t)) return kind;
  return null;
}

const colMm = (chars: number) => (((chars || 8.43) * 7 + 5) * 25.4) / 96;
const rowMm = (pt: number | undefined) => ((pt || 15) * 25.4) / 72;
const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Some generators (OpenXML SDK) emit every element with an `x:` namespace prefix, which ExcelJS cannot read.
 * Strip the prefix from the XML parts before loading. Harmless for ordinary files.
 */
async function normalizeXlsx(data: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(data);
  let changed = false;
  for (const name of Object.keys(zip.files)) {
    if (!/\.(xml|rels)$/.test(name)) continue;
    const xml = await zip.file(name)!.async("string");
    if (!/<x:/.test(xml)) continue;
    zip.file(name, xml.replace(/<(\/?)x:/g, "<$1").replace(/xmlns:x=/g, "xmlns="));
    changed = true;
  }
  return changed ? zip.generateAsync({ type: "uint8array" }) : data instanceof Uint8Array ? data : new Uint8Array(data);
}

interface Merge { r1: number; c1: number; r2: number; c2: number }

export interface ImportReport {
  mapped: FieldKey[];
  unmappedLabels: string[];
  sheetMm: { w: number; h: number };
}

export interface ImportOptions {
  paper?: { w: number; h: number };
  printArea?: { x: number; y: number; w: number; h: number };
  name?: string;
  floorPt?: number;
}

export async function importLayoutFromXlsx(
  data: ArrayBuffer | Uint8Array,
  opts: ImportOptions = {},
): Promise<{ layout: Layout; report: ImportReport }> {
  const paper = opts.paper ?? { w: 170, h: 95 };
  const area = opts.printArea ?? { x: 10, y: 32, w: 150, h: 50 };
  const floor = opts.floorPt ?? 8;

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await normalizeXlsx(data)) as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("Workbook has no sheet");

  const maxC = Math.max(ws.columnCount, 1);
  const maxR = Math.max(ws.rowCount, 1);

  const colW = Array.from({ length: maxC }, (_, i) => colMm(ws.getColumn(i + 1).width ?? 0));
  const rowH = Array.from({ length: maxR }, (_, i) => rowMm(ws.getRow(i + 1).height));
  const colX = [0];
  colW.forEach((w, i) => colX.push((colX[i] ?? 0) + w));
  const rowY = [0];
  rowH.forEach((h, i) => rowY.push((rowY[i] ?? 0) + h));
  const sheetW = colX[maxC] ?? 1;
  const sheetH = rowY[maxR] ?? 1;

  // merges: master "r,c" -> extent ; and any covered cell -> master
  const merges = new Map<string, Merge>();
  const covered = new Map<string, string>();
  for (const addr of (ws.model.merges ?? []) as string[]) {
    const [a, b] = addr.split(":");
    if (!a || !b) continue;
    const tl = ws.getCell(a);
    const br = ws.getCell(b);
    const m: Merge = { r1: Number(tl.row), c1: Number(tl.col), r2: Number(br.row), c2: Number(br.col) };
    const key = `${m.r1},${m.c1}`;
    merges.set(key, m);
    for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (r !== m.r1 || c !== m.c1) covered.set(`${r},${c}`, key);
  }
  const extent = (r: number, c: number): Merge => merges.get(`${r},${c}`) ?? { r1: r, c1: c, r2: r, c2: c };

  const fields: LayoutField[] = [];
  const unmapped: string[] = [];
  const sx = area.w / sheetW;
  const sy = area.h / sheetH;

  for (let r = 1; r <= maxR; r++) {
    // non-empty cells in this row (formulas are value placeholders, so they count as empty)
    const items: Array<{ c: number; text: string; kind: Kind; size: number }> = [];
    for (let c = 1; c <= maxC; c++) {
      if (covered.has(`${r},${c}`)) continue;
      const cell = ws.getCell(r, c);
      const v = cell.value;
      if (typeof v === "string" && v.trim()) items.push({ c, text: v, kind: classify(v), size: cell.font?.size ?? 12 });
    }
    let weightCtx: "gross" | "tare" | "net" | null = null;
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (!it.kind) { unmapped.push(it.text); continue; }
      if (it.kind === "unit") continue;
      let key: FieldKey | null = null;
      if (it.kind === "date" || it.kind === "time") {
        if (weightCtx === "gross" || weightCtx === "tare") key = `${weightCtx}_${it.kind}` as FieldKey;
        else { unmapped.push(it.text); continue; }
      } else {
        key = it.kind;
        if (key === "gross_weight") weightCtx = "gross";
        else if (key === "tare_weight") weightCtx = "tare";
        else if (key === "net_weight") weightCtx = "net";
      }
      const lab = extent(r, it.c);
      const startC = lab.c2 + 1;
      const next = items[i + 1];
      const endC = next ? next.c - 1 : maxC;
      if (startC > endC) continue;
      // value box = cell(s) between this label and the next non-empty cell; honour a merged value cell
      const vm = extent(lab.r1, startC);
      const lastC = Math.max(endC, vm.c2 > endC ? endC : vm.c2);
      const rEnd = Math.max(lab.r2, vm.r2);
      const x0 = colX[startC - 1] ?? 0, x1 = colX[Math.min(lastC, maxC)] ?? sheetW;
      const y0 = rowY[lab.r1 - 1] ?? 0, y1 = rowY[Math.min(rEnd, maxR)] ?? sheetH;
      const w = Math.max(r1((x1 - x0) * sx), 4);
      const h = Math.max(r1((y1 - y0) * sy), 3);
      const lineH = 1.15;
      const maxPt = Math.max(floor, Math.min(it.size, Math.floor((h / (PT_TO_MM * lineH)) * 4) / 4, 24));
      const isNotes = key === "notes";
      fields.push({
        id: `${key}`,
        key,
        visible: true,
        order: fields.length,
        x: r1(x0 * sx),
        y: r1(y0 * sy),
        w,
        h,
        label: it.text.replace(/[:：]\s*$/, "").trim(),
        // the Excel's Hindi heading becomes the Hindi heading; English comes from the defaults
        labelHi: it.text.trim().slice(0, 40),
        labelEn: (DEFAULT_LABELS as Record<string, { en: string; hi: string }>)[key]!.en || undefined,
        showLabel: false,
        font: { family: "Courier New", minPt: floor, maxPt, bold: false },
        align: key.endsWith("weight") || key === "charge" ? "right" : "left",
        fit: isNotes ? "wrap" : "shrink",
        maxLines: isNotes ? Math.max(1, Math.min(4, Math.floor(h / (floor * PT_TO_MM * lineH)))) : 1,
        lineHeight: lineH,
      });
    }
  }

  const layout = LayoutSchema.parse({
    version: 1,
    name: opts.name ?? "Imported from Excel",
    paper,
    printArea: area,
    offset: { x: 0, y: 0 },
    orientation: "landscape",
    scale: 1,
    legibilityFloorPt: floor,
    fields,
  });
  return {
    layout,
    report: { mapped: fields.map((f) => f.key), unmappedLabels: unmapped, sheetMm: { w: r1(sheetW), h: r1(sheetH) } },
  };
}
