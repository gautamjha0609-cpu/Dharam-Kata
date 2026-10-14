"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { istToday, termState } from "@dk/domain";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";

interface Notice { key: string; tone: "info" | "warn" | "danger"; title: string; text: string }

const SHOW_FOR_MS = 10_000;

/** How many times a notice has been shown (per key, kept on this device). */
function seen(key: string): number { try { return Number(localStorage.getItem(`dk.notice.${key}`) ?? "0") || 0; } catch { return 0; } }
function mark(key: string) { try { localStorage.setItem(`dk.notice.${key}`, String(seen(key) + 1)); } catch { /* ignore */ } }

const dmy = (d: string) => new Date(`${d}T00:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });

/**
 * Messages that come to the user, shown one at a time as a card at the top of the screen:
 *  - the firm's annual maintenance is due (last 10 days): when the person opens the New weighment screen, the first 2 times each day
 *  - the firm's service has ended and it is suspended: the first 2 times each day the app is opened
 *  - a broadcast from the platform admin: the first 2 times the app is opened, per message
 * Each card disappears by itself after 10 seconds and has a small cross at its top-left corner.
 * Counters live on the device, so this costs the database nothing (the broadcasts are one small read per app start).
 */
export function NoticeHost() {
  const { org } = useApp();
  const path = usePathname();
  const [queue, setQueue] = useState<Notice[]>([]);
  const added = useRef(new Set<string>());
  const orgId = org?.organization_id;
  const until = org?.service_until ?? null;

  const push = useCallback((n: Notice) => {
    if (added.current.has(n.key)) return;
    added.current.add(n.key);
    mark(n.key);
    setQueue((q) => [...q, n]);
  }, []);

  // service ended -> suspension notice (once per app start, at most 2 per day)
  useEffect(() => {
    if (!orgId) return;
    const st = termState(until);
    const today = istToday();
    if (st.kind === "expired" && seen(`expired.${orgId}.${today}`) < 2) {
      push({ key: `expired.${orgId}.${today}`, tone: "danger", title: "Service suspended",
        text: `Your annual maintenance ended on ${until ? dmy(until) : "the due date"}, so your ID is suspended. You can look at your records, but nothing new can be saved. Please pay the annual maintenance charge to continue.` });
    }
  }, [orgId, until, push]);

  // maintenance due in the last 10 days -> when a new weighment is about to be entered
  useEffect(() => {
    if (!orgId || path !== "/weighments/new") return;
    const st = termState(until);
    if (st.kind !== "due_soon") return;
    const today = istToday();
    const key = `due.${orgId}.${today}`;
    if (seen(key) >= 2) return;
    added.current.delete(key); // the same key can be shown again (it is counted, max 2 a day)
    const d = st.days;
    push({ key, tone: "warn", title: d === 1 ? "Annual maintenance is due tomorrow" : `Annual maintenance is due in ${d} days`,
      text: `Please pay the annual maintenance charge${until ? ` (due ${dmy(until)})` : ""}, or your ID will be suspended.` });
  }, [orgId, until, path, push]);

  // broadcasts from the platform admin
  useEffect(() => {
    if (!orgId) return;
    let live = true;
    void supabase().from("broadcasts").select("id,message,created_at").order("created_at", { ascending: false }).limit(3)
      .then(({ data }: { data: unknown }) => {
        if (!live) return;
        for (const b of ((data ?? []) as { id: string; message: string }[]).reverse()) {
          if (seen(`bc.${b.id}`) < 2) push({ key: `bc.${b.id}`, tone: "info", title: "Message from The Valuation House", text: b.message });
        }
      });
    return () => { live = false; };
  }, [orgId, push]);

  const current = queue[0];
  useEffect(() => {
    if (!current) return;
    const t = setTimeout(() => setQueue((q) => q.slice(1)), SHOW_FOR_MS);
    return () => clearTimeout(t);
  }, [current]);

  if (!current) return null;
  const tone = { info: "border-sky-300 bg-white", warn: "border-amber-400 bg-amber-50", danger: "border-red-400 bg-red-50" }[current.tone];
  const bar = { info: "bg-sky-500", warn: "bg-amber-500", danger: "bg-red-500" }[current.tone];
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[80] flex justify-center px-3">
      <div key={current.key + queue.length} role="alert" aria-live="assertive" className={`ios-fade pointer-events-auto relative w-full max-w-md overflow-hidden rounded-2xl border p-4 pl-12 shadow-xl ${tone}`}>
        <button type="button" aria-label="Close this message" title="Close" onClick={() => setQueue((q) => q.slice(1))}
          className="absolute left-2 top-2 grid h-8 w-8 place-items-center rounded-full border border-slate-300 bg-white text-base leading-none text-slate-700 hover:bg-slate-100">✕</button>
        <p className="font-semibold text-navy">{current.title}</p>
        <p className="mt-0.5 text-sm text-slate-700">{current.text}</p>
        {queue.length > 1 && <p className="mt-1 text-xs text-slate-500">{queue.length - 1} more message{queue.length > 2 ? "s" : ""}</p>}
        <span aria-hidden className={`absolute bottom-0 left-0 h-1 ${bar}`} style={{ animation: `dk-notice ${SHOW_FOR_MS}ms linear forwards` }} />
      </div>
    </div>
  );
}
