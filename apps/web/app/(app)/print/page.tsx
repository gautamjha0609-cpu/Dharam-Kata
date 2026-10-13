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

interface Job { id: string; invoice_id: string; job_type: string; status: string; attempt_count: number; last_error_code: string | null; queued_at: string; reprint_reason: string | null }
interface Agent { id: string; label: string; status: string; app_version: string | null; last_heartbeat_at: string | null }

export default function PrintCentre() {
  const { org } = useApp();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [status, setStatus] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!org) return;
    const sb = supabase();
    let q = sb.from("print_jobs").select("id,invoice_id,job_type,status,attempt_count,last_error_code,queued_at,reprint_reason").eq("organization_id", org.organization_id).order("queued_at", { ascending: false }).limit(100);
    if (status) q = q.eq("status", status as never);
    const [j, a] = await Promise.all([q, sb.from("print_agents").select("id,label,status,app_version,last_heartbeat_at").eq("organization_id", org.organization_id)]);
    if (j.error) setErr(friendlyError(j.error));
    setJobs((j.data ?? []) as Job[]); setAgents((a.data ?? []) as Agent[]);
  }, [org, status]);
  useEffect(() => { void load(); }, [load]);
  useLive(load, ["print_jobs"], { staleMs: 30_000 });
  // printer PCs report in about every minute (no realtime for that): refresh their status once a minute, and only while this tab is in front
  useEffect(() => { const t = setInterval(() => { if (!document.hidden) void load(); }, 60_000); return () => clearInterval(t); }, [load]);

  const online = (a: Agent) => a.status === "active" && a.last_heartbeat_at && Date.now() - new Date(a.last_heartbeat_at).getTime() < 90_000;

  return (
    <div>
      <PageHead title="Print centre" sub="Print jobs and printer PCs for your sites." />
      {err && <Alert>{err}</Alert>}
      <div className="mb-4 grid gap-2 sm:grid-cols-2">
        {agents.map((a) => (
          <div key={a.id} className="card flex items-center justify-between text-sm">
            <div><p className="font-semibold text-navy">{a.label}</p><p className="text-slate-600">v{a.app_version ?? "?"} · last seen {a.last_heartbeat_at ? fmtDateTime(a.last_heartbeat_at) : "never"}</p></div>
            {a.status === "revoked" ? <span className="badge bg-slate-100 text-slate-600">– Revoked</span> : online(a) ? <span className="badge bg-green-100 text-green-800">● Online</span> : <span className="badge bg-amber-100 text-amber-900">○ Offline</span>}
          </div>
        ))}
        {agents.length === 0 && <Empty title="No printer PC enrolled" hint="An admin can add one in Settings → Printing." />}
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
              <PrintBadge status={j.status} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
