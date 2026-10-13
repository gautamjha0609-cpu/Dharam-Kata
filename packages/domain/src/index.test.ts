import { describe, expect, it } from "vitest";
import { computeFee, DomainError, formatInvoiceNumber, netWeightKg, normalizeVehicle, resolveWeights } from "./index";

describe("netWeightKg", () => {
  it("matches the sample ticket (34210 - 15105 = 19105)", () => {
    expect(netWeightKg("34210", "15105")).toBe("19105.000");
  });
  it("keeps 3 dp precision", () => {
    expect(netWeightKg("100.125", "0.1")).toBe("100.025");
  });
  it("rejects tare > gross and negatives", () => {
    expect(() => netWeightKg(10, 11)).toThrow(DomainError);
    expect(() => netWeightKg(-1, 0)).toThrow(DomainError);
  });
  it("rejects junk", () => {
    expect(() => netWeightKg("abc", 1)).toThrow(DomainError);
  });
});

describe("computeFee (unit fixed once, rate entered per invoice)", () => {
  it("per tonne: 19105 kg x 20/t = 382.10", () => {
    expect(computeFee({ netKg: "19105", unit: "tonne", rate: "20" })).toEqual({
      quantity: "19.105",
      rate: "20.00",
      amount: "382.10",
    });
  });
  it("per kg", () => {
    expect(computeFee({ netKg: "19105", unit: "kg", rate: "0.02" }).amount).toBe("382.10");
  });
  it("rounds half up with no float drift", () => {
    expect(computeFee({ netKg: "1000.5", unit: "tonne", rate: "1" }).amount).toBe("1.00");
    expect(computeFee({ netKg: "1500", unit: "tonne", rate: "0.01" }).amount).toBe("0.02"); // 0.015 -> 0.02
    expect(computeFee({ netKg: "3", unit: "kg", rate: "0.1" }).amount).toBe("0.30");
  });
  it("rejects negative rate", () => {
    expect(() => computeFee({ netKg: 1, unit: "kg", rate: -1 })).toThrow(DomainError);
  });
});

describe("formatInvoiceNumber", () => {
  it("series start 125 continues 126", () => {
    expect(formatInvoiceNumber(125, { prefix: "VNK/26-27/", padding: 6 })).toBe("VNK/26-27/000125");
    expect(formatInvoiceNumber(126)).toBe("126");
  });
});

describe("normalizeVehicle", () => {
  it("normalizes spacing and case", () => {
    expect(normalizeVehicle("rj14 gd 9158")).toBe("RJ14GD9158");
  });
});

describe("resolveWeights (loaded-first or empty-first)", () => {
  it("loaded first: the first (heavier) weight is the loaded weight", () => {
    expect(resolveWeights("34210", "15105")).toEqual({ gross: "34210.000", tare: "15105.000", net: "19105.000", loadedWas: "first" });
  });
  it("empty first: the second (heavier) weight is the loaded weight", () => {
    expect(resolveWeights("15105", "34210")).toEqual({ gross: "34210.000", tare: "15105.000", net: "19105.000", loadedWas: "second" });
  });
  it("keeps 3-decimal precision", () => {
    expect(resolveWeights("10.5", "10.125").net).toBe("0.375");
  });
  it("rejects equal, zero, negative and non-numeric weights", () => {
    expect(() => resolveWeights(100, 100)).toThrow(DomainError);
    expect(() => resolveWeights(0, 100)).toThrow(DomainError);
    expect(() => resolveWeights(-5, 100)).toThrow(DomainError);
    expect(() => resolveWeights("abc", 100)).toThrow(DomainError);
  });
});
