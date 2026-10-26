"use client";
import { useEffect } from "react";

/**
 * Runs `fn` every `ms` while the page is on screen. A tab in the background makes no requests; when it comes back it refreshes at
 * once, so what the person sees is as fresh as before.
 */
export function useVisibleInterval(fn: () => void, ms: number) {
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) fn(); }, ms);
    const back = () => { if (!document.hidden) fn(); };
    document.addEventListener("visibilitychange", back);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", back); };
  }, [fn, ms]);
}
