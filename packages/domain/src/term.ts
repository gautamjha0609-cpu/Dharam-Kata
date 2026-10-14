/**
 * The annual service term of a firm. All dates are Indian calendar dates (IST): the service stops ON the "valid till" date
 * (the last working day is the day before) and continues once the platform admin extends it by one year.
 */
const DAY = 86_400_000;

/** Today's date in India as YYYY-MM-DD. */
export function istToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

/** Whole days from today (IST) to `until` (YYYY-MM-DD). 0 = the service stops today, negative = already stopped. */
export function daysLeft(until: string, now: Date = new Date()): number {
  return Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${istToday(now)}T00:00:00Z`)) / DAY);
}

export type TermState =
  | { kind: "ok"; days: number }
  | { kind: "due_soon"; days: number }   // 1..10 days left: remind
  | { kind: "expired"; days: number };   // today or earlier: suspended until extended

/** How many days before the end the reminder starts. */
export const REMINDER_DAYS = 10;

export function termState(until: string | null | undefined, now: Date = new Date()): TermState {
  if (!until) return { kind: "ok", days: Infinity };
  const days = daysLeft(until, now);
  if (days <= 0) return { kind: "expired", days };
  if (days <= REMINDER_DAYS) return { kind: "due_soon", days };
  return { kind: "ok", days };
}

/** Same calendar day one year later (29 Feb -> 28 Feb the next year), the way the database extends it. */
export function plusOneYear(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y + 1, m, 0)).getUTCDate();
  return `${y + 1}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
