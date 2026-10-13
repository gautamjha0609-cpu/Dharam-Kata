import { z } from "zod";

/**
 * Receipt layout schema (v1). Stored as validated JSON — never HTML/JS (SRS A2.1).
 * All geometry is in millimetres; all text sizes in points.
 */

export const FIELD_KEYS = [
  "serial", // invoice / serial number
  "party",
  "material",
  "vehicle",
  "gross_weight",
  "gross_date",
  "gross_time",
  "tare_weight",
  "tare_date",
  "tare_time",
  "net_weight",
  "charge",
  "payment_mode",
  "debtor",
  "notes",
  "operator",
  "site",
  "title",
  "company",
] as const;
export type BuiltinKey = (typeof FIELD_KEYS)[number];
/** Per-firm extra fields (driver name, challan no. ...). The firm names them; the key is just a slot. */
export const CUSTOM_KEYS = ["x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8"] as const;
export type CustomKey = (typeof CUSTOM_KEYS)[number];
export type FieldKey = BuiltinKey | CustomKey;
export const isCustomKey = (k: string): k is CustomKey => (CUSTOM_KEYS as readonly string[]).includes(k);

/** Allow-listed fonts. `mono` fonts give exact column alignment on dot-matrix. */
export const FONT_FAMILIES = {
  "Courier New": { mono: true },
  "Lucida Console": { mono: true },
  Consolas: { mono: true },
  Arial: { mono: false },
  Mangal: { mono: false }, // Devanagari
  "Nirmala UI": { mono: false }, // Devanagari
} as const;
export type FontFamily = keyof typeof FONT_FAMILIES;

const mm = z.number().finite().min(0).max(1000);

export const FieldSchema = z.object({
  id: z.string().min(1).max(40),
  key: z.enum([...FIELD_KEYS, ...CUSTOM_KEYS]),
  visible: z.boolean().default(true),
  order: z.number().int().min(0).default(0),
  /** Box, in mm, relative to the printable area's top-left corner. */
  x: mm,
  y: mm,
  w: mm.refine((v) => v > 0, "width must be > 0"),
  h: mm.refine((v) => v > 0, "height must be > 0"),
  /** Legacy single heading; used when no English/Hindi text is set. */
  label: z.string().max(40).optional(),
  /** Heading text in English and in Hindi. The layout's labelLang decides which one prints. */
  labelEn: z.string().max(40).optional(),
  labelHi: z.string().max(40).optional(),
  /** Heading language for THIS field only; when unset the layout's language is used. */
  labelLang: z.enum(["en", "hi"]).optional(),
  /** Must the operator fill this in? (Only meaningful for fields the operator types: party, material, notes, extra fields.) */
  required: z.boolean().optional(),
  /** Does the Weighment form ask the operator for this field? When unset it follows `visible` (asked if it is printed). */
  ask: z.boolean().optional(),
  showLabel: z.boolean().default(false),
  suffix: z.string().max(12).optional(),
  font: z.object({
    family: z.enum(Object.keys(FONT_FAMILIES) as [FontFamily, ...FontFamily[]]),
    minPt: z.number().min(5).max(48),
    maxPt: z.number().min(5).max(48),
    bold: z.boolean().default(false),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
  }),
  align: z.enum(["left", "center", "right"]).default("left"),
  fit: z.enum(["shrink", "wrap", "clip"]).default("shrink"),
  maxLines: z.number().int().min(1).max(6).default(1),
  lineHeight: z.number().min(1).max(2).default(1.15),
});
export type LayoutField = z.infer<typeof FieldSchema>;

/**
 * Static (non-data) elements for BLANK-paper mode, where the software draws the whole slip.
 * Coordinates are in mm from the PAPER's top-left corner. Ignored in pre-printed mode.
 */
const Id = z.string().min(1).max(40);
const Weight = z.number().min(0.1).max(2).default(0.3);
export const DecorSchema = z.discriminatedUnion("type", [
  z.object({ id: Id, type: z.literal("text"), x: mm, y: mm, w: mm.refine((v) => v > 0), h: mm.refine((v) => v > 0), text: z.string().max(120),
    font: z.object({ family: z.enum(Object.keys(FONT_FAMILIES) as [FontFamily, ...FontFamily[]]), pt: z.number().min(5).max(48), bold: z.boolean().default(false), italic: z.boolean().optional(), underline: z.boolean().optional() }),
    align: z.enum(["left", "center", "right"]).default("left") }),
  z.object({ id: Id, type: z.literal("line"), x: mm, y: mm, w: mm, h: mm, weight: Weight }), // a horizontal (h=0) or vertical (w=0) rule
  z.object({ id: Id, type: z.literal("rect"), x: mm, y: mm, w: mm.refine((v) => v > 0), h: mm.refine((v) => v > 0), weight: Weight }),
]);
export type Decor = z.infer<typeof DecorSchema>;

/** Optional marker printed on reprints so a copy can never pass as the original. */
export const ReprintMarkSchema = z.object({
  enabled: z.boolean().default(false),
  text: z.string().min(1).max(30).default("DUPLICATE"),
  x: mm, y: mm, w: mm.refine((v) => v > 0), h: mm.refine((v) => v > 0), // relative to the print area
  pt: z.number().min(6).max(48).default(14),
});

export const LayoutSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).max(80),
    paper: z.object({ w: z.number().min(20).max(500), h: z.number().min(20).max(500) }),
    printArea: z.object({ x: mm, y: mm, w: mm.refine((v) => v > 0), h: mm.refine((v) => v > 0) }),
    /** Calibration shift applied to everything (per printer/template), mm. */
    offset: z.object({ x: z.number().min(-30).max(30), y: z.number().min(-30).max(30) }).default({ x: 0, y: 0 }),
    orientation: z.enum(["portrait", "landscape"]).default("landscape"),
    scale: z.literal(1).default(1), // actual size only in v1
    /** Smallest size we accept before warning that text is unreadable. */
    legibilityFloorPt: z.number().min(5).max(14).default(8),
    fields: z.array(FieldSchema).max(60),
    /** preprinted = only variable data is printed on the customer's existing form; blank = the software also draws decor. */
    mode: z.enum(["preprinted", "blank"]).default("preprinted"),
    /** Which language the field headings print in (when a field's heading is switched on). */
    labelLang: z.enum(["en", "hi"]).default("en"),
    /** Fields the operator took off the slip (history). Only these (and unplaced extra fields) are offered when adding a field back. */
    removed: z.array(z.string().max(40)).max(60).default([]),
    decor: z.array(DecorSchema).max(80).default([]),
    /** Identical copies printed per invoice (e.g. customer + office). */
    copies: z.number().int().min(1).max(5).default(1),
    reprintMark: ReprintMarkSchema.optional(),
  })
  .superRefine((l, ctx) => {
    const { paper, printArea: a } = l;
    if (a.x + a.w > paper.w + 1e-6 || a.y + a.h > paper.h + 1e-6)
      ctx.addIssue({ code: "custom", path: ["printArea"], message: "Printable area exceeds paper size" });
    if (l.mode === "blank") {
      l.decor.forEach((d, i) => {
        if (d.x + d.w > paper.w + 1e-6 || d.y + d.h > paper.h + 1e-6) ctx.addIssue({ code: "custom", path: ["decor", i], message: "Element exceeds the paper" });
      });
    }
    if (l.reprintMark?.enabled && (l.reprintMark.x + l.reprintMark.w > a.w + 1e-6 || l.reprintMark.y + l.reprintMark.h > a.h + 1e-6))
      ctx.addIssue({ code: "custom", path: ["reprintMark"], message: "Reprint mark exceeds the printable area" });
    const ids = new Set<string>();
    l.fields.forEach((f, i) => {
      if (ids.has(f.id)) ctx.addIssue({ code: "custom", path: ["fields", i, "id"], message: "Duplicate field id" });
      ids.add(f.id);
      if (f.font.minPt > f.font.maxPt)
        ctx.addIssue({ code: "custom", path: ["fields", i, "font"], message: "minPt must be <= maxPt" });
      if (f.visible && (f.x + f.w > a.w + 1e-6 || f.y + f.h > a.h + 1e-6))
        ctx.addIssue({ code: "custom", path: ["fields", i], message: "Field exceeds printable area" });
    });
  });
export type Layout = z.infer<typeof LayoutSchema>;

/** The "DUPLICATE" mark on reprints always sits in the same place (lower right of the printing area). Firms only choose the number of copies. */
export function autoReprintMark(area: { w: number; h: number }) {
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const h = Math.min(9, area.h);
  return { enabled: true, text: "DUPLICATE", x: r1(area.w * 0.62), y: r1(Math.max(0, Math.min(area.h * 0.72, area.h - h))), w: r1(area.w * 0.32), h, pt: 14 };
}

/** Default headings (English / Hindi). Hindi wording follows the Vinayak Excel template. */
export const DEFAULT_LABELS: Record<BuiltinKey, { en: string; hi: string }> = {
  serial: { en: "Invoice no. :", hi: "क्रम. सं. :" },
  party: { en: "Party :", hi: "विक्रेता का नाम :" },
  material: { en: "Material :", hi: "माल :" },
  vehicle: { en: "Vehicle no. :", hi: "वाहन नं. :" },
  gross_weight: { en: "Loaded :", hi: "भरा :" },
  gross_date: { en: "Date :", hi: "तारीख :" },
  gross_time: { en: "Time :", hi: "समय :" },
  tare_weight: { en: "Empty :", hi: "खाली :" },
  tare_date: { en: "Date :", hi: "तारीख :" },
  tare_time: { en: "Time :", hi: "समय :" },
  net_weight: { en: "Net :", hi: "शुद्ध :" },
  charge: { en: "Charge :", hi: "शुल्क :" },
  payment_mode: { en: "Payment :", hi: "भुगतान :" },
  debtor: { en: "Debtor :", hi: "देनदार :" },
  notes: { en: "Notes :", hi: "नोट्स :" },
  operator: { en: "Operator :", hi: "ऑपरेटर :" },
  site: { en: "Site :", hi: "स्थान :" },
  title: { en: "", hi: "" },
  company: { en: "", hi: "" },
};

/** Opening slip: the first weight is printed where "Loaded" normally goes, headed "First weight". */
export const FIRST_WEIGHT_LABEL = { en: "First weight :", hi: "पहला वज़न :" } as const;

/** The heading text that prints for a field: the field's own language if set, else the layout's (falls back to the legacy label). */
export function fieldLabel(layout: Pick<Layout, "labelLang">, f: Pick<LayoutField, "key" | "label" | "labelEn" | "labelHi" | "labelLang">, stage?: string): string | undefined {
  const lang = f.labelLang ?? layout.labelLang;
  if (stage === "open" && f.key === "gross_weight") return FIRST_WEIGHT_LABEL[lang];
  const d = (DEFAULT_LABELS as Record<string, { en: string; hi: string }>)[f.key] ?? { en: "", hi: "" };
  const pick = lang === "hi" ? f.labelHi ?? d.hi : f.labelEn ?? f.label ?? d.en;
  return pick || undefined;
}

/** The exact text a field prints: heading (if switched on) + value + suffix. One place, used by the preview and the printer. */
export function fieldText(layout: Pick<Layout, "labelLang">, f: LayoutField, raw: string, stage?: string): string {
  const h = f.showLabel ? fieldLabel(layout, f, stage) : undefined;
  return `${h ? h + " " : ""}${raw}${f.suffix ?? ""}`;
}

/** Typed print values. Only strings are rendered, always escaped — nothing executable. */
export type PrintValues = Partial<Record<FieldKey | "stage", string>>;

export function parseLayout(input: unknown): Layout {
  return LayoutSchema.parse(input);
}
