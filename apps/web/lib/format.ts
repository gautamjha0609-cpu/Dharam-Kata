const TZ = "Asia/Kolkata";
export const inr = (n: number | string) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(n || 0));
export const num = (n: number | string, dp = 3) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: dp }).format(Number(n || 0));
export const fmtDateTime = (iso?: string | null) =>
  iso ? new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)) : "-";
/** <input type=datetime-local> value in IST -> ISO string with offset. */
export const istLocalToIso = (v: string) => (v ? new Date(`${v}:00+05:30`).toISOString() : null);
export const nowIstLocal = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 16);
export const newIdemKey = () => crypto.randomUUID();
