"use client";
import { Select } from "@/components/ios";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { friendlyError } from "@/lib/errors";
import { Alert, Empty, Modal, PageHead } from "@/components/ui";
import { useParties } from "@/components/party-picker";
import type { Party } from "@/lib/types";

const blank = { name: "", type: "debtor", gstin: "", pan: "", phone: "", city: "", address: "" };

export default function PartiesPage() {
  const { org, can } = useApp();
  const { parties, reload } = useParties();
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<Party | "new" | null>(null);
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (edit && edit !== "new") setF({ ...blank, name: edit.display_name, type: edit.party_type, gstin: edit.gstin ?? "", phone: edit.phone ?? "", city: edit.city ?? "" });
    else setF(blank);
    setError(null);
  }, [edit]);

  const shown = useMemo(() => parties.filter((p) => !q || p.display_name.toLowerCase().includes(q.toLowerCase())), [parties, q]);
  const manage = can("party.manage");

  async function save() {
    if (!org) return;
    setBusy(true); setError(null);
    const n = (s: string) => (s.trim() ? s.trim() : (null as unknown as string));
    const { error } = await supabase().rpc("upsert_party", {
      p_org: org.organization_id, p_id: (edit && edit !== "new" ? edit.id : null) as unknown as string, p_name: f.name,
      p_type: f.type as "debtor", p_gstin: n(f.gstin), p_pan: n(f.pan), p_address: n(f.address), p_city: n(f.city), p_phone: n(f.phone),
    });
    setBusy(false);
    if (error) return setError(/violates check constraint/.test(error.message) ? "GSTIN or PAN format is not valid." : friendlyError(error));
    setEdit(null); reload();
  }

  return (
    <div>
      <PageHead title="Debtors & vendors" sub="Party master. Edits affect future invoices only; issued invoices keep their snapshot."
        actions={manage ? <button className="btn-primary" onClick={() => setEdit("new")}>＋ Add party</button> : undefined} />
      <input className="field mb-3" type="search" placeholder="Search parties…" aria-label="Search parties" value={q} onChange={(e) => setQ(e.target.value)} />
      {shown.length === 0 ? <Empty title="No parties yet" /> : (
        <ul className="space-y-2">
          {shown.map((p) => (
            <li key={p.id} className="card flex items-center justify-between gap-2">
              <div><p className="font-semibold text-navy">{p.display_name}</p><p className="text-sm text-slate-600">{[p.party_type, p.city, p.phone, p.gstin].filter(Boolean).join(" · ")}</p></div>
              {manage && <button className="btn-ghost !min-h-[36px]" onClick={() => setEdit(p)}>Edit</button>}
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit === "new" ? "Add party" : "Edit party"}>
        <div className="space-y-3">
          {error && <Alert>{error}</Alert>}
          <div><label className="label" htmlFor="pn">Name <span className="text-red-600">*</span></label><input id="pn" className="field" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div><label className="label" htmlFor="pt">Type</label><Select id="pt" className="field" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="debtor">Debtor</option><option value="vendor">Vendor</option><option value="both">Both</option><option value="customer">Customer</option></Select></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className="label" htmlFor="pg">GSTIN (optional)</label><input id="pg" className="field uppercase" value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value })} /></div>
            <div><label className="label" htmlFor="pp">PAN (optional)</label><input id="pp" className="field uppercase" value={f.pan} onChange={(e) => setF({ ...f, pan: e.target.value })} /></div>
            <div><label className="label" htmlFor="ph">Mobile</label><input id="ph" className="field" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
            <div><label className="label" htmlFor="pc">City</label><input id="pc" className="field" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></div>
          </div>
          <button className="btn-primary w-full" disabled={busy || !f.name.trim()} onClick={save}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </Modal>
    </div>
  );
}
