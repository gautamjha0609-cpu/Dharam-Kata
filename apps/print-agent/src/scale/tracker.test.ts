import { describe, expect, it } from "vitest";
import type { Reading } from "./protocols";
import { FRESH_MS, WeightTracker } from "./tracker";

const r = (value: number | null, o: Partial<Reading> = {}): Reading => ({ value, unit: "", stable: null, overload: false, checksumOk: null, raw: String(value), ...o });
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
});
