/**
 * Printer model catalog used when a printer is connected. Selecting a model applies its "environment":
 * a readable-size floor, a recommended font, and the Windows driver set-up steps.
 *
 * Specs come from manufacturer / retailer / government-procurement pages (see docs/PRINTER_COMPATIBILITY.md).
 * `verified: true` means the pins/columns/copies were confirmed from a source; `false` means the entry is a commonly
 * used Indian model whose spec was NOT confirmed here - the UI says so. Nothing here claims a model is "supported":
 * a model is supported only after the on-site checklist passes.
 */
export type PrinterFamily = "dotmatrix9" | "dotmatrix24" | "laser" | "thermal" | "other";

export interface PrinterModel {
  key: string;
  make: string;
  model: string;
  family: PrinterFamily;
  pins?: 9 | 24;
  columns?: 80 | 136;
  /** Original + carbon copies printable in one pass, e.g. 4 = "1 + 3". Undefined = unknown / not applicable. */
  parts?: number;
  /** Case-insensitive patterns tested against the Windows printer name for auto-detect. */
  aliases: RegExp[];
  verified: boolean;
  note?: string;
}

/** Defaults per family: the "environment" applied when a model is chosen. */
export interface Environment {
  /** Paper size (mm) applied when the printer is connected; the owner can change it. */
  defaultPaper: { w: number; h: number };
  /** Smallest text size we PREFER for this printer (graceful: relaxed again if text would not fit at all). */
  preferredMinPt: number;
  fontFamily: "Courier New" | "Arial";
  driverSteps: string[];
}

const COMMON_STEPS = [
  "Install the manufacturer's Windows driver for this exact model (not a generic one) and check the printer prints a Windows test page.",
  "In Windows: Printers & scanners → your printer → Printing preferences → set Paper source = Tractor / continuous, and print quality = Draft (best for carbon copies).",
  "Add your slip size as a custom form (Print server properties → Forms → Create a new form), e.g. 170 × 95 mm, and select it as the default form.",
  "Print this software's calibration sheet, check the 100 mm bar with a ruler, then set the X/Y offset in Settings → Printing.",
];

export const ENVIRONMENTS: Record<PrinterFamily, Environment> = {
  dotmatrix9: {
    defaultPaper: { w: 170, h: 95 },
    preferredMinPt: 10, // 9-pin dots are coarse: small text smudges, especially on carbon copies
    fontFamily: "Courier New",
    driverSteps: [...COMMON_STEPS, "9-pin heads: use Draft mode for multi-part forms; avoid sizes below 10 pt."],
  },
  dotmatrix24: {
    defaultPaper: { w: 170, h: 95 },
    preferredMinPt: 8,
    fontFamily: "Courier New",
    driverSteps: [...COMMON_STEPS, "24-pin heads print sharper text; use LQ/NLQ for a single copy and Draft for carbon sets."],
  },
  laser: {
    defaultPaper: { w: 170, h: 95 }, // the slip size is the customer's, not A4
    preferredMinPt: 7,
    fontFamily: "Arial",
    driverSteps: [
      "Install the manufacturer's Windows driver for this exact model from the maker's support site, and print a Windows test page.",
      "Printing preferences: paper size = your slip size (e.g. a custom 170 × 95 mm size, defined under Print server properties → Forms), scaling = 100% (turn OFF 'fit to page'), quality = normal/text. Some laser printers have a minimum or maximum custom size, so confirm this printer accepts it with a test print.",
      "Laser printers cannot take continuous (tractor) forms or make carbon copies. Feed single cut slips of your size, or use the blank-paper layout, which draws the whole slip itself.",
      "Laser printers cannot print right up to the paper edge (about 5 mm unprintable): keep the slip at least 5 mm inside the page.",
      "Print the calibration sheet, check the 100 mm bar with a ruler, then set the X/Y offset in Settings → Printing.",
    ],
  },
  thermal: {
    defaultPaper: { w: 80, h: 200 },
    preferredMinPt: 7,
    fontFamily: "Arial",
    driverSteps: [
      "Install the manufacturer's Windows driver and set the paper size to the roll width (e.g. 80 mm) with automatic length.",
      "Thermal printers cannot make carbon copies and do not suit pre-printed multi-part forms.",
    ],
  },
  other: {
    defaultPaper: { w: 170, h: 95 },
    preferredMinPt: 9,
    fontFamily: "Courier New",
    driverSteps: [...COMMON_STEPS, "Unknown model: run the full on-site checklist before relying on it."],
  },
};

const m = (x: Omit<PrinterModel, "key"> & { key?: string }): PrinterModel => ({ ...x, key: x.key ?? `${x.make}-${x.model}`.toLowerCase().replace(/[^a-z0-9]+/g, "-") });

export const PRINTER_MODELS: PrinterModel[] = [
  // Epson - 9-pin
  m({ make: "Epson", model: "LX-310", family: "dotmatrix9", pins: 9, columns: 80, parts: 5, verified: true, aliases: [/lx[-\s]?310/i] }),
  m({ make: "Epson", model: "LX-350", family: "dotmatrix9", pins: 9, columns: 80, verified: false, aliases: [/lx[-\s]?350/i], note: "Columns/copies not confirmed here." }),
  m({ make: "Epson", model: "LX-300+II", family: "dotmatrix9", pins: 9, columns: 80, verified: false, aliases: [/lx[-\s]?300/i], note: "Older but still common. Specs not confirmed here." }),
  // Epson - 24-pin
  m({ make: "Epson", model: "LQ-310", family: "dotmatrix24", pins: 24, columns: 80, parts: 4, verified: true, aliases: [/lq[-\s]?310/i] }),
  m({ make: "Epson", model: "LQ-590II", family: "dotmatrix24", pins: 24, columns: 80, parts: 7, verified: true, aliases: [/lq[-\s]?590/i] }),
  m({ make: "Epson", model: "LQ-2190", family: "dotmatrix24", pins: 24, columns: 136, verified: false, aliases: [/lq[-\s]?2190/i], note: "Wide carriage (136 columns) per general knowledge; not confirmed here." }),
  // TVS Electronics (India)
  m({ make: "TVS", model: "MSP 240 Classic / Plus / Star", key: "tvs-msp-240", family: "dotmatrix9", pins: 9, columns: 80, parts: 4, verified: true, aliases: [/msp[-\s]?240/i] }),
  m({ make: "TVS", model: "MSP 250 Star / Champion", key: "tvs-msp-250", family: "dotmatrix9", pins: 9, columns: 80, parts: 5, verified: true, aliases: [/msp[-\s]?250/i] }),
  m({ make: "TVS", model: "MSP 270 Classic Plus", key: "tvs-msp-270", family: "dotmatrix9", pins: 9, columns: 80, verified: true, aliases: [/msp[-\s]?270/i], note: "Listings differ: one source calls it direct-thermal. Check the unit's ribbon." }),
  m({ make: "TVS", model: "MSP 345 Champion", key: "tvs-msp-345", family: "dotmatrix24", pins: 24, columns: 136, verified: false, aliases: [/msp[-\s]?345/i], note: "Sources disagree on columns (80 vs 136) and copy rating; confirm on the unit." }),
  m({ make: "TVS", model: "MSP 255", key: "tvs-msp-255", family: "dotmatrix9", verified: false, aliases: [/msp[-\s]?255/i], note: "No spec found." }),
  m({ make: "TVS", model: "MSP 460", key: "tvs-msp-460", family: "dotmatrix24", verified: false, aliases: [/msp[-\s]?460/i], note: "No spec found." }),
  // WeP (Wipro)
  m({ make: "WeP / Wipro", model: "800 DX", key: "wep-800dx", family: "dotmatrix9", pins: 9, columns: 80, parts: 4, verified: true, aliases: [/800\s?dx/i, /wep.*800/i] }),
  m({ make: "WeP / Wipro", model: "DSI 810", key: "wep-dsi810", family: "dotmatrix24", pins: 24, columns: 80, verified: true, aliases: [/dsi[-\s]?810/i] }),
  // OKI
  m({ make: "OKI", model: "Microline 3320 / 3320eco", key: "oki-ml3320", family: "dotmatrix9", pins: 9, columns: 80, verified: true, aliases: [/ml[-\s]?3320/i, /microline.*3320/i] }),
  // Laser / multifunction (A4 sheets, no carbon copies)
  m({ make: "Canon", model: "imageCLASS MF3010", key: "canon-mf3010", family: "laser", verified: true, aliases: [/mf[-\s]?3010/i, /canon.*mf\s?30/i], note: "Monochrome laser multifunction, A4-class, about 18 ppm, 150-sheet tray (Canon regional spec pages). Single sheets only: no continuous forms, no carbon copies. Whether it accepts a small custom size like 170 x 95 mm must be confirmed with a test print." }),
  m({ make: "Generic", model: "Other laser / inkjet (A4)", key: "generic-laser", family: "laser", verified: false, aliases: [] }),
  // Thermal (receipt-style slips; not for pre-printed multi-part forms)
  m({ make: "TVS", model: "RP 3160 Gold (thermal 80 mm)", key: "tvs-rp3160", family: "thermal", verified: true, aliases: [/rp[-\s]?3160/i] }),
  m({ make: "Generic", model: "Thermal receipt printer (80 mm)", key: "generic-thermal", family: "thermal", verified: false, aliases: [/thermal/i, /pos[-\s]?80/i] }),
  // Catch-alls
  m({ make: "Generic", model: "Other 9-pin dot-matrix", key: "generic-9pin", family: "dotmatrix9", pins: 9, verified: false, aliases: [] }),
  m({ make: "Generic", model: "Other 24-pin dot-matrix", key: "generic-24pin", family: "dotmatrix24", pins: 24, verified: false, aliases: [] }),
  m({ make: "Generic", model: "Other / not listed", key: "generic-other", family: "other", verified: false, aliases: [] }),
];

export const getModel = (key?: string | null): PrinterModel | undefined => PRINTER_MODELS.find((p) => p.key === key);

/** Auto-detect from the Windows printer name, e.g. "EPSON LX-310 ESC/P" -> epson-lx-310. */
export function matchPrinterModel(windowsName: string): PrinterModel | undefined {
  return PRINTER_MODELS.find((p) => p.aliases.some((re) => re.test(windowsName)));
}

export const environmentFor = (model?: PrinterModel | null): Environment => ENVIRONMENTS[model?.family ?? "other"];

/** Models grouped by make, for a dropdown. */
export function modelsByMake(): [string, PrinterModel[]][] {
  const g = new Map<string, PrinterModel[]>();
  for (const p of PRINTER_MODELS) g.set(p.make, [...(g.get(p.make) ?? []), p]);
  return [...g.entries()];
}

export const partsLabel = (p?: PrinterModel) => (p?.parts ? `1 + ${p.parts - 1} copies (carbon)` : "copies: not confirmed");
