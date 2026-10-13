"use client";
import { DateInput } from "@/components/ios";
import { Select } from "@/components/ios";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { friendlyError } from "@/lib/errors";
import { inr, num } from "@/lib/format";
import { Alert, Empty, PageHead } from "@/components/ui";

interface Row { id: string; status: string; payment_mode: string; fee_total: string; net_weight_kg: string; party_name: string | null; site_id: string }
interface Bal { invoice_id: string; amount_paid: string; outstanding: string }

const ist = (d: Date) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
const daysAgo = (n: number) => ist(new Date(Date.now() - n * 86400e3));

export default function ReportsPage() {
  const { org, sites, can } = useApp();
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(ist(new Date()));
  const [site, setSite] = useState("");
  const [mode, setMode] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [bal, setBal] = useState<Map<string, Bal>>(new Map());
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!org) return;
    let alive = true;
    setLoading(true); setErr(null);
    void (async () => {
      const sb = supabase();
      let q = sb.from("invoices").select("id,status,payment_mode,fee_total,net_weight_kg,party_name,site_id").eq("organization_id", org.organization_id)
        .gte("issued_at", new Date(`${from}T00:00:00+05:30`).toISOString()).lt("issued_at", new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86400000).toISOString()).limit(5000);
      if (site) q = q.eq("site_id", site);
      if (mode) q = q.eq("payment_mode", mode as "cash");
      const { data, error } = await q;
      if (!alive) return;
      if (error) { setErr(friendlyError(error)); setLoading(false); return; }
      const list = (data ?? []) as unknown as Row[];
      const m = new Map<string, Bal>();
      for (let i = 0; i < list.length; i += 200) {
        const { data: b } = await sb.from("invoice_balances").select("invoice_id,amount_paid,outstanding").in("invoice_id", list.slice(i, i + 200).map((r) => r.id));
        for (const x of (b ?? []) as unknown as Bal[]) m.set(x.invoice_id, x);
      }
      if (!alive) return;
      setRows(list); setBal(m); setLoading(false);
    })();
    return () => { alive = false; };
  }, [org, from, to, site, mode]);

  const t = useMemo(() => {
    const ok = rows.filter((r) => r.status === "issued");
    const s = (f: (r: Row) => number, set = ok) => set.reduce((a, r) => a + f(r), 0);
    return {
      count: ok.length, cancelled: rows.length - ok.length, kg: s((r) => Number(r.net_weight_kg)), billed: s((r) => Number(r.fee_total)),
      cash: s((r) => Number(r.fee_total), ok.filter((r) => r.payment_mode === "cash")), credit: s((r) => Number(r.fee_total), ok.filter((r) => r.payment_mode === "credit")),
      paid: s((r) => Number(bal.get(r.id)?.amount_paid ?? 0)), out: s((r) => Number(bal.get(r.id)?.outstanding ?? 0)),
    };
  }, [rows, bal]);

  const qs = new URLSearchParams({ organization_id: org?.organization_id ?? "", from, to, ...(site ? { site_id: site } : {}), ...(mode ? { mode } : {}) });
  const quick = (n: number) => { setFrom(daysAgo(n)); setTo(ist(new Date())); };

  if (!can("report.view")) return <Alert kind="warn">You do not have permission to view reports.</Alert>;
  return (
    <div>
      <PageHead title="Reports" sub="Invoice register for a date range. Times are weighing-event times in IST." />
      <div className="card mb-4 space-y-3">
        <div className="flex flex-wrap gap-2">
          {[["Today", 0], ["Last 7 days", 6], ["Last 30 days", 29]].map(([l, n]) => <button key={l} className="btn-ghost !min-h-[36px]" onClick={() => quick(n as number)}>{l}</button>)}
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <div><label className="label" htmlFor="rf">From</label><DateInput id="rf" className="field" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><label className="label" htmlFor="rt">To</label><DateInput id="rt" className="field" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></div>
          <div><label className="label" htmlFor="rs">Site</label><Select id="rs" className="field" value={site} onChange={(e) => setSite(e.target.value)}><option value="">All sites</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></div>
          <div><label className="label" htmlFor="rm">Payment</label><Select id="rm" className="field" value={mode} onChange={(e) => setMode(e.target.value)}><option value="">All</option><option value="cash">Cash</option><option value="credit">Credit</option></Select></div>
        </div>
      </div>
      {err && <Alert>{err}</Alert>}
      {!loading && rows.length === 0 ? <Empty title="No invoices in this range" /> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[["Invoices", String(t.count)], ["Net weight", `${num(t.kg)} kg`], ["Total billed", inr(t.billed)], ["Outstanding", inr(t.out)], ["Cash invoices", inr(t.cash)], ["Credit invoices", inr(t.credit)], ["Collected", inr(t.paid)], ["Cancelled", String(t.cancelled)]].map(([l, v]) => (
              <div key={l} className="card"><p className="text-sm text-slate-600">{l}</p><p className="mt-1 text-xl font-bold text-navy">{v}</p></div>
            ))}
          </div>
          {can("report.export") && (
            <a className="btn-primary mt-4" href={`/api/v1/reports/invoices?${qs.toString()}`} download>⬇ Download Excel (.xlsx)</a>
          )}
          <p className="mt-2 text-xs text-slate-600">The Excel file has a Summary sheet and a full Invoices sheet. Cancelled invoices are listed but excluded from totals. Each export is recorded in the audit log.</p>
        </>
      )}
    </div>
  );
}
