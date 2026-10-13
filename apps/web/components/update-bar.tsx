"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

const CURRENT = process.env.NEXT_PUBLIC_BUILD_ID;

/**
 * Tells people when a newer version of the app has been published, without bothering the server:
 *  - one tiny request (/api/version, ~30 bytes, no database) when the person returns to the tab, at most every 5 minutes,
 *    plus once every 15 minutes while the tab is open and visible
 *  - never reloads on its own while someone is typing: a bar offers "Update now"; the new version is also taken automatically
 *    the next time the person opens another page of the app (a safe moment: nothing is half-filled)
 */
export function UpdateBar() {
  const [pending, setPending] = useState(false);
  const path = usePathname();
  const first = useRef(true);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !CURRENT) return;
    let lastCheck = Date.now();
    const check = async () => {
      if (document.hidden || Date.now() - lastCheck < 5 * 60_000) return;
      lastCheck = Date.now();
      try {
        const r = await fetch("/api/version", { cache: "no-store" });
        const j = (await r.json()) as { v?: string };
        if (j.v && j.v !== CURRENT) setPending(true);
      } catch { /* offline: try again later */ }
    };
    const timer = setInterval(() => { lastCheck = 0; void check(); }, 15 * 60_000);
    document.addEventListener("visibilitychange", check);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", check); };
  }, []);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (pending) window.location.reload(); // the person moved to another page: load it with the new version
  }, [path, pending]);

  if (!pending) return null;
  return (
    <div role="status" className="fixed inset-x-0 bottom-20 z-[70] flex justify-center px-4 md:bottom-5">
      <div className="flex items-center gap-3 rounded-full border border-slate-200 bg-white py-2 pl-4 pr-2 text-sm shadow-lg">
        <span className="text-navy">A new version is ready.</span>
        <button className="btn-primary !min-h-[36px] !rounded-full !px-4" onClick={() => window.location.reload()}>Update now</button>
      </div>
    </div>
  );
}
