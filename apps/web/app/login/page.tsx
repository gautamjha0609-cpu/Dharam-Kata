"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { loginIdToEmail } from "@/lib/login-id";
import { Alert } from "@/components/ui";
import { InstallApp } from "@/components/install-app";
import { ValuationBrandCompact, ValuationDesktopBrand } from "@/components/valuation-brand";

/** The database client is the biggest script; it is fetched when the person starts typing, not before the page is shown. */
const loadClient = () => import("@/lib/supabase");

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
    const { supabase } = await loadClient();
    const { error } = await supabase().auth.signInWithPassword({ email: loginIdToEmail(loginId), password });
    if (error) {
      // Same message for unknown user / wrong password: no account enumeration.
      setError(/rate|too many/i.test(error.message) ? "Too many attempts. Please wait a minute and try again." : "Login ID or password is incorrect.");
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
          <input id="loginId" onFocus={() => void loadClient()} className="field" autoCapitalize="none" autoCorrect="off" autoComplete="username" required value={loginId} onChange={(e) => setLoginId(e.target.value)} />
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
