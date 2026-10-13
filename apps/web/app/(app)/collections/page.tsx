"use client";
import { Select } from "@/components/ios";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { friendlyError } from "@/lib/errors";
import { fmtDateTime, inr, newIdemKey } from "@/lib/format";
import { Alert, Empty, Modal, PageHead } from "@/components/ui";
import { useLive } from "@/lib/use-live";
import type { Invoice } from "@/lib/types";

interface Row extends Invoice { paid: number; outstanding: number }

export default function CollectionsPage() {
  const { org, can } = useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [pay, setPay] = useState<Row | null>(null);

  const load = useCallback(async () => {
    if (!org) return;
    const sb = supabase();
    const { data: inv, error } = await sb.from("invoices").select("*").eq("organization_id", org.organization_id)
      .eq("payment_mode", "credit").eq("status", "issued").order("issued_at", { ascending: false }).limit(500);
    if (error) setErr(friendlyError(error));
    const list = (inv ?? []) as Invoice[];
    type Bal = { invoice_id: string; amount_paid: string; outstanding: string };
    let bal: Bal[] = [];
    if (list.length) {
      const r = await sb.from("invoice_balances").select("invoice_id,amount_paid,outstanding").in("invoice_id", list.map((i) => i.id));
      bal = (r.data ?? []) as unknown as Bal[];
    }
    const m = new Map(bal.map((b) => [b.invoice_id, b]));
    setRows(list.map((i) => ({ ...i, paid: Number(m.get(i.id)?.amount_paid ?? 0), outstanding: Number(m.get(i.id)?.outstanding ?? 0) })));
    setLoading(false);
  }, [org]);
  useEffect(() => { void load(); }, [load]);
  useLive(load, ["invoices"]);

  const groups = useMemo(() => {
    const g = new Map<string, { name: string; rows: Row[]; billed: number; out: number }>();
    for (const r of rows) {
      const k = r.party_id ?? "-";
      const e = g.get(k) ?? { name: r.party_name ?? "Unknown", rows: [], billed: 0, out: 0 };
      e.rows.push(r); e.billed += Number(r.fee_total); e.out += r.outstanding; g.set(k, e);
    }
    return [...g.values()].sort((a, b) => b.out - a.out);
  }, [rows]);
  const totalOut = groups.reduce((s, g) => s + g.out, 0);

  return (
    <div>
      <PageHead title="Collections" sub="Credit invoices and what each debtor still owes." />
      <div className="card mb-4 flex items-center justify-between"><span className="text-slate-600">Total outstanding</span><span className="text-2xl font-bold text-navy">{inr(totalOut)}</span></div>
      {err && <Alert>{err}</Alert>}
      {!loading && groups.length === 0 ? <Empty title="No credit invoices yet" /> : (
        <div className="space-y-4">
          {groups.map((g) => (
            <section key={g.name} className="card">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-bold text-navy">{g.name}</h2>
                <span className="text-sm">Billed {inr(g.billed)} · <b className={g.out > 0 ? "text-amber-800" : "text-green-700"}>Outstanding {inr(g.out)}</b></span>
              </div>
              <ul className="mt-2 divide-y divide-slate-100 text-sm">
                {g.rows.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <Link href={`/invoices/${r.id}`} className="underline">{r.invoice_number}</Link>
                    <span className="text-slate-600">{fmtDateTime(r.issued_at)}</span>
                    <span>Bill {inr(r.fee_total)} · paid {inr(r.paid)} · due <b className={r.outstanding > 0 ? "text-amber-800" : "text-green-700"}>{inr(r.outstanding)}</b></span>
                    {r.outstanding > 0 && can("payment.record") && <button className="btn-ghost !min-h-[36px]" onClick={() => setPay(r)}>Record payment</button>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <PayModal row={pay} onClose={() => setPay(null)} onDone={() => { setPay(null); void load(); }} />
    </div>
  );
}

function PayModal({ row, onClose, onDone }: { row: Row | null; onClose: () => void; onDone: () => void }) {
  const { org } = useApp();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idem = useRef(newIdemKey()); // one key per opening of the dialog: a double click or a retry cannot record the payment twice
  useEffect(() => { setAmount(row ? String(row.outstanding) : ""); setMethod("cash"); setRef(""); setError(null); idem.current = newIdemKey(); }, [row]);
  const amt = Number(amount);
  const tooMuch = !!row && amt > row.outstanding + 1e-9;

  async function save() {
    if (!row || !org) return;
    setBusy(true); setError(null);
    const { error } = await supabase().rpc("post_collection", { p_org: org.organization_id, p_invoice: row.id, p_amount: Number(amount), p_method: method, p_reference: ref || (null as unknown as string), p_occurred_at: null as unknown as string, p_idem: idem.current });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    onDone();
  }
  return (
    <Modal open={!!row} onClose={onClose} title="Record payment">
      {row && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">{row.party_name} · {row.invoice_number}</p>
          <dl className="grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-3 text-sm">
            <div><dt className="text-slate-600">Bill</dt><dd className="font-semibold">{inr(row.fee_total)}</dd></div>
            <div><dt className="text-slate-600">Paid so far</dt><dd className="font-semibold">{inr(row.paid)}</dd></div>
            <div><dt className="text-slate-600">Outstanding</dt><dd className="font-bold text-navy">{inr(row.outstanding)}</dd></div>
          </dl>
          {error && <Alert>{error}</Alert>}
          <div><label className="label" htmlFor="amt">Amount (₹)</label><input id="amt" className={`field text-lg ${tooMuch ? "!border-red-500" : ""}`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
            {tooMuch ? <p role="alert" className="mt-1 text-xs font-medium text-red-700">More than the outstanding amount ({inr(row.outstanding)}).</p>
              : amt > 0 && <p className="mt-1 text-xs text-slate-600">Remaining after this payment: <b>{inr(row.outstanding - amt)}</b></p>}</div>
          <div><label className="label" htmlFor="meth">Method</label><Select id="meth" className="field" value={method} onChange={(e) => setMethod(e.target.value)}><option value="cash">Cash</option><option value="upi">UPI</option><option value="bank">Bank transfer</option><option value="cheque">Cheque</option></Select></div>
          <div><label className="label" htmlFor="ref">Reference</label><input id="ref" className="field" value={ref} onChange={(e) => setRef(e.target.value)} /></div>
          <p className="text-xs text-slate-600">Payments are never edited or deleted; corrections are made with a reversal.</p>
          <button className="btn-primary w-full" disabled={busy || !(amt > 0) || tooMuch} onClick={save}>{busy ? "Saving…" : "Save payment"}</button>
        </div>
      )}
    </Modal>
  );
}
