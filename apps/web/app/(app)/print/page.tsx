"use client";
import { Select } from "@/components/ios";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { friendlyError } from "@/lib/errors";
import { fmtDateTime } from "@/lib/format";
import { Alert, Empty, PageHead, PrintBadge, PRINT_ERRORS } from "@/components/ui";
import { useLive } from "@/lib/use-live";
import { WAIT_ALERT_MS, retryPrint } from "@/components/print-status";
import { isPcOnline, usePcCheck } from "@/lib/pc-check";

interface Job { id: string; invoice_id: string; job_type: string; status: string; attempt_count: number; last_error_code: string | null; queued_at: string; reprint_reason: string | null }
interface Agent { id: string; label: string; status: string; app_version: string | null; last_heartbeat_at: string | null }
interface Printer { id: string; agent_id: string; label: string; os_printer_name: string; active: boolean }
interface Destination { printer_id: string; is_default: boolean; active: boolean }

export default function PrintCentre() {
  const { org } = useApp();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [dests, setDests] = useState<Destination[]>([]);
  const [status, setStatus] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!org) return;
    const sb = supabase();
    let q = sb.from("print_jobs").select("id,invoice_id,job_type,status,attempt_count,last_error_code,queued_at,reprint_reason").eq("organization_id", org.organization_id).order("queued_at", { ascending: false }).limit(100);
    if (status) q = q.eq("status", status as never);
    const [j, a, p, d] = await Promise.all([
      q,
      sb.from("print_agents").select("id,label,status,app_version,last_heartbeat_at").eq("organization_id", org.organization_id).eq("status", "active"),
      sb.from("printer_devices").select("id,agent_id,label,os_printer_name,active").eq("organization_id", org.organization_id).eq("active", true),
      sb.from("print_destinations").select("printer_id,is_default,active").eq("organization_id", org.organization_id).eq("active", true),
    ]);
    if (j.error) setErr(friendlyError(j.error));
    setJobs((j.data ?? []) as Job[]);
    setAgents((a.data ?? []) as Agent[]);
    setPrinters((p.data ?? []) as Printer[]);
    setDests((d.data ?? []) as Destination[]);
  }, [org, status]);
  useEffect(() => { void load(); }, [load]);
  useLive(load, ["print_jobs"], { staleMs: 30_000 });
  // printer PCs are asked whether they are there when this page opens (they send no timed heartbeat)
  const { askedAt } = usePcCheck(org?.organization_id, null, () => void load());

  const [busy, setBusy] = useState<string | null>(null);
  async function again(j: Job) {
    if (!org) return;
    setBusy(j.id); setErr(null);
    const e = await retryPrint(org.organization_id, j.id);
    setBusy(null); if (e) setErr(e);
    void load();
  }
  const canRetry = (j: Job) => !!j.invoice_id && (["failed", "routing_error", "not_configured"].includes(j.status) || (j.status === "queued" && Date.now() - new Date(j.queued_at).getTime() > WAIT_ALERT_MS));

  const online = (a: Agent) => a.status === "active" && isPcOnline(a.last_heartbeat_at, askedAt);

  return (
    <div>
      <PageHead title="Print centre" sub="Print jobs and printer PCs for your sites." />
      {err && <Alert>{err}</Alert>}
      <div className="mb-4 grid gap-2 sm:grid-cols-2">
        {agents.map((a) => {
          const paired = printers.find((p) => p.agent_id === a.id);
          const isDef = paired && dests.some((d) => d.printer_id === paired.id && d.is_default);
          return (
            <div key={a.id} className="card flex items-center justify-between text-sm">
              <div>
                <p className="font-semibold text-navy">{a.label}</p>
                <p className="text-xs text-slate-600">v{a.app_version ?? "?"} · last seen {a.last_heartbeat_at ? fmtDateTime(a.last_heartbeat_at) : "never"}</p>
                <p className="mt-1 text-xs">
                  {paired ? (
                    <span className="font-medium text-slate-800">
                      🖨 {paired.label} {isDef ? <span className="font-semibold text-green-700">(Default)</span> : null}
                    </span>
                  ) : (
                    <span className="font-medium text-amber-700">⚠ No printer paired</span>
                  )}
                </p>
              </div>
              <div>
                {online(a) ? <span className="badge bg-green-100 text-green-800">● Online</span> : <span className="badge bg-amber-100 text-amber-900">○ Offline</span>}
              </div>
            </div>
          );
        })}
        {agents.length === 0 && <Empty title="No printer PC active" hint="An admin can pair one in Settings → Printing." />}
      </div>
      <Select className="field mb-3 sm:max-w-xs" aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="">All statuses</option>
        {["not_configured", "routing_error", "queued", "claimed", "submitted_to_spooler", "failed", "unknown", "cancelled"].map((s) => <option key={s} value={s}>{s.replaceAll("_", " ")}</option>)}
      </Select>
      {jobs.length === 0 ? <Empty title="No print jobs" /> : (
        <ul className="space-y-2">
          {jobs.map((j) => (
            <li key={j.id} className="card flex flex-wrap items-center justify-between gap-2 text-sm">
              <div>
                {j.invoice_id ? <Link className="font-semibold text-navy underline" href={`/invoices/${j.invoice_id}`}>Invoice</Link> : <span className="font-semibold text-navy">Test print</span>}
                <span className="text-slate-600"> · {j.job_type} · {fmtDateTime(j.queued_at)} · attempt {j.attempt_count}</span>
                {j.last_error_code && <span className="block text-xs text-red-700">{PRINT_ERRORS[j.last_error_code] ?? j.last_error_code}</span>}
                {j.reprint_reason && <span className="text-slate-600"> · “{j.reprint_reason}”</span>}
              </div>
              <span className="flex flex-wrap items-center gap-2"><PrintBadge status={j.status} />
                {canRetry(j) && <button type="button" className="btn-primary !min-h-[36px]" disabled={busy === j.id} onClick={() => void again(j)}>{busy === j.id ? "Sending…" : "Print again"}</button>}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
