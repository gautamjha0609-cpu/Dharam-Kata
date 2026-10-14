"use client";
import { useEffect, useState } from "react";
import { checkGstin, checkMobile, checkPan } from "@dk/domain";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { friendlyError } from "@/lib/errors";
import { clearCache } from "@/lib/swr-cache";
import { Select } from "@/components/ios";
import { Alert, Modal } from "@/components/ui";
import type { Party } from "@/lib/types";

export interface DebtorFields { name: string; type: string; gstin: string; pan: string; phone: string; address: string }
const empty = (name = ""): DebtorFields => ({ name, type: "debtor", gstin: "", pan: "", phone: "", address: "" });

/** Problems with the typed values, per field. Empty optional fields are fine; filled ones must be in the correct Indian format. */
export function debtorProblems(f: DebtorFields): Partial<Record<keyof DebtorFields, string>> {
  const p: Partial<Record<keyof DebtorFields, string>> = {};
  if (!f.name.trim()) p.name = "Enter the name.";
  if (f.gstin.trim()) { const r = checkGstin(f.gstin); if (!r.ok) p.gstin = r.message; }
  if (f.pan.trim()) { const r = checkPan(f.pan); if (!r.ok) p.pan = r.message; }
  if (f.gstin.trim() && f.pan.trim() && !p.gstin && !p.pan) {
    const g = checkGstin(f.gstin), n = checkPan(f.pan);
    if (g.ok && n.ok && g.value.slice(2, 12) !== n.value) p.pan = "This PAN does not match the GSTIN (a GSTIN contains the PAN).";
  }
  if (f.phone.trim()) { const r = checkMobile(f.phone); if (!r.ok) p.phone = r.message; }
  if (f.address.length > 300) p.address = "Address can be at most 300 characters.";
  return p;
}

const msg = (m?: string) => (m ? <p role="alert" className="mt-1 text-xs font-medium text-red-700">{m}</p> : null);

/**
 * Add or edit a debtor / vendor. One form for the Debtors page and for the Weighment page (an operator adds a new debtor without leaving the entry).
 * Names are unique within the firm, GSTIN / PAN / mobile are checked for the correct Indian format before anything is sent.
 */
export function DebtorDialog({ open, onClose, initial, presetName, onSaved }: {
  open: boolean; onClose: () => void; initial?: Party | null; presetName?: string; onSaved: (p: Party) => void;
}) {
  const { org } = useApp();
  const [f, setF] = useState<DebtorFields>(empty());
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTouched(false); setError(null);
    setF(initial
      ? { name: initial.display_name, type: initial.party_type, gstin: initial.gstin ?? "", pan: (initial as { pan?: string | null }).pan ?? "", phone: initial.phone ?? "", address: (initial as { address?: string | null }).address ?? "" }
      : empty(presetName));
  }, [open, initial, presetName]);

  const problems = debtorProblems(f);
  const bad = Object.keys(problems).length > 0;
  const set = (k: keyof DebtorFields, v: string) => setF((x) => ({ ...x, [k]: v }));

  async function save() {
    setTouched(true);
    if (bad || !org) return;
    setBusy(true); setError(null);
    const g = f.gstin.trim() ? checkGstin(f.gstin) : null, n = f.pan.trim() ? checkPan(f.pan) : g?.ok ? { ok: true as const, value: g.value.slice(2, 12) } : null, m = f.phone.trim() ? checkMobile(f.phone) : null;
    const opt = (r: { ok: boolean; value?: string } | null, raw: string) => (r && r.ok ? r.value! : raw.trim() || null) as unknown as string;
    const { data, error } = await supabase().rpc("upsert_party", {
      p_org: org.organization_id, p_id: (initial?.id ?? null) as unknown as string, p_name: f.name.replace(/\s+/g, " ").trim(),
      p_type: f.type as "debtor", p_gstin: opt(g, f.gstin), p_pan: opt(n, f.pan), p_address: (f.address.trim() || null) as unknown as string, p_phone: opt(m, f.phone),
    });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    clearCache("debtors:"); clearCache("parties:");
    onSaved(data as unknown as Party);
  }

  const show = (k: keyof DebtorFields) => (touched || f[k] !== "" ? msg(problems[k]) : null);
  return (
    <Modal open={open} onClose={onClose} title={initial ? "Edit debtor" : "New debtor"}>
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <div><label className="label" htmlFor="dn">Name <span className="text-red-600">*</span></label>
          <input id="dn" className={`field ${touched && problems.name ? "!border-red-500" : ""}`} maxLength={200} autoFocus value={f.name} onChange={(e) => set("name", e.target.value)} />{touched ? msg(problems.name) : null}</div>
        <div><label className="label" htmlFor="dt">Type</label>
          <Select id="dt" className="field" value={f.type} onChange={(e) => set("type", e.target.value)}><option value="debtor">Debtor</option><option value="vendor">Vendor</option><option value="both">Both</option><option value="customer">Customer</option></Select></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label" htmlFor="dg">GSTIN (optional)</label>
            <input id="dg" className={`field uppercase ${problems.gstin && (touched || f.gstin) ? "!border-red-500" : ""}`} maxLength={15} autoCapitalize="characters" placeholder="27ABCDE1234F1Z5" value={f.gstin}
              onChange={(e) => set("gstin", e.target.value.replace(/\s/g, "").toUpperCase())} />{show("gstin")}</div>
          <div><label className="label" htmlFor="dp">PAN (optional)</label>
            <input id="dp" className={`field uppercase ${problems.pan && (touched || f.pan) ? "!border-red-500" : ""}`} maxLength={10} autoCapitalize="characters" placeholder="ABCDE1234F" value={f.pan}
              onChange={(e) => set("pan", e.target.value.replace(/\s/g, "").toUpperCase())} />{show("pan")}</div>
          <div><label className="label" htmlFor="dm">Mobile (optional)</label>
            <input id="dm" className={`field ${problems.phone && (touched || f.phone) ? "!border-red-500" : ""}`} inputMode="tel" maxLength={14} placeholder="98765 43210" value={f.phone}
              onChange={(e) => set("phone", e.target.value.replace(/[^0-9+\s-]/g, ""))} />{show("phone")}</div>
        </div>
        <div><label className="label" htmlFor="da">Address (optional)</label>
          <textarea id="da" className="field !min-h-[84px] py-2" maxLength={300} rows={3} value={f.address} onChange={(e) => set("address", e.target.value)} />{show("address")}</div>
        <button className="btn-primary w-full" disabled={busy || (touched && bad)} onClick={() => void save()}>{busy ? "Saving…" : initial ? "Save changes" : "Create debtor"}</button>
      </div>
    </Modal>
  );
}
