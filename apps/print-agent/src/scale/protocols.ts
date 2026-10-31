// How weighing indicators put a weight on a serial (RS-232 / RS-485 / USB-serial) or network line, and how to read it back.
// Pure code (no Electron, no I/O) so every format is covered by unit tests with real sample frames.
//
// The formats follow the manufacturers' published continuous-output layouts:
//  - toledo      Mettler Toledo "standard continuous" (STX + 3 status bytes + 6 weight + 6 tare + CR [+ checksum]); copied by many brands
//  - xk3190      Yaohua XK3190 / Keli and compatibles, continuous tF=0: STX, sign, 6 digits, decimals, XOR (2 chars), ETX
//  - xk3190_rev  Yaohua XK3190 reversed stream (tF=2/3): the displayed digits reversed, frames separated by "="
//  - and_std     A&D standard and the many indicators that copy it: "ST,GS,+0012345kg" (ST stable, US moving, OL overload)
//  - mt_sics     Mettler Toledo MT-SICS answer: "S S     12345 kg" (S stable, D dynamic)
//  - generic     any readable line with one weight in it (Essae, Avery, Leo, Rice Lake, Cardinal and other plain outputs)
// Only listening is needed for all of them; request strings exist for the two "ask" protocols and are READ-ONLY (never tare/zero/print).

export type Unit = "kg" | "t" | "g" | "lb" | "";

export interface Reading {
  /** the number as the indicator shows it, in `unit`; null when the frame carries no weight (overload, error) */
  value: number | null;
  unit: Unit;
  /** null = this format does not say */
  stable: boolean | null;
  overload: boolean;
  /** true/false when the frame has a checksum, null when it has none */
  checksumOk: boolean | null;
  /** the frame as text (non-printable bytes shown as <xx>), for the diagnostics screen */
  raw: string;
}

export interface Scan { readings: Reading[]; consumed: number }

export interface ProtocolInfo {
  id: ProtocolId;
  name: string;
  families: string;
  /** 3 = strictly framed (wins ties in auto-detection) â¦ 1 = loose */
  specificity: number;
  /** read-only request for indicators that only answer when asked; empty for continuous formats */
  request: string;
  scan(text: string): Scan;
}

export type ProtocolId = "toledo" | "xk3190" | "xk3190_rev" | "and_std" | "mt_sics" | "generic";

const UNITS: Record<string, Unit> = { kg: "kg", kgs: "kg", t: "t", ton: "t", tn: "t", g: "g", gr: "g", lb: "lb", lbs: "lb" };
export const normUnit = (u: string | undefined): Unit => UNITS[(u ?? "").trim().toLowerCase()] ?? "";

/** Bytes as a 1:1 text (latin-1), optionally with the top bit cleared (7 data bits + parity received as 8N1). */
export function bytesToText(b: Uint8Array, mask7 = false): string {
  let s = "";
  for (let i = 0; i < b.length; i++) { const v = b[i]!; s += String.fromCharCode(mask7 ? v & 0x7f : v); }
  return s;
}
export function showRaw(s: string): string {
  return s.replace(/[\x00-\x1f\x7f-\xff]/g, (c) => `<${c.charCodeAt(0).toString(16).padStart(2, "0")}>`);
}
const num = (s: string) => Number(s.replace(/\s+/g, "").replace(",", "."));
const isNum = (n: number) => Number.isFinite(n);

/** End of the last line terminator (CR, LF or ETX) so an incomplete line stays in the buffer. */
function lastTerminator(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) { const c = text.charCodeAt(i); if (c === 0x0d || c === 0x0a || c === 0x03) return i + 1; }
  return 0;
}
/** Complete lines (between CR / LF / ETX), STX and NUL stripped. */
function completeLines(text: string): { lines: string[]; consumed: number } {
  const consumed = lastTerminator(text);
  const lines = text.slice(0, consumed).split(/[\r\n\x03]+/).map((l) => l.replace(/^[\x02\x00\s]+|[\x00\s]+$/g, "")).filter(Boolean);
  return { lines, consumed };
}

/** Line formats: the first line of a capture usually starts mid-frame ("65" of "000065"), so it is never read. */
const LINE_FORMATS = new Set<ProtocolId>(["and_std", "mt_sics", "generic"]);
function firstTerminator(text: string): number {
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if (c === 0x0d || c === 0x0a || c === 0x03) return i + 1; }
  return -1;
}

// ---- Mettler Toledo standard continuous ----------------------------------------------------------------------------------
// STX SWA SWB SWC W6 T6 CR [CHK]. SWA bits 0-2 decimal position (X00, X0, X, 0.X â¦ 0.0000X); SWB bit0 net, bit1 negative,
// bit2 over/under range, bit3 motion, bit4 kg (else lb); SWC bits 0-2 override the unit (1 g, 2 t). Bit 5 is always set.
// CHK (optional) = two's complement of the 7-bit sum of STX..CR.
const TOLEDO = /\x02([\x20-\x7f])([\x20-\x7f])([\x20-\x7f])([0-9 ]{6})([0-9 ]{6})\r([^\x02])?/g;
const TOLEDO_FACTOR = [100, 10, 1, 0.1, 0.01, 0.001, 0.0001, 0.00001];
const TOLEDO_DEC = [0, 0, 0, 1, 2, 3, 4, 5];
function scanToledo(text: string): Scan {
  const readings: Reading[] = [];
  let consumed = 0;
  for (const m of text.matchAll(TOLEDO)) {
    const [swa, swb, swc] = [m[1]!.charCodeAt(0), m[2]!.charCodeAt(0), m[3]!.charCodeAt(0)];
    const end = m.index! + m[0].length;
    if (!(swa & 0x20 && swb & 0x20 && swc & 0x20)) continue;
    // nothing after CR yet: a checksum byte may still be on its way, so wait for the next chunk
    if (m[6] === undefined && end === text.length) break;
    consumed = end;
    const dp = swa & 0x07;
    let value = Number((Number(m[4]!.replace(/ /g, "0")) * TOLEDO_FACTOR[dp]!).toFixed(TOLEDO_DEC[dp]));
    if (swb & 0x02) value = -value;
    const unit: Unit = ({ 1: "g", 2: "t" } as Record<number, Unit>)[swc & 0x07] ?? (swb & 0x10 ? "kg" : "lb");
    const frame = text.slice(m.index!, m.index! + 17);
    let checksumOk: boolean | null = null;
    if (m[6] !== undefined) {
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame.charCodeAt(i) & 0x7f;
      checksumOk = ((-sum) & 0x7f) === (m[6].charCodeAt(0) & 0x7f);
      // no checksum configured: the byte after CR is just a line feed / end marker
      if (!checksumOk && "\n\r\x03\x00 ".includes(m[6])) checksumOk = null;
    }
    readings.push({ value, unit, stable: !(swb & 0x08), overload: !!(swb & 0x04), checksumOk, raw: showRaw(frame) });
  }
  return { readings, consumed };
}

// ---- Yaohua XK3190 / Keli continuous (tF=0) ----------------------------------------------------------------------------------
// 12 bytes: STX, sign (+/-), 6 digits (most significant first), decimals (0-4), XOR high, XOR low, ETX.
// The XOR covers sign..decimals; brands send it either as hex characters ("4A") or as 0x30 + nibble.
const XK = /\x02([+-])(\d{6})([0-4])([\x00-\xff]{2})\x03/g;
function scanXk3190(text: string): Scan {
  const readings: Reading[] = [];
  let consumed = 0;
  for (const m of text.matchAll(XK)) {
    consumed = m.index! + m[0].length;
    const body = m[1]! + m[2]! + m[3]!;
    let x = 0;
    for (let i = 0; i < body.length; i++) x ^= body.charCodeAt(i);
    const hex = (x >> 4).toString(16).toUpperCase() + (x & 0xf).toString(16).toUpperCase();
    const nib = String.fromCharCode(0x30 + (x >> 4), 0x30 + (x & 0xf));
    const got = m[4]!.toUpperCase();
    const dec = Number(m[3]);
    const value = Number((Number(m[2]) / 10 ** dec).toFixed(dec)) * (m[1] === "-" ? -1 : 1);
    readings.push({ value, unit: "", stable: null, overload: false, checksumOk: got === hex || m[4] === nib, raw: showRaw(m[0]) });
  }
  return { readings, consumed };
}

// ---- Yaohua XK3190 reversed stream (tF=2/3) ------------------------------------------------------------------------------------
// "=" separates frames; each frame is the displayed weight with its characters reversed: 70.15 -> "51.07000".
function scanXkReversed(text: string): Scan {
  const readings: Reading[] = [];
  const last = text.lastIndexOf("=");
  if (last < 0) return { readings, consumed: 0 };
  const parts = text.slice(0, last).split("=");
  // the part before the first "=" may be a cut-off frame
  for (const p of parts.slice(1)) {
    const t = p.trim();
    if (!/^[-0-9.]{5,10}$/.test(t) || (t.match(/\./g)?.length ?? 0) > 1 || t.indexOf("-") > -1 && t.indexOf("-") !== t.length - 1) continue;
    const value = Number(t.split("").reverse().join(""));
    if (!isNum(value)) continue;
    readings.push({ value, unit: "", stable: null, overload: false, checksumOk: null, raw: showRaw("=" + t) });
  }
  return { readings, consumed: last };
}

// ---- A&D standard ("ST,GS,+0012345kg") -----------------------------------------------------------------------------------------
const AND = /^(ST|US|OL|QT|WT)\s*,\s*(?:(GS|NT|TR|G|N)\s*,\s*)?([-+])?\s*(\d+(?:[.,]\d+)?)?\s*([A-Za-z]{0,3})/;
function scanAnd(text: string): Scan {
  const { lines, consumed } = completeLines(text);
  const readings: Reading[] = [];
  for (const line of lines) {
    const m = AND.exec(line);
    if (!m) continue;
    if (m[1] === "OL" || !m[4]) { readings.push({ value: null, unit: "", stable: null, overload: m[1] === "OL", checksumOk: null, raw: showRaw(line) }); continue; }
    readings.push({ value: num(m[4]) * (m[3] === "-" ? -1 : 1), unit: normUnit(m[5]), stable: m[1] === "ST" || m[1] === "QT", overload: false, checksumOk: null, raw: showRaw(line) });
  }
  return { readings, consumed };
}

// ---- Mettler Toledo MT-SICS answer ("S S     12345 kg") ---------------------------------------------------------------------
const SICS = /^S\s+([SD+-])\s*([-+]?\s*\d+(?:[.,]\d+)?)?\s*([A-Za-z]{0,3})/;
function scanSics(text: string): Scan {
  const { lines, consumed } = completeLines(text);
  const readings: Reading[] = [];
  for (const line of lines) {
    const m = SICS.exec(line);
    if (!m) continue;
    if (m[1] === "+" || m[1] === "-") readings.push({ value: null, unit: "", stable: null, overload: true, checksumOk: null, raw: showRaw(line) });
    else if (m[2]) readings.push({ value: num(m[2]), unit: normUnit(m[3]), stable: m[1] === "S", overload: false, checksumOk: null, raw: showRaw(line) });
  }
  return { readings, consumed };
}

// ---- Any readable line with one weight in it ---------------------------------------------------------------------------------
// e.g. "  12340 kg", "WT:+0012340", "G   12340 kg", "+0012340", "S  12340", "12.340 t". A line that names TARE is skipped
// (a printed ticket line, not the live weight); a line with several different numbers is ambiguous and skipped.
const GEN_NUM = /([-+]?)\s*(\d+(?:[.,]\d+)?)\s*(kgs?|tn|ton|t|lbs?|g)?(?![A-Za-z0-9])/gi;
function scanGeneric(text: string): Scan {
  const { lines, consumed } = completeLines(text);
  const readings: Reading[] = [];
  for (const line of lines) {
    if (line.length > 64) continue;
    let printable = 0;
    for (let i = 0; i < line.length; i++) { const c = line.charCodeAt(i); if (c >= 0x20 && c < 0x7f) printable++; }
    if (printable < line.length * 0.95) continue;
    if (/tare|\bTR\b|\bPT\b/i.test(line)) continue;
    const nums = [...line.matchAll(GEN_NUM)];
    if (nums.length === 0) continue;
    const values = new Set(nums.map((n) => num(n[2]!)));
    if (values.size > 1) continue;
    const m = nums[nums.length - 1]!;
    const value = num(m[2]!) * (m[1] === "-" ? -1 : 1);
    if (!isNum(value)) continue;
    const overload = /\b(OL|OVER|OVERLOAD|ERR)\b/i.test(line);
    const stable = /\b(US|M|MOTION|D)\b|\?/.test(line) ? false : /\b(ST|S)\b/.test(line) ? true : null;
    readings.push({ value: overload ? null : value, unit: normUnit(m[3]), stable, overload, checksumOk: null, raw: showRaw(line) });
  }
  return { readings, consumed };
}

export const PROTOCOLS: Record<ProtocolId, ProtocolInfo> = {
  toledo: { id: "toledo", name: "Mettler Toledo continuous", families: "Mettler Toledo IND / Panther / Jaguar / Lynx and compatible indicators", specificity: 3, request: "", scan: scanToledo },
  xk3190: { id: "xk3190", name: "XK3190 / Keli continuous (tF=0)", families: "Yaohua XK3190-A9 / A12 / A15 / A27, Keli D2008 / XK3118 and compatibles", specificity: 3, request: "", scan: scanXk3190 },
  xk3190_rev: { id: "xk3190_rev", name: "XK3190 reversed stream (=)", families: "Yaohua XK3190 in tF=2/3 and compatibles", specificity: 2, request: "", scan: scanXkReversed },
  and_std: { id: "and_std", name: "A&D standard (ST/US/OL)", families: "A&D, CAS and many Asian / Indian indicators", specificity: 3, request: "Q\r\n", scan: scanAnd },
  mt_sics: { id: "mt_sics", name: "Mettler Toledo MT-SICS", families: "Mettler Toledo terminals that answer SI", specificity: 3, request: "SI\r\n", scan: scanSics },
  generic: { id: "generic", name: "Plain text weight", families: "Essae, Avery, Leo, Rice Lake, Cardinal and other plain outputs", specificity: 1, request: "", scan: scanGeneric },
};
/** Continuous formats, in the order auto-detection tries them. */
export const CONTINUOUS: ProtocolId[] = ["toledo", "xk3190", "and_std", "mt_sics", "xk3190_rev", "generic"];
/** Formats that only answer a read-only request. */
export const ASKED: ProtocolId[] = ["mt_sics", "and_std"];

/** Weight in kg. Frames without a unit use the unit the indicator is set to (kg or tonne). null = not a mass. */
export function toKg(value: number, unit: Unit, indicatorUnit: "kg" | "t"): number | null {
  const u = unit || indicatorUnit;
  const f = u === "kg" ? 1 : u === "t" ? 1000 : u === "g" ? 0.001 : u === "lb" ? 0.45359237 : null;
  return f === null ? null : Number((value * f).toFixed(3));
}

/**
 * Streaming decoder for one protocol: bytes in, readings out. Keeps the unfinished tail between chunks and never lets
 * the buffer grow without bound (a wrong speed produces garbage forever).
 */
export class Decoder {
  private buf = "";
  /** line formats: false until the first line end was seen (what came before it is a cut-off frame) */
  private synced: boolean;
  constructor(public readonly protocol: ProtocolId, private readonly mask7 = false, startsMidStream = true) {
    this.synced = !startsMidStream || !LINE_FORMATS.has(protocol);
  }
  push(bytes: Uint8Array): Reading[] {
    this.buf += bytesToText(bytes, this.mask7);
    if (!this.synced) {
      const i = firstTerminator(this.buf);
      if (i < 0) { if (this.buf.length > 256) this.buf = this.buf.slice(-256); return []; }
      this.buf = this.buf.slice(i);
      this.synced = true;
    }
    const { readings, consumed } = PROTOCOLS[this.protocol].scan(this.buf);
    if (consumed > 0) this.buf = this.buf.slice(consumed);
    if (this.buf.length > 2048) this.buf = this.buf.slice(-256);
    return readings;
  }
  reset() { this.buf = ""; this.synced = !LINE_FORMATS.has(this.protocol); }
}

// ---- auto-detection ------------------------------------------------------------------------------------------------------------
const FRAMING = new Set([0x02, 0x03, 0x0a, 0x0d, 0x09]);
/** Share of bytes that are readable text or framing characters (0..1). */
export function readability(b: Uint8Array, mask7 = false): number {
  if (!b.length) return 0;
  let ok = 0;
  for (let i = 0; i < b.length; i++) { const v = b[i]!; const c = mask7 ? v & 0x7f : v; if ((c >= 0x20 && c <= 0x7e) || FRAMING.has(c)) ok++; }
  return ok / b.length;
}

export interface Detection { protocol: ProtocolId; mask7: boolean; readings: Reading[]; score: number }

/**
 * Which format (if any) a sample captured at one speed is. Bytes that only become readable with the top bit cleared are
 * 7 data bits + parity (7E1/7O1) received as 8N1 â both frame 10 bits, so the same capture is decoded with the bit cleared.
 * Frames with a failing checksum never count. Needs at least 3 readings (one for an asked format).
 */
export function detect(sample: Uint8Array, minFrames = 3): Detection | null {
  const r8 = readability(sample), r7 = readability(sample, true);
  const tries = r8 >= 0.85 || r7 < 0.9 ? [false, true] : [true, false];
  let best: Detection | null = null;
  for (const mask7 of tries) {
    const all = bytesToText(sample, mask7);
    const cut = firstTerminator(all);
    for (const id of CONTINUOUS) {
      const text = LINE_FORMATS.has(id) && cut > 0 ? all.slice(cut) : all;
      const valid = PROTOCOLS[id].scan(text).readings.filter((r) => r.checksumOk !== false && (r.value !== null || r.overload));
      if (valid.length < minFrames) continue;
      // plain numbers carry no frame or checksum, so a wrong speed can look like them: demand clean text and a weight that repeats
      // (an indicator sends the same weight many times a second; noise does not)
      if (id === "generic") {
        if (readability(sample, mask7) < 0.97 || valid.length < Math.max(minFrames, 5)) continue;
        const seen = new Map<number | null, number>();
        for (const r of valid) seen.set(r.value, (seen.get(r.value) ?? 0) + 1);
        if (Math.max(...seen.values()) < 3) continue;
      }
      const verified = valid.filter((r) => r.checksumOk === true).length;
      const score = PROTOCOLS[id].specificity * 1000 + verified * 10 + valid.length - (mask7 ? 1 : 0);
      if (!best || score > best.score) best = { protocol: id, mask7, readings: valid, score };
    }
  }
  return best;
}
