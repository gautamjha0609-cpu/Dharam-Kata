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

export function usePcCheck(orgId: string | null | undefined, siteId: string | null | undefined, onAnswered: () => void, opts: { admin?: boolean } = {}) {
  const [askedAt, setAskedAt] = useState<string | null>(null);
  const done = useRef(onAnswered);
  done.current = onAnswered;
  const ask = useCallback(async () => {
    if (!opts.admin && !orgId) return;
    const { data } = opts.admin
      ? await supabase().rpc("admin_check_pcs")
      : await supabase().rpc("check_pcs", { p_org: orgId!, p_site: siteId ?? null });
    if (typeof data === "string") setAskedAt(data);
    // most PCs answer within ~1 s; a slow network gets a second look
    setTimeout(() => done.current(), 2500);
    setTimeout(() => done.current(), 7000);
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
