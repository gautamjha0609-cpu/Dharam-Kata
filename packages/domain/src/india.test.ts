import { describe, expect, it } from "vitest";
import { checkGstin, checkMobile, checkPan, checkPincode, checkVehicle, formatVehicle, gstinCheckChar } from "./india";

describe("PAN", () => {
  it("accepts a correct PAN (any case, spaces) and rejects wrong shapes", () => {
    expect(checkPan("abcpe1234f")).toEqual({ ok: true, value: "ABCPE1234F" });
    expect(checkPan("ABCDE1234F").ok).toBe(false); // 4th letter D is not a holder type
    expect(checkPan("ABCPE12345").ok).toBe(false);
    expect(checkPan("ABCPE1234").ok).toBe(false);
  });
});

describe("GSTIN", () => {
  it("accepts a real GSTIN and rejects a wrong check character or state", () => {
    expect(checkGstin("27AAPFU0939F1ZV").ok).toBe(true);
    expect(checkGstin("27aapfu0939f1zv").ok).toBe(true);
    expect(checkGstin("27AAPFU0939F1ZW").ok).toBe(false); // check character
    expect(checkGstin("40AAPFU0939F1ZV").ok).toBe(false); // state 40 does not exist
    expect(checkGstin("27AAPFU0939F1Y5").ok).toBe(false); // 14th character must be Z
    expect(checkGstin("123").ok).toBe(false);
  });
  it("computes the check character", () => expect(gstinCheckChar("27AAPFU0939F1Z")).toBe("V"));
});

describe("mobile", () => {
  it("normalises to 10 digits", () => {
    for (const s of ["9876543210", "+91 98765 43210", "919876543210", "09876543210", "98765-43210"]) expect(checkMobile(s)).toEqual({ ok: true, value: "9876543210" });
  });
  it("rejects numbers that cannot be Indian mobiles", () => {
    for (const s of ["5876543210", "987654321", "98765432101", "abcdefghij", ""]) expect(checkMobile(s).ok).toBe(false);
  });
});

describe("pincode", () => {
  it("6 digits, not starting with 0", () => {
    expect(checkPincode("302 001")).toEqual({ ok: true, value: "302001" });
    expect(checkPincode("012345").ok).toBe(false);
    expect(checkPincode("30200").ok).toBe(false);
  });
});

describe("vehicle numbers", () => {
  it("accepts every plate style used in India", () => {
    const good: [string, string][] = [
      ["RJ14 GD 9158", "standard"], ["rj14gd9158", "standard"], ["DL 1 C 1234", "standard"], ["MH12 AB 123", "standard"], ["UP32 1234", "standard"],
      ["TS 09 EA 1234", "standard"], ["TG08AB1234", "standard"], ["GJ-01-XY-0001", "standard"], ["22 BH 1234 AB", "bh"], ["09B123456K", "defence"], ["39 CD 1", "diplomatic"],
    ];
    for (const [s, kind] of good) expect(checkVehicle(s), s).toMatchObject({ ok: true, kind });
  });
  it("rejects wrong plates with a hint", () => {
    for (const s of ["", "RJ", "ABCD1234", "XX14 GD 9158", "RJ00 GD 9158", "RJ14 GD 0000", "12345678", "RJ14 GDXX 9158"]) expect(checkVehicle(s).ok, s).toBe(false);
  });
  it("formats readable", () => {
    expect(formatVehicle("RJ14GD9158")).toBe("RJ14 GD 9158");
    expect(formatVehicle("22BH1234AB")).toBe("22 BH 1234 AB");
    expect(formatVehicle("UP321234")).toBe("UP32 1234");
  });
});
