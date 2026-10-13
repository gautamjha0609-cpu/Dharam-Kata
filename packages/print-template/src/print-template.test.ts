import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fitText, parseLayout, renderCalibrationHtml, renderHtml, ticketPreset } from "./index";
import { importLayoutFromXlsx } from "./xlsx-import";

const sampleValues = {
  serial: "22242",
  vehicle: "RJ14GD9158",
  material: "MRKU3564630",
  party: "GANPATI PLAS",
  gross_weight: "34210",
  gross_date: "29/07/2026",
  gross_time: "15:16",
  tare_weight: "15105",
  tare_date: "28/07/2026",
  tare_time: "11:40",
  net_weight: "19105",
  charge: "350",
};

describe("fit engine", () => {
  const box = { w: 30, h: 6, font: { family: "Courier New" as const, minPt: 8, maxPt: 14, bold: false }, fit: "shrink" as const, maxLines: 1, lineHeight: 1.15 };
  it("uses the largest size that fits (not too small)", () => {
    const r = fitText("34210", box, 8);
    expect(r.pt).toBe(14); // 5 chars * 0.6 * 14pt*0.3528 = 14.8mm <= 30
    expect(r.overflow).toBe(false);
  });
  it("shrinks long text but stays >= min, flagging overflow if impossible", () => {
    const shrunk = fitText("GANPATI PLASTIC IND", box, 8); // 19 chars
    expect(shrunk.pt).toBeLessThan(14);
    expect(shrunk.pt).toBeGreaterThanOrEqual(8);
    const huge = fitText("X".repeat(60), box, 8);
    expect(huge.overflow).toBe(true);
    expect(huge.pt).toBe(8);
  });
  it("wraps notes within height", () => {
    const r = fitText("fragile load keep dry", { ...box, h: 12, w: 20, fit: "wrap", maxLines: 3 }, 8);
    expect(r.lines.length).toBeGreaterThan(1);
    expect(r.overflow).toBe(false);
  });
});

describe("layout schema", () => {
  it("accepts the Vinayak preset (170x95 paper, 150x50 area)", () => {
    const l = ticketPreset();
    expect(l.paper).toEqual({ w: 170, h: 95 });
    expect(l.printArea).toMatchObject({ w: 150, h: 50 });
  });
  it("rejects fields outside the printable area and an oversized area", () => {
    const l = ticketPreset();
    expect(() => parseLayout({ ...l, fields: [{ ...l.fields[0], x: 140, w: 30 }] })).toThrow();
    expect(() => parseLayout({ ...l, printArea: { x: 10, y: 32, w: 170, h: 50 } })).toThrow();
  });
});

describe("renderer", () => {
  it("renders every sample field with no overflow warnings", () => {
    const { html, warnings } = renderHtml(ticketPreset(), sampleValues);
    expect(warnings).toEqual([]);
    expect(html).toContain("@page{size:170mm 95mm;margin:0}");
    expect(html).toContain("RJ14GD9158");
  });
  it("escapes hostile text (no script injection)", () => {
    const { html } = renderHtml(ticketPreset(), { ...sampleValues, party: "<script>alert(1)</script>" });
    expect(html).not.toContain("<script>");
  });
  it("calibration sheet is labelled TEST", () => {
    expect(renderCalibrationHtml(ticketPreset())).toContain("NOT AN INVOICE");
  });
  it("applies X/Y offsets in mm", () => {
    const l = { ...ticketPreset(), offset: { x: 1.5, y: -2 } };
    const { html } = renderHtml(l, { serial: "1" });
    expect(html).toContain("left:27.50mm"); // area 10 + offset 1.5 + serial x 16
    expect(html).toContain("top:33.00mm"); // area 32 + offset -2 + serial y 3
  });
});

describe("Excel import (supplied DharamKanta_Invoice_Template.xlsx)", () => {
  it("maps Hindi labels to fields inside the 150x50 area", async () => {
    const buf = readFileSync(new URL("../fixtures/DharamKanta_Invoice_Template.xlsx", import.meta.url));
    const { layout, report } = await importLayoutFromXlsx(buf);
    expect(report.mapped).toEqual(
      expect.arrayContaining([
        "serial", "party", "material", "vehicle",
        "gross_weight", "gross_date", "gross_time",
        "tare_weight", "tare_date", "tare_time", "net_weight", "notes",
      ]),
    );
    for (const f of layout.fields) {
      expect(f.x + f.w).toBeLessThanOrEqual(150.01);
      expect(f.y + f.h).toBeLessThanOrEqual(50.01);
      expect(f.font.maxPt).toBeGreaterThanOrEqual(8);
    }
    const { warnings } = renderHtml(layout, sampleValues);
    expect(warnings.filter((w) => w.kind === "overflow")).toEqual([]);
  });
});

describe("blank-paper mode, copies, reprint mark, calibration", () => {
  const base = ticketPreset();
  const blank = {
    ...base,
    mode: "blank" as const,
    copies: 2,
    decor: [
      { id: "t1", type: "text" as const, x: 10, y: 4, w: 150, h: 8, text: "SHRI GANESH DHARAM KANTA", font: { family: "Arial" as const, pt: 16, bold: true }, align: "center" as const },
      { id: "l1", type: "line" as const, x: 10, y: 14, w: 150, h: 0, weight: 0.3 },
      { id: "r1", type: "rect" as const, x: 8, y: 30, w: 154, h: 55, weight: 0.4 },
    ],
    reprintMark: { enabled: true, text: "DUPLICATE", x: 100, y: 40, w: 40, h: 8, pt: 14 },
  };
  it("accepts a blank-mode layout and keeps defaults for old layouts", () => {
    const l = parseLayout(blank);
    expect(l.mode).toBe("blank");
    expect(l.copies).toBe(2);
    const old = parseLayout({ ...base, mode: undefined, decor: undefined, copies: undefined });
    expect(old.mode).toBe("preprinted");
    expect(old.decor).toEqual([]);
    expect(old.copies).toBe(1);
  });
  it("draws decor only in blank mode", () => {
    const withDecor = renderHtml(parseLayout(blank), sampleValues).html;
    expect(withDecor).toContain("SHRI GANESH DHARAM KANTA");
    expect(withDecor).toContain("border-top:0.30mm solid #000");
    const pre = renderHtml(parseLayout({ ...blank, mode: "preprinted" }), sampleValues).html;
    expect(pre).not.toContain("SHRI GANESH DHARAM KANTA");
  });
  it("prints the reprint mark only on reprints and never changes the invoice values", () => {
    const l = parseLayout(blank);
    expect(renderHtml(l, sampleValues).html).not.toContain("DUPLICATE");
    const re = renderHtml(l, sampleValues, { reprint: true }).html;
    expect(re).toContain("DUPLICATE");
    expect(re).toContain("22242");
  });
  it("rejects decor outside the paper and an out-of-area reprint mark", () => {
    expect(() => parseLayout({ ...blank, decor: [{ ...blank.decor[2], w: 400 }] })).toThrow();
    expect(() => parseLayout({ ...blank, reprintMark: { ...blank.reprintMark, x: 149, w: 40 } })).toThrow();
  });
  it("calibration sheet has rulers, corner marks and a 100 mm bar", () => {
    const html = renderCalibrationHtml(base);
    expect(html).toContain("100 mm - measure this bar");
    expect(html).toContain("NOT AN INVOICE");
    expect(html.match(/border-left:0\.12mm solid #000/g)!.length).toBeGreaterThan(150); // 1 mm ticks across 170 mm
  });
});

describe("headings (Hindi / English), italic and underline, Vinayak A4 preset", () => {
  it("prints the heading in the layout's language", async () => {
    const { fieldLabel } = await import("./layout");
    const l = ticketPreset();
    const mat = l.fields.find((x) => x.key === "material")!;
    expect(fieldLabel({ labelLang: "en" }, mat)).toBe("MATERIAL :");
    expect(fieldLabel({ labelLang: "hi" }, mat)).toBe("माल :");
    const en = renderHtml(l, { material: "COAL" }).html;
    const hi = renderHtml({ ...l, labelLang: "hi" }, { material: "COAL" }).html;
    expect(en).toContain("MATERIAL : COAL");
    expect(hi).toContain("माल : COAL");
  });
  it("falls back to the default Hindi / English wording when a field has none", async () => {
    const { fieldLabel } = await import("./layout");
    expect(fieldLabel({ labelLang: "hi" }, { key: "vehicle" })).toBe("वाहन नं. :");
    expect(fieldLabel({ labelLang: "en" }, { key: "gross_weight" })).toBe("Loaded :");
  });
  it("emits italic and underline only when asked", () => {
    const l = ticketPreset();
    const plain = renderHtml(l, { serial: "1" }).html;
    expect(plain).toContain("font-style:normal");
    expect(plain).not.toContain("text-decoration:underline");
    const styled = { ...l, fields: l.fields.map((f) => (f.key === "serial" ? { ...f, font: { ...f.font, italic: true, underline: true } } : f)) };
    const html = renderHtml(styled, { serial: "1" }).html;
    expect(html).toContain("font-style:italic");
    expect(html).toContain("text-decoration:underline");
  });
  it("the Excel import keeps the sheet's Hindi headings", async () => {
    const { readFileSync } = await import("node:fs");
    const { importLayoutFromXlsx } = await import("./xlsx-import");
    const { layout } = await importLayoutFromXlsx(readFileSync(new URL("../fixtures/DharamKanta_Invoice_Template.xlsx", import.meta.url)));
    expect(layout.fields.find((f) => f.key === "party")?.labelHi).toContain("विक्रेता");
    expect(layout.fields.find((f) => f.key === "party")?.labelEn).toBe("Party :");
  });
  it("blank-paper ticket is 170 x 95 mm with Hindi headings and renders without overflow", async () => {
    const { blankTicketPreset } = await import("./presets");
    const l = blankTicketPreset();
    l.decor = l.decor.map((d) => (d.id === "firm" && d.type === "text" ? { ...d, text: "विनायक कम्प्यूटराईज्ड धर्म काँटा" } : d));
    expect(l.paper).toEqual({ w: 170, h: 95 });
    expect(l.mode).toBe("blank");
    expect(l.labelLang).toBe("hi");
    const { html, warnings } = renderHtml(l, sampleValues);
    expect(html).toContain("विनायक कम्प्यूटराईज्ड धर्म काँटा");
    expect(html).toContain("भरा : 34210");
    expect(html).toContain("@page{size:170mm 95mm;margin:0}");
    expect(warnings.filter((w) => w.kind === "overflow")).toEqual([]);
  });
});

describe("paper sizes and the full-design option", () => {
  const sample = { serial: "VNK/26-27/000125", vehicle: "RJ14 GD 9158", material: "MRKU3564630", party: "GANPATI PLASTICS", gross_weight: "34210", gross_date: "12/10/2026", gross_time: "11:53", tare_weight: "15105", tare_date: "12/10/2026", tare_time: "11:54", net_weight: "19105", charge: "6686.75" };
  it("lists practical invoice paper sizes and matches them", async () => {
    const { PAPER_SIZES, matchPaperSize } = await import("./paper");
    expect(PAPER_SIZES.map((p) => p.id)).toEqual(expect.arrayContaining(["ticket-170x95", "a4", "a5-portrait", "a5-landscape", "cont-8x12", "cont-95x11", "cont-95x55", "roll-80"]));
    expect(matchPaperSize(210, 297)?.id).toBe("a4");
    expect(matchPaperSize(210.2, 296.8)?.id).toBe("a4");
    expect(matchPaperSize(123, 77)).toBeUndefined(); // custom
  });
  for (const [name, w, h] of [["170x95 ticket", 170, 95], ["A4", 210, 297], ["A5 portrait", 148, 210], ["A5 landscape", 210, 148], ["8x12 in", 203, 305], ["9.5x5.5 in", 241, 140]] as const) {
    it(`full design fits on ${name}: valid layout, header/footer drawn, details inside the printing area, no overflow`, async () => {
      const { applyFullDesign } = await import("./presets");
      const base = { ...ticketPreset(), paper: { w, h } };
      const l = applyFullDesign(base as never, { title: "विनायक कम्प्यूटराईज्ड धर्म काँटा", signature: "ऑपरेटर के हस्ताक्षर" });
      expect(l.mode).toBe("blank");
      expect(l.paper).toEqual({ w, h });
      expect(l.printArea.x + l.printArea.w).toBeLessThanOrEqual(w);
      expect(l.printArea.y + l.printArea.h).toBeLessThanOrEqual(h);
      const { html, warnings } = renderHtml(l, sample);
      expect(html).toContain("विनायक कम्प्यूटराईज्ड धर्म काँटा"); // header outside the printing area
      expect(html).toContain("ऑपरेटर के हस्ताक्षर"); // footer outside the printing area
      expect(html).toContain(`@page{size:${w}mm ${h}mm;margin:0}`);
      expect(warnings.filter((x) => x.kind === "overflow")).toEqual([]);
    });
  }
  it("refuses papers that are too narrow for the header design", async () => {
    const { applyFullDesign, DesignError } = await import("./presets");
    expect(() => applyFullDesign({ ...ticketPreset(), paper: { w: 80, h: 200 } } as never)).toThrow(DesignError);
  });
  it("keeps the owner's text styling when the design is applied", async () => {
    const { applyFullDesign } = await import("./presets");
    const base = ticketPreset();
    const styled = { ...base, fields: base.fields.map((f) => (f.key === "vehicle" ? { ...f, font: { ...f.font, italic: true, underline: true } } : f)) };
    const l = applyFullDesign(styled);
    const v = l.fields.find((f) => f.key === "vehicle")!;
    expect(v.font.italic).toBe(true);
    expect(v.font.underline).toBe(true);
    expect(v.showLabel).toBe(true);
  });
});

describe("full design details", () => {
  it("rounds positions to 0.1 mm (no 72.02399999 in the UI)", async () => {
    const { applyFullDesign } = await import("./presets");
    const l = applyFullDesign({ ...ticketPreset(), paper: { w: 241, h: 140 } } as never);
    const all = [l.printArea.x, l.printArea.y, l.printArea.w, l.printArea.h, ...l.decor.flatMap((d) => [d.x, d.y, d.w, d.h]), ...l.fields.flatMap((f) => [f.x, f.y, f.w, f.h])];
    for (const n of all) expect(Math.abs(n * 10 - Math.round(n * 10))).toBeLessThan(1e-6);
  });
  it("hidden design elements do not invalidate a details-only layout on a smaller paper", async () => {
    const { applyFullDesign } = await import("./presets");
    const full = applyFullDesign({ ...ticketPreset(), paper: { w: 241, h: 140 } } as never);
    const details = { ...full, fields: [], reprintMark: { ...full.reprintMark!, enabled: false }, mode: "preprinted" as const, paper: { w: 150, h: 90 }, printArea: { x: 5, y: 5, w: 140, h: 80 } };
    expect(() => parseLayout(details)).not.toThrow();
    expect(() => parseLayout({ ...details, mode: "blank" })).toThrow();
  });
});

describe("per-firm extra fields (x1..x8)", () => {
  const withExtra = () => {
    const l = ticketPreset();
    const base = l.fields[0]!;
    return { ...l, fields: [...l.fields, { ...base, id: "x1", key: "x1" as const, x: 2, y: 40, w: 60, h: 6, showLabel: true, labelEn: "Driver name :", labelHi: "चालक का नाम :" }] };
  };
  it("accepts an extra field in the layout and prints its value with the heading", () => {
    const layout = parseLayout(withExtra());
    const { html } = renderHtml(layout, { vehicle: "RJ14GD9158", x1: "Ramesh Kumar" });
    expect(html).toContain("Driver name : Ramesh Kumar");
  });
  it("prints the Hindi heading when the layout language is Hindi", () => {
    const layout = parseLayout({ ...withExtra(), labelLang: "hi" });
    expect(renderHtml(layout, { x1: "Ramesh Kumar" }).html).toContain("चालक का नाम : Ramesh Kumar");
  });
  it("rejects keys outside x1..x8", () => {
    const bad = withExtra();
    (bad.fields[bad.fields.length - 1] as { key: string }).key = "x9";
    expect(() => parseLayout(bad)).toThrow();
  });
});

describe("opening / closing slips, per-field heading language, field history", () => {
  const withHeadings = (lang: "en" | "hi" = "en") => {
    const l = ticketPreset();
    return parseLayout({ ...l, labelLang: lang, fields: l.fields.map((f) => ({ ...f, showLabel: true, w: f.key === "gross_weight" ? 60 : f.w })) });
  };
  it("an opening slip prints the first weight under the Loaded box with the heading 'First weight'", () => {
    const html = renderHtml(withHeadings(), { serial: "1", vehicle: "RJ14GD9158", gross_weight: "34210", stage: "open" }).html;
    expect(html).toContain("First weight : 34210");
    expect(html).not.toContain("Loaded :");
    expect(html).not.toContain("Empty :");
  });
  it("a closing slip keeps the normal Loaded / Empty / Net headings", () => {
    const html = renderHtml(withHeadings(), { serial: "1", gross_weight: "34210", tare_weight: "15105", net_weight: "19105" }).html;
    expect(html).toContain("Loaded : 34210");
    expect(html).toContain("Empty : 15105");
    expect(html).not.toContain("First weight");
  });
  it("the opening-slip heading follows the language (Hindi)", () => {
    expect(renderHtml(withHeadings("hi"), { gross_weight: "34210", stage: "open" }).html).toContain("पहला वज़न : 34210");
  });
  it("one field can have its own heading language", () => {
    const l = withHeadings("en");
    const mixed = parseLayout({ ...l, fields: l.fields.map((f) => (f.key === "vehicle" ? { ...f, labelLang: "hi" } : f)) });
    const html = renderHtml(mixed, { vehicle: "RJ14GD9158", material: "SCRAP" }).html;
    expect(html).toContain("वाहन नं. : RJ14GD9158"); // this one in Hindi
    expect(html).toContain("MATERIAL : SCRAP"); // the rest stay English
  });
  it("older saved layouts (no removed list, no required flags) still load", () => {
    const l = ticketPreset() as unknown as Record<string, unknown>;
    delete l.removed;
    const parsed = parseLayout(l);
    expect(parsed.removed).toEqual([]);
    expect(parsed.fields.every((f) => f.required === undefined)).toBe(true);
  });
  it("stores which fields were removed and which are required", () => {
    const l = ticketPreset();
    const parsed = parseLayout({ ...l, removed: ["notes", "operator"], fields: l.fields.map((f) => (f.key === "material" ? { ...f, required: true } : f)) });
    expect(parsed.removed).toEqual(["notes", "operator"]);
    expect(parsed.fields.find((f) => f.key === "material")?.required).toBe(true);
  });
});

describe("ask-on-form flag", () => {
  it("is optional and does not change printing (a printed field can be not asked, and the reverse)", () => {
    const l = ticketPreset();
    const parsed = parseLayout({ ...l, fields: l.fields.map((f) => (f.key === "material" ? { ...f, ask: false } : f)) });
    expect(parsed.fields.find((f) => f.key === "material")?.ask).toBe(false);
    expect(parsed.fields.find((f) => f.key === "material")?.visible).toBe(true);
    expect(renderHtml(parsed, { material: "SCRAP" }).html).toContain("SCRAP");
  });
});

describe("no firm's wording is built into the shared designs", () => {
  it("the full design carries only the firm's own title; everything else is empty or generic", async () => {
    const { applyFullDesign } = await import("./presets");
    const l = applyFullDesign(ticketPreset(), { title: "ACME WEIGHBRIDGE" });
    const texts = l.decor.filter((d) => d.type === "text").map((d) => (d.type === "text" ? d.text : ""));
    expect(texts).toContain("ACME WEIGHBRIDGE");
    expect(JSON.stringify(l)).not.toMatch(/विनायक|सिंवार|0141|8560977779|Vinayak/i);
  });
  it("re-fitting to another paper keeps wording the firm typed", async () => {
    const { applyFullDesign } = await import("./presets");
    const a = applyFullDesign(ticketPreset(), { title: "ACME" });
    const edited = { ...a, decor: a.decor.map((d) => (d.id === "phone" && d.type === "text" ? { ...d, text: "Ph 123" } : d)) };
    const b = applyFullDesign({ ...edited, paper: { w: 210, h: 297 } });
    expect(b.decor.find((d) => d.id === "phone")).toMatchObject({ text: "Ph 123" });
    expect(b.decor.find((d) => d.id === "firm")).toMatchObject({ text: "ACME" });
  });
});
