/**
 * Indian identifiers, validated in one place so the website, the database checks and the tests agree.
 * Every function takes what the person typed and returns { ok, value } where `value` is the clean, upper-case form to store,
 * or { ok: false, message } with a plain-language hint.
 */
export type Checked = { ok: true; value: string; kind?: string } | { ok: false; message: string };

const clean = (s: string) => s.toUpperCase().replace(/[\s.\-_/]+/g, "");

/* ---------------------------------------------------------------- PAN */
/** AAAAA9999A. The 4th letter says who the holder is: P person, C company, F firm, H HUF, A association, B body of individuals, G government, J artificial juridical person, L local authority, T trust. */
const PAN_RE = /^[A-Z]{3}[ABCFGHJLPT][A-Z][0-9]{4}[A-Z]$/;
export function checkPan(input: string): Checked {
  const v = clean(input);
  if (!PAN_RE.test(v)) return { ok: false, message: "PAN has 10 characters, like ABCDE1234F (5 letters, 4 digits, 1 letter)." };
  return { ok: true, value: v };
}

/* -------------------------------------------------------------- GSTIN */
const GST_STATES = new Set([...Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, "0")), "97", "99"]);
const B36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** The 15th character is a check character (mod-36 over the first 14): a mistyped digit is caught here, not at the GST portal. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = B36.indexOf(first14[i]!);
    if (v < 0) return "?";
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return B36[(36 - (sum % 36)) % 36]!;
}
export function checkGstin(input: string): Checked {
  const v = clean(input);
  if (!/^[0-9]{2}[A-Z]{3}[ABCFGHJLPT][A-Z][0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v)) return { ok: false, message: "GSTIN has 15 characters, like 27ABCDE1234F1Z5 (state code, PAN, entity number, Z, check character)." };
  if (!GST_STATES.has(v.slice(0, 2))) return { ok: false, message: "The first two digits of a GSTIN are the state code (01 to 38)." };
  if (gstinCheckChar(v.slice(0, 14)) !== v[14]) return { ok: false, message: "This GSTIN is not valid: please check each character against the certificate." };
  return { ok: true, value: v };
}

/* ------------------------------------------------------------- mobile */
/** Indian mobile: 10 digits starting 6, 7, 8 or 9. A leading +91, 91 or 0 is accepted and removed. */
export function checkMobile(input: string): Checked {
  let d = input.replace(/[\s\-()]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  if (/^91[0-9]{10}$/.test(d)) d = d.slice(2);
  else if (/^0[0-9]{10}$/.test(d)) d = d.slice(1);
  if (!/^[6-9][0-9]{9}$/.test(d)) return { ok: false, message: "Mobile number has 10 digits and starts with 6, 7, 8 or 9." };
  return { ok: true, value: d };
}

/* ------------------------------------------------------------ pincode */
export function checkPincode(input: string): Checked {
  const v = input.replace(/\s/g, "");
  if (!/^[1-9][0-9]{5}$/.test(v)) return { ok: false, message: "PIN code has 6 digits and does not start with 0." };
  return { ok: true, value: v };
}

/* ------------------------------------------------------------ vehicle */
/** RTO state / UT codes in use on number plates (including the older codes still seen on the road). */
export const RTO_STATES = new Set([
  "AN", "AP", "AR", "AS", "BR", "CG", "CH", "CT", "DD", "DL", "DN", "GA", "GJ", "HP", "HR", "JH", "JK", "KA", "KL", "LA", "LD", "MH", "ML", "MN", "MP", "MZ",
  "NL", "OD", "OR", "PB", "PY", "RJ", "SK", "TG", "TN", "TR", "TS", "UA", "UK", "UP", "WB",
]);

/**
 * Plates that exist in India:
 *  - standard:      RJ14 GD 9158 / DL 1 C 1234 / MH12 AB 123 / UP32 1234  (state, 1-2 digit RTO, 0-3 series letters, 1-4 digits)
 *  - BH series:     22 BH 1234 AB                                           (year, BH, 4 digits, 1-2 letters)
 *  - defence:       09 B 123456 K                                           (year, base code letter, 6 digits, class letter)
 *  - diplomatic:    39 CD 1 / 12 UN 5                                       (country code, CD / CC / UN, number)
 * The result is stored without spaces; `kind` says which kind it was.
 */
export function checkVehicle(input: string): Checked {
  const v = clean(input);
  let m = /^([A-Z]{2})([0-9]{1,2})([A-Z]{0,3})([0-9]{1,4})$/.exec(v);
  if (m) {
    if (!RTO_STATES.has(m[1]!)) return { ok: false, message: `“${m[1]}” is not a state code. Example: RJ14 GD 9158.` };
    if (Number(m[2]) === 0) return { ok: false, message: "The RTO number cannot be 00. Example: RJ14 GD 9158." };
    if (Number(m[4]) === 0) return { ok: false, message: "The last four digits cannot be 0000." };
    return { ok: true, value: v, kind: "standard" };
  }
  m = /^([0-9]{2})BH([0-9]{4})([A-Z]{1,2})$/.exec(v);
  if (m) return { ok: true, value: v, kind: "bh" };
  if (/^[0-9]{2}[A-Z][0-9]{6}[A-Z]$/.test(v)) return { ok: true, value: v, kind: "defence" };
  if (/^[0-9]{1,3}(CD|CC|UN)[0-9]{1,4}$/.test(v)) return { ok: true, value: v, kind: "diplomatic" };
  return { ok: false, message: "Enter the vehicle number like RJ14 GD 9158 (state, RTO, series, number). Bharat series: 22 BH 1234 AB." };
}

/** Readable form of a valid plate: RJ14GD9158 -> RJ14 GD 9158. */
export function formatVehicle(normalized: string): string {
  let m = /^([A-Z]{2})([0-9]{1,2})([A-Z]{0,3})([0-9]{1,4})$/.exec(normalized);
  if (m && RTO_STATES.has(m[1]!)) return [`${m[1]}${m[2]}`, m[3], m[4]].filter(Boolean).join(" ");
  m = /^([0-9]{2})BH([0-9]{4})([A-Z]{1,2})$/.exec(normalized);
  if (m) return `${m[1]} BH ${m[2]} ${m[3]}`;
  return normalized;
}
