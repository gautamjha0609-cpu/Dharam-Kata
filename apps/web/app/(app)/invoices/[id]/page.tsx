"use client";
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { friendlyError } from "@/lib/errors";
import { fmtDateTime, inr, num } from "@/lib/format";
import { Alert, Modal, PageHead, PrintBadge, PRINT_ERRORS } from "@/components/ui";
import type { Invoice, PrintJob } from "@/lib/types";

interface Payment { id: string; kind: string; amount: string; method: string; reference: string | null; reason: string | null; occurred_at: string }

export default function InvoiceDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { org, can } = useApp();
  const [inv, setInv] = useState<Invoice | null>(null);
  const [jobs, setJobs] = useState<PrintJob[]>([]);
  const [pays, setPays] = useState<Payment[]>([]);
  const [bal, setBal] = useState<{ amount_paid: string; outstanding: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dlg, setDlg] = useState<"cancel" | "reprint" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    if (!org) return;
    const sb = supabase();
    const [a, b, c, d] = await Promise.all([
      sb.from("invoices").select("*").eq("id", id).eq("organization_id", org.organization_id).maybeSingle(),
      sb.from("print_jobs").select("*").eq("invoice_id", id).order("created_at", { ascending: false }),
      sb.from("invoice_payments").select("*").eq("invoice_id", id).order("recorded_at"),
      sb.from("invoice_balances").select("amount_paid,outstanding").eq("invoice_id", id).maybeSingle(),
    ]);
    if (!a.data) return setMissing(true);
    setInv(a.data as Invoice); setJobs((b.data ?? []) as PrintJob[]); setPays((c.data ?? []) as Payment[]); setBal(d.data as never);
  }, [org, id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!org) return;
    const sb = supabase();
    const ch = sb.channel(`inv-${id}`).on("postgres_changes", { event: "*", schema: "public", table: "print_jobs", filter: `invoice_id=eq.${id}` }, () => void load()).subscribe();
    return () => { void sb.removeChannel(ch); };
  }, [org, id, load]);

  async function act() {
    if (!org || !inv) return;
    setBusy(true); setErr(null);
    const { error } = dlg === "cancel"
      ? await supabase().rpc("cancel_invoice", { p_org: org.organization_id, p_invoice: inv.id, p_reason: reason })
      : await supabase().rpc("reprint_invoice", { p_org: org.organization_id, p_invoice: inv.id, p_reason: reason });
    setBusy(false);
    if (error) return setErr(friendlyError(error));
    setDlg(null); setReason(""); void load();
  }

  if (missing) return <Alert kind="warn">Invoice not found, or you do not have access to it.</Alert>;
  if (!inv) return <p className="text-slate-600">Loading…</p>;
  const cancelled = inv.status === "cancelled";
  const originals = jobs.filter((j) => j.job_type === "original").sort((a, b) => a.queued_at.localeCompare(b.queued_at));
  const slipName = (j: PrintJob) => j.job_type !== "original" ? "Reprint" : originals.length > 1 || inv.stage === "open" ? (originals[0]?.id === j.id ? "Opening slip" : "Closing slip") : "Original";

  return (
    <div className="mx-auto max-w-2xl">
      <PageHead title={`Invoice ${inv.invoice_number}`} sub={`${fmtDateTime(inv.issued_at)} · ${inv.stage === "open" ? "Open — waiting for the second weight" : "Closed"}`}
        actions={<Link href="/invoices" className="btn-ghost">← Back</Link>} />
      {cancelled && <div className="mb-3"><Alert>Cancelled: {inv.cancel_reason}. This number is retired and will not be reused.</Alert></div>}
      {err && <div className="mb-3"><Alert>{err}</Alert></div>}
      <div className="card space-y-3">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div><dt className="text-slate-600">Party</dt><dd className="font-semibold">{inv.party_name || "Walk-in"}</dd></div>
          <div><dt className="text-slate-600">Vehicle</dt><dd className="font-semibold">{inv.vehicle_display}</dd></div>
          <div><dt className="text-slate-600">Material</dt><dd>{inv.material || "—"}</dd></div>
          <div><dt className="text-slate-600">Payment</dt><dd>{inv.payment_mode === "cash" ? "Cash" : "Credit"}</dd></div>
          {inv.stage === "open" ? (
            <div><dt className="text-slate-600">First weight</dt><dd>{num(inv.gross_weight_kg)} kg · {fmtDateTime(inv.gross_weight_at)}</dd></div>
          ) : (
            <>
              <div><dt className="text-slate-600">Loaded</dt><dd>{num(inv.gross_weight_kg)} kg · {fmtDateTime(inv.gross_weight_at)}</dd></div>
              <div><dt className="text-slate-600">Empty</dt><dd>{num(inv.tare_weight_kg ?? 0)} kg · {fmtDateTime(inv.tare_weight_at)}</dd></div>
              <div><dt className="text-slate-600">Net weight</dt><dd className="font-bold text-navy">{num(inv.net_weight_kg ?? 0)} kg</dd></div>
            </>
          )}
        </dl>
        <div className="flex items-center justify-between rounded-lg bg-navy p-3 text-white">
          <span>Amount</span><span className="text-2xl font-bold">{inr(inv.fee_total)}</span>
        </div>
        {bal && <div className="grid grid-cols-2 gap-3 text-sm"><div><dt className="text-slate-600">Paid</dt><dd className="font-semibold">{inr(bal.amount_paid)}</dd></div><div><dt className="text-slate-600">Outstanding</dt><dd className="font-semibold">{inr(bal.outstanding)}</dd></div></div>}
      </div>

      <h2 className="mb-2 mt-5 font-bold text-navy">Print status</h2>
      <div className="card space-y-2">
        {jobs.length === 0 && <p className="text-sm text-slate-600">No print job.</p>}
        {jobs.map((j) => (
          <div key={j.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>{slipName(j)} · {fmtDateTime(j.queued_at)}{j.reprint_reason ? ` · “${j.reprint_reason}”` : ""}</span>
            <PrintBadge status={j.status} />
            {j.last_error_code && PRINT_ERRORS[j.last_error_code] && <p className="w-full text-xs text-red-700">{PRINT_ERRORS[j.last_error_code]}</p>}
          </div>
        ))}
        {jobs.some((j) => j.status === "unknown") && <Alert kind="warn">A print outcome is unknown. Check whether the paper came out before reprinting, so it is not printed twice.</Alert>}
        <p className="text-xs text-slate-600">“Sent to Windows print queue” means the printer PC accepted the job, not that paper definitely came out.</p>
        {!cancelled && can("print.reprint") && <button className="btn-ghost" onClick={() => setDlg("reprint")}>Reprint…</button>}
      </div>

      {pays.length > 0 && (
        <>
          <h2 className="mb-2 mt-5 font-bold text-navy">Payments</h2>
          <ul className="card divide-y divide-slate-100 text-sm">
            {pays.map((p) => <li key={p.id} className="flex justify-between py-2"><span>{fmtDateTime(p.occurred_at)} · {p.method}{p.reference ? ` · ${p.reference}` : ""}{p.reason ? ` · ${p.reason}` : ""}</span><b className={Number(p.amount) < 0 ? "text-red-700" : ""}>{inr(p.amount)}</b></li>)}
          </ul>
        </>
      )}

      {!cancelled && can("invoice.cancel") && <div className="mt-5"><button className="btn-danger" onClick={() => setDlg("cancel")}>Cancel invoice…</button></div>}

      <Modal open={!!dlg} onClose={() => setDlg(null)} title={dlg === "cancel" ? "Cancel invoice" : "Reprint invoice"}>
        <div className="space-y-3">
          <p className="text-sm text-slate-600">{dlg === "cancel" ? "The invoice is kept with its number and marked cancelled. Any payments are reversed." : "A reprint is a new print job for the same invoice. It never creates a new invoice number."}</p>
          <label className="label" htmlFor="reason">Reason <span className="text-red-600">*</span></label>
          <input id="reason" className="field" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className={dlg === "cancel" ? "btn-danger w-full" : "btn-primary w-full"} disabled={busy || !reason.trim()} onClick={act}>{busy ? "Working…" : dlg === "cancel" ? "Cancel this invoice" : "Send reprint"}</button>
        </div>
      </Modal>
    </div>
  );
}
