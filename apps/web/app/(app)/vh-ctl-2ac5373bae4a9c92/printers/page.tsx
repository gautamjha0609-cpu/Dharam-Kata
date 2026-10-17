"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ADMIN_PATH } from "@/lib/admin-path";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { friendlyError } from "@/lib/errors";
import { fmtDateTime } from "@/lib/format";
import { Alert, PageHead } from "@/components/ui";

interface Pc { id: string; pc: string; site: string; version: string | null; last_seen: string | null; approval: string; printer: string | null }
interface Req { id: string; pc: string; site: string; printer: string | null; requested_at: string; firm_approved_at: string | null; platform_approved_at: string | null; old_pcs: string[] }
interface FirmRow { org_id: string; firm: string; slug: string; pairings: number; desktop_changes: number; printer_changes: number; last_pairing: string | null; pcs: Pc[]; requests: Req[] }

const online = (p: Pc) => !!p.last_seen && Date.now() - new Date(p.last_seen).getTime() < 90_000;

/** Platform admin: every firm's printer PCs, how often they paired / changed desktop / changed printer, and desktop-change approvals. */
export default function AdminPrintersPage() {
  const { me } = useApp();
  const [rows, setRows] = useState<FirmRow[] | null>(null);
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<"all" | "pending">("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ k: "ok" | "error"; t: string } | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase().rpc("admin_print_overview");
    if (error) { setMsg({ k: "error", t: friendlyError(error) }); setRows([]); return; }
    setRows((data ?? []) as FirmRow[]);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => {
    const v = q.trim().toLowerCase();
    return (rows ?? []).filter((r) => (only === "all" || r.requests.length > 0)
      && (!v || [r.firm, r.slug, r.org_id, ...r.pcs.map((p) => `${p.pc} ${p.printer ?? ""} ${p.site}`)].some((x) => x.toLowerCase().includes(v))));
  }, [rows, q, only]);
  const pendingTotal = (rows ?? []).reduce((n, r) => n + r.requests.length, 0);

  if (!me.is_platform_admin) return <Alert kind="warn">Platform administrators only.</Alert>;

  async function decide(firm: FirmRow, r: Req, approve: boolean) {
    if (!approve && !confirm(`Reject “${r.pc}” for ${firm.firm}? It will not print and must be paired again.`)) return;
    setBusy(r.id); setMsg(null);
    const { data, error } = await supabase().rpc("admin_decide_agent_request", { p_request: r.id, p_approve: approve });
    setBusy(null);
    if (error) setMsg({ k: "error", t: friendlyError(error) });
    else if (!approve) setMsg({ k: "ok", t: `Rejected “${r.pc}” for ${firm.firm}.` });
    else if ((data as { waiting_for?: string } | null)?.waiting_for === "firm") setMsg({ k: "ok", t: `Approved. “${r.pc}” switches over when a user of ${firm.firm} also approves it (Settings → Printing on their website).` });
    else setMsg({ k: "ok", t: `“${r.pc}” now prints for ${firm.firm} (${r.site}).${r.old_pcs.length ? ` ${r.old_pcs.join(", ")} removed.` : ""}` });
    void load();
  }

  return (
    <div className="space-y-4">
      <PageHead title="Printer PCs" sub="Every firm's paired PCs and printers. A new desktop for a site needs 2 approvals: a user of the firm and you." actions={<Link href={ADMIN_PATH} className="btn-ghost">← Firms</Link>} />
      {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
      <div className="card grid gap-2 sm:grid-cols-[1fr_auto]">
        <input className="field !min-h-[40px]" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search firm, short ID, firm ID, PC or printer" aria-label="Search" />
        <div className="flex gap-1" role="group" aria-label="Show">
          <button type="button" className={only === "all" ? "btn-navy !min-h-[40px]" : "btn-ghost !min-h-[40px]"} onClick={() => setOnly("all")}>All firms</button>
          <button type="button" className={only === "pending" ? "btn-navy !min-h-[40px]" : "btn-ghost !min-h-[40px]"} onClick={() => setOnly("pending")}>Waiting for approval{pendingTotal ? ` (${pendingTotal})` : ""}</button>
        </div>
      </div>
      {!rows && <div className="space-y-2" aria-busy="true" aria-label="Loading"><div className="skeleton h-24 w-full" /><div className="skeleton h-24 w-full" /></div>}
      {rows && shown.length === 0 && <p className="card text-sm text-slate-600">No firm matches.</p>}
      <ul className="space-y-3">
        {shown.map((f) => (
          <li key={f.org_id} className={`card space-y-3 ${f.requests.length ? "!border-amber-300" : ""}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="break-words font-semibold text-navy">{f.firm} <span className="text-sm font-normal text-slate-600">· {f.slug}</span></p>
                <p className="break-all text-xs text-slate-500">Firm ID {f.org_id}</p>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <Stat n={f.pairings} label="pairings" />
                <Stat n={f.desktop_changes} label="desktop changes" />
                <Stat n={f.printer_changes} label="printer changes" />
              </div>
            </div>
            {f.pcs.length === 0 ? <p className="text-sm text-slate-600">No printer PC paired.</p> : (
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
                {f.pcs.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span className="min-w-0 break-words"><b>{p.pc}</b> <span className="text-slate-600">· {p.site} · {p.printer ?? "no printer chosen"} · v{p.version ?? "?"}</span></span>
                    <span className="flex items-center gap-2">
                      {p.approval === "pending" && <span className="badge bg-amber-100 text-amber-900">waiting for approval</span>}
                      {online(p) ? <span className="badge bg-green-100 text-green-800">● Online</span> : <span className="badge bg-slate-100 text-slate-600">○ Offline{p.last_seen ? ` · ${fmtDateTime(p.last_seen)}` : ""}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {f.requests.map((r) => (
              <div key={r.id} className="rounded-lg border-2 border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                <p className="font-semibold">New desktop “{r.pc}” wants to print for {r.site}</p>
                <p className="mt-1">Printer: <b>{r.printer ?? "not chosen (older Print Agent)"}</b> · asked {fmtDateTime(r.requested_at)}{r.old_pcs.length ? <> · replaces <b>{r.old_pcs.join(", ")}</b></> : null}</p>
                <p className="mt-1 text-xs"><b>{r.firm_approved_at ? `✓ firm approved ${fmtDateTime(r.firm_approved_at)}` : "○ firm not yet approved"}</b> · <b>{r.platform_approved_at ? "✓ you approved" : "○ your approval"}</b></p>
                {!r.platform_approved_at && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" className="btn-primary !min-h-[40px]" disabled={busy === r.id} onClick={() => void decide(f, r, true)}>{busy === r.id ? "Working…" : "Approve"}</button>
                    <button type="button" className="btn-ghost !min-h-[40px]" disabled={busy === r.id} onClick={() => void decide(f, r, false)}>Reject</button>
                  </div>
                )}
              </div>
            ))}
            {f.last_pairing && <p className="text-xs text-slate-500">Last pairing {fmtDateTime(f.last_pairing)}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return <div className="rounded-lg bg-slate-50 px-2 py-1.5"><p className="text-lg font-bold text-navy">{n}</p><p className="text-slate-600">{label}</p></div>;
}
