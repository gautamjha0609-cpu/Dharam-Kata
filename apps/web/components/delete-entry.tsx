"use client";
import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { friendlyError } from "@/lib/errors";
import { Alert, Modal } from "@/components/ui";

const QUICK = ["Wrong vehicle number", "Wrong weight", "Duplicate entry", "Test entry"];

/** "Delete" a wrong entry: the invoice is marked deleted (its number is never reused), payments are reversed and the vehicle is no longer open. */
export function DeleteEntryButton({ invoiceId, label, onDone, className = "btn-danger" }: { invoiceId: string; label: string; onDone: () => void; className?: string }) {
  const { org, can } = useApp();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!can("entry.delete") && !can("invoice.cancel")) return null;

  async function del() {
    if (!org) return;
    setBusy(true); setErr(null);
    const { error } = await supabase().rpc("delete_entry", { p_org: org.organization_id, p_invoice: invoiceId, p_reason: reason.trim() });
    setBusy(false);
    if (error) return setErr(friendlyError(error));
    setOpen(false); setReason(""); onDone();
  }

  return (
    <>
      <button type="button" className={className} onClick={() => { setErr(null); setOpen(true); }}>Delete entry</button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Delete ${label}?`}>
        <div className="space-y-3">
          <p className="text-sm text-slate-600">The entry is removed from open entries, dues and totals, and any payment on it is reversed. It stays in history marked <b>Deleted</b>, and its invoice number is never used again.</p>
          {err && <Alert>{err}</Alert>}
          <label className="label" htmlFor={`del-${invoiceId}`}>Why? <span className="text-red-600">*</span></label>
          <div className="flex flex-wrap gap-2">
            {QUICK.map((q) => <button key={q} type="button" className={`badge min-h-[32px] cursor-pointer border ${reason === q ? "border-brand bg-brand-50 text-brand-dark" : "border-slate-300 bg-white text-slate-700"}`} onClick={() => setReason(q)}>{q}</button>)}
          </div>
          <input id={`del-${invoiceId}`} className="field" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Or type the reason" />
          <button type="button" className="btn-danger w-full" disabled={busy || !reason.trim()} onClick={del}>{busy ? "Deleting…" : "Delete this entry"}</button>
        </div>
      </Modal>
    </>
  );
}
