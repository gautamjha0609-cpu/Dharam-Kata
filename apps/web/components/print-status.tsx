"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { friendlyError } from "@/lib/errors";
import { fmtDateTime } from "@/lib/format";
import { useLive } from "@/lib/use-live";
import { isPdfPrinter, isVirtualPrinter } from "@dk/print-template";
import { Alert, Modal, PRINT_ERRORS } from "@/components/ui";
import type { PrintJob } from "@/lib/types";

/** A slip waits this long on the printer PC before staff are offered "Print again". */
export const WAIT_ALERT_MS = 2 * 60_000;

export interface WaitingSlip { job_id: string; invoice_id: string; invoice_number: string; vehicle: string; status: string; error: string | null; queued_at: string }
export interface SitePrintStatus {
  printer: { id: string; label: string; os_name: string; active: boolean; pc: string; pc_active: boolean; last_seen: string | null; online: boolean } | null;
  waiting: WaitingSlip[];
}

/** Where slips of this site print now, and slips that did not reach a printer. Fresh on print-job changes and once a minute (PC heartbeat). */
export function useSitePrintStatus(siteId: string) {
  const { org, can } = useApp();
  const [status, setStatus] = useState<SitePrintStatus | null>(null);
  const load = useCallback(async () => {
    if (!org || !siteId || !can("print.view")) return;
    const { data, error } = await supabase().rpc("site_print_status", { p_org: org.organization_id, p_site: siteId });
    if (!error) setStatus(data as unknown as SitePrintStatus);
  }, [org, siteId, can]);
  useEffect(() => { setStatus(null); void load(); }, [load]);
  useLive(load, ["print_jobs"], { staleMs: 30_000 });
  useEffect(() => { const t = setInterval(() => { if (!document.hidden) void load(); }, 60_000); return () => clearInterval(t); }, [load]);
  return { status, reload: load };
}

/** "Prints on: Canon MF3010 · DESKTOP-N9G3G2B · ● Online" */
export function PrintTarget({ status }: { status: SitePrintStatus | null }) {
  const { can } = useApp();
  if (!status) return null;
  const p = status.printer;
  const fix = can("print.route.manage") ? <Link href="/settings" className="underline">Settings → Printing</Link> : "your owner or administrator";
  if (!p) return <Alert kind="warn">No printer is set up for this site, so slips will not print. Set one up in {fix}.</Alert>;
  if (!p.pc_active || !p.active) return <Alert kind="error">The printer PC “{p.pc}” was removed, so slips will not print. Choose a printer in {fix}.</Alert>;
  const fake = isVirtualPrinter(p.os_name);
  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2 text-sm ${fake ? "border-red-200 bg-red-50 text-red-800" : "border-slate-200 bg-white"}`} role="status">
      <span className="text-slate-600">Prints on:</span>
      <b className="text-navy">{p.label}</b><span className="text-slate-600">· {p.pc}</span>
      {p.online
        ? <span className="badge bg-green-100 text-green-800">● Online</span>
        : <span className="badge bg-amber-100 text-amber-900">○ Offline{p.last_seen ? ` since ${fmtDateTime(p.last_seen)}` : ""}</span>}
      {fake && <span className="w-full text-xs font-medium">✕ This is not a physical printer. No paper comes out. Choose a physical printer in {fix}.</span>}
      {!p.online && !fake && <span className="w-full text-xs text-amber-900">Slips wait until the Print Agent on {p.pc} is running and online.</span>}
    </div>
  );
}

/** One-click "Print again" for a slip that did not reach a printer. Returns an error message, or null when queued again. */
export async function retryPrint(orgId: string, jobId: string): Promise<string | null> {
  const { error } = await supabase().rpc("retry_print_job", { p_org: orgId, p_job: jobId });
  return error ? friendlyError(error) : null;
}

function waitingText(s: WaitingSlip) {
  if (s.status === "queued") return "waiting, not printed yet";
  if (s.status === "not_configured") return "no printer set up";
  if (s.status === "routing_error") return "printer PC removed or switched off";
  return s.error ? (PRINT_ERRORS[s.error] ?? s.error) : "failed";
}

/** Alert listing slips of this site that did not print, each with "Print again". */
export function WaitingSlips({ status, reload }: { status: SitePrintStatus | null; reload: () => void }) {
  const { org } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const list = status?.waiting ?? [];
  if (list.length === 0) return err ? <Alert>{err}</Alert> : null;
  async function again(s: WaitingSlip) {
    if (!org) return;
    setBusy(s.job_id); setErr(null);
    const e = await retryPrint(org.organization_id, s.job_id);
    setBusy(null); if (e) setErr(e);
    reload();
  }
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" role="alert">
      <p className="font-semibold">⚠ {list.length === 1 ? "1 slip has" : `${list.length} slips have`} not printed</p>
      {err && <p className="mt-1 text-red-700">{err}</p>}
      <ul className="mt-2 divide-y divide-amber-200">
        {list.map((s) => (
          <li key={s.job_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="min-w-0"><Link href={`/invoices/${s.invoice_id}`} className="font-semibold underline">{s.invoice_number}</Link> · {s.vehicle} · {fmtDateTime(s.queued_at)}<span className="block text-xs">{waitingText(s)}</span></span>
            <button type="button" className="btn-primary !min-h-[40px]" disabled={busy === s.job_id} onClick={() => void again(s)}>{busy === s.job_id ? "Sending…" : "Print again"}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Follows the slip that was just saved: a "Print successful" popup when it reaches the printer, and a
 * "Print again" button when it is still not printed after 2 minutes (or failed).
 */
export function PrintFollow({ job, printer, onJob }: { job: PrintJob | null; printer: string | null; onJob: (j: PrintJob) => void }) {
  const { org } = useApp();
  const [okOpen, setOkOpen] = useState(false);
  const [late, setLate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const id = job?.id, st = job?.status;
  const final = !!st && ["submitted_to_spooler", "failed", "not_configured", "routing_error", "unknown", "cancelled"].includes(st);

  useEffect(() => { setLate(false); setErr(null); }, [id]);
  // poll this one job until it is finished (3 s, at most ~3 min); the screen also gets realtime updates elsewhere
  useEffect(() => {
    if (!id || final) return;
    let n = 0;
    const t = setInterval(async () => {
      n += 1;
      const { data } = await supabase().from("print_jobs").select("*").eq("id", id).maybeSingle();
      if (data) onJob(data as PrintJob);
      if (n >= 60) clearInterval(t);
    }, 3000);
    return () => clearInterval(t);
  }, [id, final, onJob]);
  useEffect(() => {
    if (!job || final) return;
    const left = WAIT_ALERT_MS - (Date.now() - new Date(job.queued_at).getTime());
    const t = setTimeout(() => setLate(true), Math.max(0, left));
    return () => clearTimeout(t);
  }, [job, final]);
  useEffect(() => { if (st === "submitted_to_spooler") setOkOpen(true); }, [id, st]);
  useEffect(() => { if (!okOpen) return; const t = setTimeout(() => setOkOpen(false), 6000); return () => clearTimeout(t); }, [okOpen]);

  if (!job) return null;
  const retryable = (st === "queued" && late) || st === "failed" || st === "not_configured" || st === "routing_error";
  async function again() {
    if (!org || !job) return;
    setBusy(true); setErr(null);
    const e = await retryPrint(org.organization_id, job.id);
    setBusy(false);
    if (e) return setErr(e);
    const { data } = await supabase().from("print_jobs").select("*").eq("invoice_id", job.invoice_id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (data) onJob(data as PrintJob);
  }
  return (
    <>
      {retryable && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950" role="alert">
          <span>{st === "queued" ? "⚠ This slip has not printed after 2 minutes." : `⚠ This slip did not print${job.last_error_code ? `: ${PRINT_ERRORS[job.last_error_code] ?? job.last_error_code}` : "."}`}</span>
          <button type="button" className="btn-primary !min-h-[40px]" disabled={busy} onClick={() => void again()}>{busy ? "Sending…" : "Print again"}</button>
          {err && <span className="w-full text-red-700">{err}</span>}
        </div>
      )}
      {st === "unknown" && <Alert kind="warn">It is not known whether this slip printed. Check the paper before printing it again.</Alert>}
      <Modal open={okOpen} onClose={() => setOkOpen(false)} title="Print successful">
        <div className="space-y-3 text-center">
          <p className="text-5xl text-green-600" aria-hidden>✓</p>
          <p className="text-sm">The slip was sent to <b>{printer ?? "the printer"}</b>. Collect it from the printer.</p>
          <p className="text-xs text-slate-600">If no paper came out, check that the printer is on and has paper, then reprint it from the invoice page (owner or administrator).</p>
          <button type="button" className="btn-primary w-full" onClick={() => setOkOpen(false)}>OK</button>
        </div>
      </Modal>
    </>
  );
}
