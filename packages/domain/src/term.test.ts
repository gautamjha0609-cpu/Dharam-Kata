import { describe, expect, it } from "vitest";
import { daysLeft, istToday, plusOneYear, termState } from "./term";

const at = (iso: string) => new Date(iso); // instants

describe("annual term", () => {
  it("uses the Indian date (a night after 18:30 UTC is already the next day in India)", () => {
    expect(istToday(at("2026-10-14T18:29:00Z"))).toBe("2026-10-14");
    expect(istToday(at("2026-10-14T18:31:00Z"))).toBe("2026-10-15");
  });
  it("counts days to the end date", () => {
    expect(daysLeft("2026-10-24", at("2026-10-14T05:00:00Z"))).toBe(10);
    expect(daysLeft("2026-10-14", at("2026-10-14T05:00:00Z"))).toBe(0);
    expect(daysLeft("2026-10-13", at("2026-10-14T05:00:00Z"))).toBe(-1);
  });
  it("is ok > 10 days, due soon for 10..1 days, expired ON the end date", () => {
    const now = at("2026-10-14T05:00:00Z");
    expect(termState("2026-10-25", now).kind).toBe("ok");        // 11 days
    expect(termState("2026-10-24", now)).toEqual({ kind: "due_soon", days: 10 });
    expect(termState("2026-10-15", now)).toEqual({ kind: "due_soon", days: 1 });
    expect(termState("2026-10-14", now).kind).toBe("expired");   // stops today
    expect(termState("2026-09-01", now).kind).toBe("expired");
    expect(termState(null, now).kind).toBe("ok");
  });
  it("extends by exactly one year from the current end date (the anniversary never moves)", () => {
    expect(plusOneYear("2027-10-12")).toBe("2028-10-12");
    expect(plusOneYear("2028-02-29")).toBe("2029-02-28");
  });
});
