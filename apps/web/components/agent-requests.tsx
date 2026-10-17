"use client";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { friendlyError } from "@/lib/errors";
import { fmtDateTime } from "@/lib/format";
import { isVirtualPrinter } from "@dk/print-template";
import { Alert, Modal } from "@/components/ui";

interface AgentRequest {
  id: string; kind: "takeover" | "change_printer"; printer: string | null; requested_at: string;
  site_id: string; site: string; agent_id: string; pc: string; pc_last_seen: string | null; current_printer: string | null;
  old_pcs: { id: string; label: string; last_seen: string | null }[]; waiting: number;
  firm_approved_at?: string | null; platform_approved_at?: string | null;
}

/**
 * Approvals asked for by a Print Agent:
 *  - a new PC (desktop change) wants to print for a site that already has a PC: needs TWO approvals, any firm user of that site here
 *    AND the platform administrator; the old PC is removed when both have approved
 *  - a PC wants to change its printer (owner / administrator)
 */
export function AgentRequests({ onChange }: { onChange?: () => void }) {
  const { org } = useApp();
  const [list, setList] = useState<AgentRequest[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ k: "ok" | "error"; t: string } | null>(null);
  const [ask, setAsk] = useState<AgentRequest | null>(null); // takeover with slips waiting: print them on the new PC?

  const load = useCallback(async () => {
    if (!org) return;
    const { data, error } = await supabase().rpc("list_agent_requests", { p_org: org.organization_id });
    if (!error) setList((data ?? []) as AgentRequest[]);
  }, [org]);
  useEffect(() => { void load(); const t = setInterval(() => { if (!document.hidden) void load(); }, 20_000); return () => clearInterval(t); }, [load]);

  async function decide(r: AgentRequest, approve: boolean, moveWaiting = false) {
    if (!org) return;
    if (!approve && !confirm(r.kind === "takeover" ? `Reject “${r.pc}”? It will not print and must be paired again.` : `Keep the current printer of “${r.pc}”?`)) return;
    setBusy(r.id); setMsg(null); setAsk(null);
    const { data, error } = await supabase().rpc("decide_agent_request", { p_org: org.organization_id, p_request: r.id, p_approve: approve, p_move_waiting: moveWaiting });
    setBusy(null);
    if (error) setMsg({ k: "error", t: friendlyError(error) });
    else if (!approve) setMsg({ k: "ok", t: "Request rejected." });
    else if (r.kind === "takeover" && (data as { waiting_for?: string } | null)?.waiting_for === "platform") {
      setMsg({ k: "ok", t: `Your approval for “${r.pc}” is saved. It switches over as soon as the platform administrator (The Valuation House) also approves.` });
    } else if (r.kind === "takeover") {
      const moved = (data as { moved?: number } | null)?.moved ?? 0;
      setMsg({ k: "ok", t: `“${r.pc}” now prints for ${r.site}${r.printer ? ` on ${r.printer}` : ""}.${r.old_pcs.length ? ` ${r.old_pcs.map((o) => o.label).join(", ")} removed.` : ""}${moved ? ` ${moved} waiting slip${moved === 1 ? "" : "s"} moved to it.` : ""} Print the calibration sheet from the Print Agent.` });
    } else setMsg({ k: "ok", t: `“${r.pc}” now prints on ${r.printer}. Print the calibration sheet from the Print Agent and check X/Y.` });
    void load(); onChange?.();
  }
  function approve(r: AgentRequest) {
    if (r.kind === "takeover" && r.waiting > 0) return setAsk(r);
    void decide(r, true, false);
  }

  if (list.length === 0) return msg ? <Alert kind={msg.k}>{msg.t}</Alert> : null;
  return (
    <div className="space-y-2">
      {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
      {list.map((r) => (
        <div key={r.id} className="rounded-lg border-2 border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" role="alert">
          {r.kind === "takeover" ? (
            <>
              <p className="font-semibold">“{r.pc}” wants to print slips for {r.site}</p>
              <p className="mt-1">Printer: <b>{r.printer ?? "not chosen yet (older Print Agent)"}</b> · asked {fmtDateTime(r.requested_at)}</p>
              {r.old_pcs.length > 0 && <p className="mt-1">Approving removes {r.old_pcs.map((o) => <span key={o.id}><b>{o.label}</b> (last seen {o.last_seen ? fmtDateTime(o.last_seen) : "never"}) </span>)}— only one PC prints per site. It works even if that PC is switched off or lost.</p>}
              <p className="mt-1 text-xs">Needs 2 approvals: <b>{r.firm_approved_at ? "✓ firm" : "○ firm (any user)"}</b> · <b>{r.platform_approved_at ? "✓ platform admin" : "○ platform admin"}</b></p>
            </>
          ) : (
            <>
              <p className="font-semibold">“{r.pc}” ({r.site}) wants to change its printer</p>
              <p className="mt-1">From <b>{r.current_printer ?? "none"}</b> to <b>{r.printer}</b> · asked {fmtDateTime(r.requested_at)}</p>
            </>
          )}
          {r.printer && isVirtualPrinter(r.printer) && <p className="mt-1 font-medium text-red-700">✕ “{r.printer}” is not a real printer. No paper would come out.</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            {r.kind === "takeover" && r.firm_approved_at
              ? <span className="badge bg-sky-100 text-sky-900">Approved by your firm · waiting for the platform admin</span>
              : <button type="button" className="btn-primary !min-h-[40px]" disabled={busy === r.id} onClick={() => approve(r)}>{busy === r.id ? "Working…" : "Approve"}</button>}
            <button type="button" className="btn-ghost !min-h-[40px]" disabled={busy === r.id} onClick={() => void decide(r, false)}>Reject</button>
          </div>
        </div>
      ))}
      <Modal open={!!ask} onClose={() => setAsk(null)} title={`${ask?.waiting ?? 0} slip${ask?.waiting === 1 ? " is" : "s are"} waiting`}>
        {ask && (
          <div className="space-y-3 text-sm">
            <p>{ask.waiting === 1 ? "1 slip is" : `${ask.waiting} slips are`} waiting to print on {ask.old_pcs.map((o) => o.label).join(", ")}. Print {ask.waiting === 1 ? "it" : "them"} on the new PC “{ask.pc}”?</p>
            <p className="text-xs text-slate-600">Choose “No” if {ask.waiting === 1 ? "it" : "they"} may already be printed, so nothing is printed twice. You can still print a slip again later from the invoice.</p>
            <button type="button" className="btn-primary w-full" onClick={() => void decide(ask, true, true)}>Yes, print them on {ask.pc}</button>
            <button type="button" className="btn-ghost w-full" onClick={() => void decide(ask, true, false)}>No, cancel them</button>
          </div>
        )}
      </Modal>
    </div>
  );
}
