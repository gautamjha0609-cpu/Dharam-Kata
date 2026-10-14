"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui";
import { InstallApp } from "@/components/install-app";
import { ValuationBrandCompact, ValuationDesktopBrand } from "@/components/valuation-brand";


export default function LoginPage() {
  const router = useRouter();
  const [loginId, setLoginId] = useState("");
  // the last login ID is remembered on this device (never the password: the browser password manager does that)
  useEffect(() => { try { const v = localStorage.getItem("dk.loginId"); if (v) setLoginId(v); } catch { /* ignore */ } }, []);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const pw = password;
    setPassword(""); // the password does not stay in the page's memory a moment longer than needed
    try {
      // the server signs in; this browser never calls the auth service itself, so nothing about the password shows in its console or network list
      const res = await fetch("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login_id: loginId.trim(), password: pw }), cache: "no-store" });
      const j = (await res.json().catch(() => null)) as { data?: { signed_in?: boolean; message?: string } | null; error?: { message?: string } | null } | null;
      if (!res.ok || !j?.data?.signed_in) {
        setError(j?.error?.message ?? j?.data?.message ?? "Login ID or password is incorrect.");
        setBusy(false);
        return;
      }
    } catch {
      setError("Cannot reach the server. Check your connection and try again.");
      setBusy(false);
      return;
    }
    try { localStorage.setItem("dk.loginId", loginId.trim()); } catch { /* ignore */ }
    router.replace("/");
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col justify-center px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))]">
      <div className="mb-3 flex justify-center">
        {/* the animation never taller than ~27% of the screen, so the whole page fits without scrolling */}
        <ValuationDesktopBrand width="100%" height="min(190px, 30dvh)" className="hidden md:block" />
        <ValuationBrandCompact size={52} className="md:hidden" />
      </div>
      <form onSubmit={submit} className="card space-y-3 !p-4" aria-label="Sign in">
        <div>
          <h1 className="text-lg font-bold text-navy">Sign in</h1>
          <p className="text-sm text-slate-600">Use the login ID given to you by your administrator.</p>
        </div>
        {error && <Alert>{error}</Alert>}
        <div>
          <label className="label" htmlFor="loginId">Login ID</label>
          <input id="loginId" className="field" autoCapitalize="none" autoCorrect="off" autoComplete="username" required value={loginId} onChange={(e) => setLoginId(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input id="password" type="password" className="field" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button className="btn-primary w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="text-center text-xs text-slate-600">Forgot your password? Ask your administrator to reset it.</p>
      </form>
      <div className="mt-3 flex justify-center"><InstallApp /></div>
    </main>
  );
}
