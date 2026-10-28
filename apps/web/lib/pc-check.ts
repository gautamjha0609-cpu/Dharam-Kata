"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

/**
 * Printer PCs (Print Agent 0.2.2+) send no timed heartbeat. A page asks them "are you there?" only when it needs to know: when it opens,
 * and when "Check vehicle" is pressed (any code can fire `askPcs()`). Each PC answers within a second or two; `onAnswered` then reloads
 * the page's data. A PC counts as online when it answered after the last question (or, for older agents, sent its own heartbeat
 * in the last 90 s).
 */
export const PC_CHECK_EVENT = "dk-pc-check";
export const askPcs = () => { if (typeof window !== "undefined") window.dispatchEvent(new Event(PC_CHECK_EVENT)); };

// One question for the whole page: parts of a page that ask at the same moment (printer status, Detect weight) share it.
let shared: { key: string; at: number; asked: Promise<string | null> } | null = null;
function askOnce(key: string, run: () => Promise<string | null>): Promise<string | null> {
  if (shared && shared.key === key && Date.now() - shared.at < 3000) return shared.asked;
  shared = { key, at: Date.now(), asked: run() };
  return shared.asked;
}

export function usePcCheck(orgId: string | null | undefined, siteId: string | null | undefined, onAnswered: () => void, opts: { admin?: boolean } = {}) {
  const [askedAt, setAskedAt] = useState<string | null>(null);
  const done = useRef(onAnswered);
  done.current = onAnswered;
  const ask = useCallback(async () => {
    if (!opts.admin && !orgId) return;
    const asked = await askOnce(opts.admin ? "admin" : `${orgId}:${siteId ?? ""}`, async () => {
      const { data } = opts.admin
        ? await supabase().rpc("admin_check_pcs")
        : await supabase().rpc("check_pcs", { p_org: orgId!, p_site: siteId ?? null });
      return typeof data === "string" ? data : null;
    });
    if (asked) setAskedAt(asked);
    // a PC answers within ~1-2 s: one look after that is enough (the next "Check vehicle" asks again)
    setTimeout(() => done.current(), 2500);
  }, [orgId, siteId, opts.admin]);
  useEffect(() => { void ask(); }, [ask]);
  useEffect(() => {
    const h = () => void ask();
    window.addEventListener(PC_CHECK_EVENT, h);
    return () => window.removeEventListener(PC_CHECK_EVENT, h);
  }, [ask]);
  return { askedAt, ask };
}

/**
 * Online = answered the last question, or seen in the last 90 s (agents with their own heartbeat). A PC already asked by another page
 * in the last 15 s is not asked again, so an answer up to 20 s before "our" question still counts.
 */
export function isPcOnline(lastSeen: string | null | undefined, askedAt: string | null, serverOnline?: boolean): boolean {
  if (serverOnline) return true;
  if (!lastSeen) return false;
  const seen = Date.parse(lastSeen);
  if (askedAt && seen >= Date.parse(askedAt) - 20_000) return true;
  return Date.now() - seen < 90_000;
}
