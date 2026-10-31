"use client";
import { useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";

type LiveTable = "invoices" | "print_jobs";

/**
 * Keeps a screen fresh WITHOUT polling the database.
 *  - one realtime channel for the firm (only the tables the screen needs); an event schedules ONE refetch,
 *    never sooner than 1.5 s after the event and never more often than every 10 s (a busy site does not hammer the database)
 *  - events that arrive while the tab is hidden cost nothing: the screen refreshes once, when the person comes back
 *  - coming back to the tab (or the network) after more than `staleMs` also refreshes once
 *  - nothing runs on a timer
 */
export function useLive(refresh: () => void | Promise<unknown>, tables: readonly LiveTable[], opts: { staleMs?: number } = {}) {
  const { org } = useApp();
  const orgId = org?.organization_id;
  const latest = useRef(refresh);
  latest.current = refresh; // always call the newest version of the screen's loader
  const key = tables.join(",");
  const staleMs = opts.staleMs ?? 60_000;

  useEffect(() => {
    if (!orgId) return;
    let last = Date.now();
    let stale = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => { stale = false; last = Date.now(); void latest.current(); };
    const onChange = () => {
      if (document.hidden) { stale = true; return; }
      clearTimeout(timer);
      timer = setTimeout(run, Math.max(1500, 10_000 - (Date.now() - last)));
    };
    const onBack = () => { if (!document.hidden && (stale || Date.now() - last > staleMs)) run(); };

    const sb = supabase();
    let ch = sb.channel(`live-${orgId}-${key}`);
    for (const t of key.split(",")) ch = ch.on("postgres_changes", { event: "*", schema: "public", table: t, filter: `organization_id=eq.${orgId}` }, onChange);
    ch.subscribe();
    document.addEventListener("visibilitychange", onBack);
    window.addEventListener("focus", onBack);
    window.addEventListener("online", onBack);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onBack);
      window.removeEventListener("focus", onBack);
      window.removeEventListener("online", onBack);
      void sb.removeChannel(ch);
    };
  }, [orgId, key, staleMs]);
}
