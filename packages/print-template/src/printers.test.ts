import { describe, expect, it } from "vitest";
import { ENVIRONMENTS, PRINTER_MODELS, environmentFor, getModel, matchPrinterModel, modelsByMake, partsLabel } from "./printers";

describe("printer catalog", () => {
  it("has unique keys and a family environment for every model", () => {
    const keys = PRINTER_MODELS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of PRINTER_MODELS) expect(ENVIRONMENTS[p.family]).toBeDefined();
  });
  it("auto-detects common Windows printer names", () => {
    expect(matchPrinterModel("EPSON LX-310 ESC/P")?.key).toBe("epson-lx-310");
    expect(matchPrinterModel("EPSON LQ-310 ESC/P2")?.key).toBe("epson-lq-310");
    expect(matchPrinterModel("TVS MSP 250 Star")?.key).toBe("tvs-msp-250");
    expect(matchPrinterModel("TVS-E MSP240 Classic Plus")?.key).toBe("tvs-msp-240");
    expect(matchPrinterModel("Wipro 800DX")?.key).toBe("wep-800dx");
    expect(matchPrinterModel("OKI ML3320eco")?.key).toBe("oki-ml3320");
    expect(matchPrinterModel("TVS RP3160 GOLD")?.key).toBe("tvs-rp3160");
  });
  it("does not guess for virtual / unknown printers", () => {
    expect(matchPrinterModel("Microsoft Print to PDF")).toBeUndefined();
    expect(matchPrinterModel("OneNote (Desktop)")).toBeUndefined();
  });
  it("9-pin printers prefer larger text than 24-pin; thermal is smallest", () => {
    expect(environmentFor(getModel("epson-lx-310")).preferredMinPt).toBeGreaterThan(environmentFor(getModel("epson-lq-310")).preferredMinPt);
    expect(environmentFor(getModel("tvs-rp3160")).preferredMinPt).toBeLessThan(environmentFor(getModel("epson-lq-310")).preferredMinPt);
  });
  it("only claims copy ratings that were confirmed", () => {
    expect(partsLabel(getModel("epson-lx-310"))).toBe("1 + 4 copies (carbon)");
    expect(partsLabel(getModel("epson-lq-310"))).toBe("1 + 3 copies (carbon)");
    expect(partsLabel(getModel("tvs-msp-345"))).toContain("not confirmed");
    expect(getModel("tvs-msp-345")?.verified).toBe(false);
  });
  it("groups by make for the dropdown", () => {
    const makes = modelsByMake().map(([m]) => m);
    expect(makes).toEqual(expect.arrayContaining(["Epson", "TVS", "WeP / Wipro", "OKI", "Generic"]));
  });
});

describe("Canon MF3010 / laser family", () => {
  it("is detected and keeps the 170 x 95 mm slip size", () => {
    expect(matchPrinterModel("Canon MF3010")?.key).toBe("canon-mf3010");
    expect(matchPrinterModel("Canon MF3010 UFRII LT")?.key).toBe("canon-mf3010");
    const env = environmentFor(getModel("canon-mf3010"));
    expect(env.defaultPaper).toEqual({ w: 170, h: 95 });
    expect(env.preferredMinPt).toBe(7);
    expect(env.driverSteps.join(" ")).toContain("170");
  });
  it("dot-matrix still defaults to the 170 x 95 ticket", () => {
    expect(environmentFor(getModel("epson-lx-310")).defaultPaper).toEqual({ w: 170, h: 95 });
  });
});
