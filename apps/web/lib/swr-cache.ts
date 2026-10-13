/**
 * A tiny in-memory "show what you had, then check again" cache.
 * Screens that were visited a moment ago open with their last data at once; a background request then refreshes it.
 * It lives only in this browser tab (gone on reload), holds small settings-like data (receipt layout, extra fields, parties), and is cleared
 * when something that changes that data is saved. Never used for money (balances, invoices): those are always read fresh.
 */
const store = new Map<string, { v: unknown; t: number }>();

/** The cached value, or undefined if there is none (or it is older than `maxAge` ms). */
export function peek<T>(key: string, maxAge = 10 * 60_000): T | undefined {
  const e = store.get(key);
  return e && Date.now() - e.t <= maxAge ? (e.v as T) : undefined;
}
export function put<T>(key: string, v: T): T {
  store.set(key, { v, t: Date.now() });
  return v;
}
/** true if the value was stored less than `age` ms ago: no background check is needed yet. */
export function isFresh(key: string, age: number): boolean {
  const e = store.get(key);
  return !!e && Date.now() - e.t <= age;
}
/** Forget cached data (all of it, or keys starting with `prefix`). Call after saving something the cache holds. */
export function clearCache(prefix?: string) {
  if (!prefix) return store.clear();
  for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k);
}
