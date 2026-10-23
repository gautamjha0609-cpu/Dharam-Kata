import { describe, expect, it } from "vitest";
import { Decoder, PROTOCOLS, detect, readability, toKg } from "./protocols";

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const xor = (body: string) => { let x = 0; for (const c of body) x ^= c.charCodeAt(0); return x; };
/** XK3190 tF=0 frame, checksum as hex characters (most brands) or as 0x30 + nibble. */
const xk = (sign: string, digits: string, dec: number, nibble = false) => {
  const body = sign + digits + String(dec);
  const x = xor(body);
  const chk = nibble ? String.fromCharCode(0x30 + (x >> 4), 0x30 + (x & 15)) : (x >> 4).toString(16).toUpperCase() + (x & 15).toString(16).toUpperCase();
  return "\x02" + body + chk + "\x03";
};
/** Mettler Toledo continuous frame (+ optional checksum). */
const toledo = (o: { dp?: number; neg?: boolean; motion?: boolean; kg?: boolean; over?: boolean; w: string; t?: string; chk?: boolean }) => {
  const swa = String.fromCharCode(0x20 | (o.dp ?? 2));
  const swb = String.fromCharCode(0x20 | (o.neg ? 2 : 0) | (o.over ? 4 : 0) | (o.motion ? 8 : 0) | (o.kg === false ? 0 : 16));
  const swc = String.fromCharCode(0x20);
  const frame = "\x02" + swa + swb + swc + o.w.padStart(6, "0") + (o.t ?? "000000") + "\r";
  if (!o.chk) return frame;
  let sum = 0; for (const c of frame) sum += c.charCodeAt(0) & 0x7f;
  return frame + String.fromCharCode((-sum) & 0x7f);
};
/** 7 data bits + even parity as it arrives when the port is opened 8N1 (top bit = parity). */
const as7E1 = (s: string) => Uint8Array.from(s, (c) => { const v = c.charCodeAt(0); let p = 0; for (let i = 0; i < 7; i++) p ^= (v >> i) & 1; return v | (p << 7); });

describe("XK3190 / Keli continuous", () => {
  it("reads weight, sign and decimals and verifies the checksum (hex form)", () => {
    const r = PROTOCOLS.xk3190.scan(xk("+", "034210", 0) + xk("+", "012345", 2) + xk("-", "000150", 1)).readings;
    expect(r.map((x) => x.value)).toEqual([34210, 123.45, -15]);
    expect(r.every((x) => x.checksumOk === true)).toBe(true);
  });
  it("accepts the 0x30+nibble checksum form", () => {
    expect(PROTOCOLS.xk3190.scan(xk("+", "034210", 0, true)).readings[0]!.checksumOk).toBe(true);
  });
  it("flags a corrupted frame instead of trusting it", () => {
    const bad = xk("+", "034210", 0).replace("34210", "34216");
    expect(PROTOCOLS.xk3190.scan(bad).readings[0]!.checksumOk).toBe(false);
  });
});

describe("Mettler Toledo continuous", () => {
  it("reads weight, unit, motion and negative", () => {
    const r = PROTOCOLS.toledo.scan(toledo({ w: "034210" }) + toledo({ w: "001234", dp: 3, motion: true }) + toledo({ w: "000020", neg: true }) + "\x02").readings;
    expect(r.map((x) => x.value)).toEqual([34210, 123.4, -20]);
    expect(r.map((x) => x.stable)).toEqual([true, false, true]);
    expect(r[0]!.unit).toBe("kg");
  });
  it("decimal codes 0 and 1 multiply (X00 / X0)", () => {
    const r = PROTOCOLS.toledo.scan(toledo({ w: "000342", dp: 0 }) + toledo({ w: "003421", dp: 1 }) + "\x02").readings;
    expect(r.map((x) => x.value)).toEqual([34200, 34210]);
  });
  it("verifies the optional checksum and ignores a plain line feed after CR", () => {
    const ok = PROTOCOLS.toledo.scan(toledo({ w: "034210", chk: true }) + "\x02").readings[0];
    expect(ok!.checksumOk).toBe(true);
    const lf = PROTOCOLS.toledo.scan(toledo({ w: "034210" }) + "\n" + toledo({ w: "034210" }) + "\n").readings;
    expect(lf.map((x) => x.checksumOk)).toEqual([null, null]);
    expect(lf).toHaveLength(2);
  });
  it("reports over-range and lb", () => {
    const r = PROTOCOLS.toledo.scan(toledo({ w: "999999", over: true }) + toledo({ w: "000100", kg: false }) + "\x02").readings;
    expect(r[0]!.overload).toBe(true);
    expect(r[1]!.unit).toBe("lb");
  });
});

describe("XK3190 reversed stream", () => {
  it("reverses the digits between '='", () => {
    const r = PROTOCOLS.xk3190_rev.scan("51.07000=51.07000=01243000=0").readings;
    expect(r.map((x) => x.value)).toEqual([70.15, 34210]);
  });
});

describe("A&D standard", () => {
  it("reads ST / US / OL", () => {
    const r = PROTOCOLS.and_std.scan("ST,GS,+0034210kg\r\nUS,GS,+0034180kg\r\nOL,GS,+9999999kg\r\nST,NT,+00012.50 t\r\n").readings;
    expect(r.map((x) => x.value)).toEqual([34210, 34180, null, 12.5]);
    expect(r.map((x) => x.stable)).toEqual([true, false, null, true]);
    expect(r[2]!.overload).toBe(true);
    expect(r[3]!.unit).toBe("t");
  });
});

describe("MT-SICS", () => {
  it("reads stable and dynamic answers", () => {
    const r = PROTOCOLS.mt_sics.scan("S S     34210 kg\r\nS D     34200 kg\r\n").readings;
    expect(r.map((x) => [x.value, x.stable])).toEqual([[34210, true], [34200, false]]);
  });
});

describe("plain text weight", () => {
  it("reads common Indian / plain formats", () => {
    const r = PROTOCOLS.generic.scan("  34210 kg\r\nWT:+0034210\r\nG   34210 kg\r\n+0034210\r\n34.210 t\r\nUS  34190 kg\r\n").readings;
    expect(r.map((x) => x.value)).toEqual([34210, 34210, 34210, 34210, 34.21, 34190]);
    expect(r[4]!.unit).toBe("t");
    expect(r[5]!.stable).toBe(false);
  });
  it("skips tare lines and ambiguous lines with different numbers", () => {
    const r = PROTOCOLS.generic.scan("TARE 15105 kg\r\nG 34210 N 19105\r\nGROSS 34210 kg\r\n").readings;
    expect(r.map((x) => x.value)).toEqual([34210]);
  });
  it("keeps an unfinished line for the next chunk", () => {
    const d = new Decoder("generic");
    expect(d.push(bytes("  3421"))).toEqual([]);
    expect(d.push(bytes("0 kg\r\n")).map((x) => x.value)).toEqual([34210]);
  });
});

describe("streaming decoder", () => {
  it("joins frames split across chunks at any byte", () => {
    const stream = xk("+", "034210", 0).repeat(3);
    for (let cut = 1; cut < stream.length; cut++) {
      const d = new Decoder("xk3190");
      const got = [...d.push(bytes(stream.slice(0, cut))), ...d.push(bytes(stream.slice(cut)))];
      expect(got.map((x) => x.value)).toEqual([34210, 34210, 34210]);
    }
  });
  it("does not grow without bound on garbage", () => {
    const d = new Decoder("toledo");
    for (let i = 0; i < 200; i++) d.push(new Uint8Array(100).fill(0xff));
    expect(d.push(bytes(toledo({ w: "034210" }) + "\x02")).map((x) => x.value)).toEqual([34210]);
  });
});

describe("auto-detection", () => {
  it("finds each format from a short capture", () => {
    expect(detect(bytes(xk("+", "034210", 0).repeat(5)))?.protocol).toBe("xk3190");
    expect(detect(bytes((toledo({ w: "034210", chk: true })).repeat(5)))?.protocol).toBe("toledo");
    expect(detect(bytes("ST,GS,+0034210kg\r\n".repeat(5)))?.protocol).toBe("and_std");
    expect(detect(bytes("  34210 kg\r\n".repeat(5)))?.protocol).toBe("generic");
    expect(detect(bytes("01243000=".repeat(6)))?.protocol).toBe("xk3190_rev");
  });
  it("finds 7E1 data received as 8N1 (top bit = parity)", () => {
    const d = detect(as7E1((toledo({ w: "034210" }) + "\n").repeat(5)));
    expect(d?.protocol).toBe("toledo");
    expect(d?.mask7).toBe(true);
    expect(d?.readings[0]!.value).toBe(34210);
  });
  it("rejects noise (wrong speed) and frames with bad checksums", () => {
    const noise = Uint8Array.from({ length: 400 }, (_, i) => (i * 73 + 41) & 0xff);
    expect(detect(noise)).toBeNull();
    const bad = xk("+", "034210", 0).replace("4210", "4211");
    expect(detect(bytes(bad.repeat(5)))).toBeNull();
    expect(readability(noise)).toBeLessThan(0.85);
  });
});

describe("units", () => {
  it("converts to kg and uses the indicator unit when the frame has none", () => {
    expect(toKg(34210, "", "kg")).toBe(34210);
    expect(toKg(34.21, "", "t")).toBe(34210);
    expect(toKg(34.21, "t", "kg")).toBe(34210);
    expect(toKg(1000, "lb", "kg")).toBe(453.592);
  });
});
