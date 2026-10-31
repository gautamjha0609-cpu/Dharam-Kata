import { describe, expect, it } from "vitest";
import type { Reading } from "./protocols";
import { FRESH_MS, NOFLAG_MIN_SPAN_MS, WeightTracker } from "./tracker";

// frames from a format that reports steady / moving (the plain-number rules are tested separately below)
const r = (value: number | null, o: Partial<Reading> = {}): Reading => ({ value, unit: "", stable: true, overload: false, checksumOk: null, raw: String(value), ...o });
const plain = (value: number) => r(value, { stable: null });
const feed = (t: WeightTracker, values: (number | Reading)[], start = 0, step = 100) =>
  values.forEach((v, i) => t.push(typeof v === "number" ? r(v) : v, start + i * step));

describe("WeightTracker", () => {
  it("no data at all", () => {
    expect(new WeightTracker().state(0).kind).toBe("no_data");
  });
  it("accepts a weight only after it held still long enough", () => {
    const t = new WeightTracker();
    feed(t, [34210, 34210, 34210]); // 200 ms span: too short
    expect(t.state(250).kind).toBe("moving");
    feed(t, [34210, 34210, 34210, 34210, 34210], 300);
    const s = t.state(750);
    expect(s).toMatchObject({ kind: "stable", kg: 34210 });
  });
  it("a changing weight is never stable", () => {
    const t = new WeightTracker();
    feed(t, [34000, 34100, 34150, 34200, 34210, 34205, 34210, 34200]);
    expect(t.state(750).kind).toBe("moving");
  });
  it("the indicator's motion flag wins over equal numbers", () => {
    const t = new WeightTracker();
    feed(t, Array.from({ length: 10 }, () => r(34210, { stable: false })));
    expect(t.state(950).kind).toBe("moving");
  });
  it("frames with a bad checksum are ignored, not trusted", () => {
    const t = new WeightTracker();
    feed(t, [34210, r(99999, { checksumOk: false }), 34210, 34210, r(11111, { checksumOk: false }), 34210, 34210, 34210, 34210, 34210]);
    expect(t.state(950)).toMatchObject({ kind: "stable", kg: 34210 });
    expect(t.rejected).toBe(2);
  });
  it("an old weight is never returned (cable pulled, indicator off)", () => {
    const t = new WeightTracker();
    feed(t, Array(10).fill(34210));
    expect(t.state(900).kind).toBe("stable");
    expect(t.state(900 + FRESH_MS + 1).kind).toBe("stale");
  });
  it("overload and non-mass units are reported, not converted", () => {
    const t = new WeightTracker();
    feed(t, [r(null, { overload: true })]);
    expect(t.state(10).kind).toBe("overload");
  });
  it("tonne indicators are converted to kg", () => {
    const t = new WeightTracker(() => "t");
    feed(t, Array(10).fill(34.21));
    expect(t.state(950)).toMatchObject({ kind: "stable", kg: 34210 });
  });
  it("plain numbers (no steady flag) must hold still for 2 seconds", () => {
    const t = new WeightTracker();
    // the Vinayak case: a weight pauses for under a second while the vehicle is still settling
    feed(t, Array.from({ length: 9 }, () => plain(12605)));
    expect(t.state(850).kind).toBe("moving");
    feed(t, Array.from({ length: 13 }, () => plain(12605)), 900);
    expect(t.state(NOFLAG_MIN_SPAN_MS + 150)).toMatchObject({ kind: "stable", kg: 12605 });
  });
  it("plain numbers that keep changing by a little are never steady", () => {
    const t = new WeightTracker();
    feed(t, [12605, 12605, 12605, 12605, 12605, 12620, 12620, 12620, 12620, 12550, 12550, 12550, 12550, 12550].map(plain), 0, 300);
    expect(t.state(13 * 300 + 50).kind).toBe("moving");
  });
});
