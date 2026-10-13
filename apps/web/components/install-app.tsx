"use client";
import { useEffect, useState } from "react";
import { Modal } from "@/components/ui";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * "Install app" button. Chrome / Edge / Android / Samsung browsers install with one tap (their own install prompt);
 * Safari (iPhone, iPad, Mac) and Firefox have no install prompt, so the button shows the exact steps for that browser.
 * Hidden once the app is already installed (opened as an app).
 */
export function InstallApp({ className = "" }: { className?: string }) {
  const [ready, setReady] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [evt, setEvt] = useState<InstallPromptEvent | null>(null);
  const [help, setHelp] = useState(false);
  const [ua, setUa] = useState("");

  useEffect(() => {
    const standalone = ["standalone", "minimal-ui", "window-controls-overlay"].some((m) => window.matchMedia(`(display-mode: ${m})`).matches)
      || (navigator as { standalone?: boolean }).standalone === true;
    const KEY = "dk.installed";
    const remembered = (() => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } })();
    if (standalone) { try { localStorage.setItem(KEY, "1"); } catch { /* ignore */ } }
    setInstalled(standalone || remembered);
    setUa(navigator.userAgent);
    setReady(true);
    // the browser only offers its install prompt when the app is NOT installed: so if it fires, the app was removed and the button returns
    const onPrompt = (e: Event) => { e.preventDefault(); setEvt(e as InstallPromptEvent); setInstalled(false); try { localStorage.removeItem(KEY); } catch { /* ignore */ } };
    const onInstalled = () => { setInstalled(true); setEvt(null); try { localStorage.setItem(KEY, "1"); } catch { /* ignore */ } };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => { window.removeEventListener("beforeinstallprompt", onPrompt); window.removeEventListener("appinstalled", onInstalled); };
  }, []);

  if (!ready || installed) return null;
  const ios = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && typeof document !== "undefined" && "ontouchend" in document);
  const safariMac = /Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua) && !ios;
  const firefox = /Firefox|FxiOS/.test(ua);

  async function click() {
    if (!evt) return setHelp(true);
    await evt.prompt();
    const c = await evt.userChoice;
    if (c.outcome === "accepted") { setInstalled(true); try { localStorage.setItem("dk.installed", "1"); } catch { /* ignore */ } }
    setEvt(null);
  }

  const steps: [string, string][] = [
    ["iPhone / iPad (Safari)", "Tap the Share button, then “Add to Home Screen”, then “Add”."],
    ["Android (Chrome, Samsung Internet, Edge)", "Open the browser menu (⋮) and tap “Install app” or “Add to Home screen”."],
    ["Windows / Linux / ChromeOS (Chrome, Edge)", "Click the install icon at the right end of the address bar, or open the browser menu and choose “Install Dharam Kata”."],
    ["Mac (Safari 17+)", "File menu → “Add to Dock”."],
    ["Firefox", "Firefox on Android: menu (⋮) → “Install”. Firefox on a computer cannot install web apps; use Chrome or Edge to install, or just bookmark this page."],
  ];
  const mine = ios ? 0 : safariMac ? 3 : firefox ? 4 : /Android/i.test(ua) ? 1 : 2;

  return (
    <>
      <button type="button" className={`btn-ghost !min-h-[36px] ${className}`} onClick={() => void click()}>
        <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M3 13h10" /></svg>
        Install app
      </button>
      <Modal open={help} onClose={() => setHelp(false)} title="Install Dharam Kata">
        <p className="mb-3 text-sm text-slate-600">Install it like any app: its own icon, its own window, and it opens in one tap.</p>
        <ul className="space-y-2">
          {steps.map(([title, text], i) => (
            <li key={title} className={`rounded-lg border p-3 text-sm ${i === mine ? "border-brand-dark bg-brand-50" : "border-slate-200"}`}>
              <p className="font-semibold text-navy">{title}{i === mine ? " — your browser" : ""}</p>
              <p className="text-slate-600">{text}</p>
            </li>
          ))}
        </ul>
      </Modal>
    </>
  );
}
