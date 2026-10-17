"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ADMIN_PATH } from "@/lib/admin-path";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { friendlyError } from "@/lib/errors";
import { fmtDateTime, inr, num } from "@/lib/format";
import { Select } from "@/components/ios";
import { Alert, PageHead } from "@/components/ui";

interface Firm { id: string; display_name: string; slug: string }
interface Debtor { org_id: string; slug: string; firm: string; debtor_id: string; debtor: string; mobile: string | null; gstin: string | null; pan: string | null; billed: number; opening_slips: number; closing_slips: number; paid: number; due: number; last_bill: string | null }
interface Day { org_id: string; slug: string; firm: string; day: string; opening_slips: number; closing_slips: number; still_open: number; billed: number; cash: number; credit: number }
interface Entry { org_id: string; slug: string; firm: string; site: string; day: string; invoice_no: string; vehicle: string; stage: string; opened_at: string; closed_at: string | null; first_weight: number; net: number | null; amount: number; payment: string; party: string | null }
type Tab = "debtors" | "daily" | "entries";
const PAGE = 100;
const dmy = (d: string) => d.split("-").reverse().join("-");

/** Platform admin: debtors, day-wise totals and every entry, for all firms or one firm, any date range; Excel export of the same. */
export default function AdminReportsPage() {
  const { me } = useApp();
  const [firms, setFirms] = useState<Firm[]>([]);
  const [org, setOrg] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [tab, setTab] = useState<Tab>("debtors");
  const [find, setFind] = useState("");
  const [debtors, setDebtors] = useState<Debtor[] | null>(null);
  const [days, setDays] = useState<Day[] | null>(null);
  const [entries, setEntries] = useState<{ total: number; rows: Entry[] } | null>(null);
  const [page, setPage] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { void (async () => { const { data } = await supabase().from("organizations").select("id,display_name,slug").order("display_name"); setFirms((data ?? []) as Firm[]); })(); }, []);
  const args = useMemo(() => ({ p_org: (org || null) as unknown as string, p_from: (from || null) as unknown as string, p_to: (to || null) as unknown as string }), [org, from, to]);

  // only the open tab is read, and only when filters change (each is one aggregated call)
  const load = useCallback(async () => {
    setErr(null);
    const sb = supabase();
    if (tab === "debtors") { setDebtors(null); const { data, error } = await sb.rpc("admin_debtor_report", args); if (error) setErr(friendlyError(error)); setDebtors((data ?? []) as Debtor[]); }
    if (tab === "daily") { setDays(null); const { data, error } = await sb.rpc("admin_daily_report", args); if (error) setErr(friendlyError(error)); setDays((data ?? []) as Day[]); }
    if (tab === "entries") { setEntries(null); const { data, error } = await sb.rpc("admin_entries_report", { ...args, p_limit: PAGE, p_offset: page * PAGE }); if (error) setErr(friendlyError(error)); setEntries((data ?? { total: 0, rows: [] }) as { total: number; rows: Entry[] }); }
  }, [tab, args, page]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setPage(0); }, [org, from, to]);

  const v = find.trim().toLowerCase();
  const shownDebtors = useMemo(() => (debtors ?? []).filter((d) => !v || [d.debtor, d.firm, d.slug, d.org_id, d.mobile ?? "", d.gstin ?? "", d.pan ?? ""].some((x) => x.toLowerCase().includes(v))), [debtors, v]);
  const totals = useMemo(() => shownDebtors.reduce((t, d) => ({ billed: t.billed + Number(d.billed), due: t.due + Number(d.due), open: t.open + Number(d.opening_slips), close: t.close + Number(d.closing_slips) }), { billed: 0, due: 0, open: 0, close: 0 }), [shownDebtors]);

  if (!me.is_platform_admin) return <Alert kind="warn">Platform administrators only.</Alert>;
  const exportUrl = `/api/v1/admin/reports/export?${new URLSearchParams({ org, from, to })}`;

  return (
    <div className="space-y-4">
      <PageHead title="Reports" sub="Debtors, day-wise sales and every entry, for all firms or one firm. Empty dates = all time." actions={<Link href={ADMIN_PATH} className="btn-ghost">← Firms</Link>} />
      <div className="card grid gap-2 sm:grid-cols-[1.4fr_1fr_1fr_auto] sm:items-end">
        <div><label className="label text-xs" htmlFor="rf">Firm</label>
          <Select id="rf" className="field !min-h-[40px]" value={org} onChange={(e) => setOrg(e.target.value)}>
            <option value="">All firms</option>
            {firms.map((f) => <option key={f.id} value={f.id}>{f.display_name} · {f.slug}</option>)}
          </Select></div>
        <div><label className="label text-xs" htmlFor="rfrom">From</label><input id="rfrom" type="date" className="field !min-h-[40px]" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label className="label text-xs" htmlFor="rto">To</label><input id="rto" type="date" className="field !min-h-[40px]" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></div>
        <a className="btn-primary !min-h-[40px]" href={exportUrl}>⬇ Export Excel</a>
      </div>
      <div className="flex flex-wrap gap-1" role="tablist">
        {([["debtors", "Debtors"], ["daily", "Day-wise"], ["entries", "All entries"]] as [Tab, string][]).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "btn-navy !min-h-[40px]" : "btn-ghost !min-h-[40px]"} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {err && <Alert>{err}</Alert>}

      {tab === "debtors" && (
        <section className="space-y-2">
          <input className="field !min-h-[40px]" type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Search debtor, firm, firm ID, mobile, GSTIN, PAN" aria-label="Search debtors" />
          {!debtors ? <Skeleton /> : (
            <>
              <p className="text-sm text-slate-600">{shownDebtors.length} debtors · billed <b>{inr(totals.billed)}</b> · due <b>{inr(totals.due)}</b> · {totals.open} opening / {totals.close} closing slips</p>
              <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="bg-slate-50 text-left text-xs text-slate-600"><tr><th className="p-2">Debtor</th><th className="p-2">Firm</th><th className="p-2">Mobile · GSTIN · PAN</th><th className="p-2 text-right">Billed</th><th className="p-2 text-right">Opening</th><th className="p-2 text-right">Closing</th><th className="p-2 text-right">Due</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {shownDebtors.slice(0, 500).map((d) => (
                      <tr key={d.debtor_id}>
                        <td className="p-2 font-medium text-navy">{d.debtor}</td>
                        <td className="p-2">{d.firm}<span className="block text-xs text-slate-500">{d.slug}</span></td>
                        <td className="p-2 text-xs">{[d.mobile, d.gstin, d.pan].filter(Boolean).join(" · ") || "—"}</td>
                        <td className="p-2 text-right">{inr(d.billed)}</td><td className="p-2 text-right">{d.opening_slips}</td><td className="p-2 text-right">{d.closing_slips}</td>
                        <td className={`p-2 text-right ${Number(d.due) > 0 ? "font-semibold text-red-700" : ""}`}>{inr(d.due)}</td>
                      </tr>
                    ))}
                    {shownDebtors.length === 0 && <tr><td colSpan={7} className="p-3 text-slate-600">No debtor matches.</td></tr>}
                  </tbody>
                </table>
              </div>
              {shownDebtors.length > 500 && <p className="text-xs text-slate-600">First 500 shown. The Excel has all of them.</p>}
            </>
          )}
        </section>
      )}

      {tab === "daily" && (!days ? <Skeleton /> : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[680px] text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-600"><tr><th className="p-2">Date</th><th className="p-2">Firm</th><th className="p-2 text-right">Opening slips</th><th className="p-2 text-right">Closing slips</th><th className="p-2 text-right">Still open</th><th className="p-2 text-right">Billed</th><th className="p-2 text-right">Cash</th><th className="p-2 text-right">Credit</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {days.slice(0, 1000).map((d) => (
                <tr key={d.org_id + d.day}><td className="p-2 whitespace-nowrap">{dmy(d.day)}</td><td className="p-2">{d.firm}<span className="block text-xs text-slate-500">{d.slug}</span></td>
                  <td className="p-2 text-right">{d.opening_slips}</td><td className="p-2 text-right">{d.closing_slips}</td><td className="p-2 text-right">{d.still_open}</td>
                  <td className="p-2 text-right font-medium">{inr(d.billed)}</td><td className="p-2 text-right">{inr(d.cash)}</td><td className="p-2 text-right">{inr(d.credit)}</td></tr>
              ))}
              {days.length === 0 && <tr><td colSpan={8} className="p-3 text-slate-600">No entries in this period.</td></tr>}
            </tbody>
          </table>
        </div>
      ))}

      {tab === "entries" && (!entries ? <Skeleton /> : (
        <section className="space-y-2">
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-600"><tr><th className="p-2">Date</th><th className="p-2">Firm</th><th className="p-2">Invoice</th><th className="p-2">Vehicle</th><th className="p-2">Stage</th><th className="p-2 text-right">Net kg</th><th className="p-2 text-right">Amount</th><th className="p-2">Party</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {entries.rows.map((e) => (
                  <tr key={e.org_id + e.invoice_no}><td className="p-2 whitespace-nowrap">{dmy(e.day)}</td><td className="p-2">{e.firm}</td><td className="p-2">{e.invoice_no}</td><td className="p-2">{e.vehicle}</td>
                    <td className="p-2">{e.stage === "closed" ? <span className="badge bg-green-100 text-green-800">Closed{e.closed_at ? ` ${fmtDateTime(e.closed_at)}` : ""}</span> : <span className="badge bg-amber-100 text-amber-900">Open</span>}</td>
                    <td className="p-2 text-right">{e.net !== null ? num(e.net) : "—"}</td><td className="p-2 text-right">{inr(e.amount)}</td><td className="p-2">{e.party ?? (e.payment === "cash" ? "Cash" : "—")}</td></tr>
                ))}
                {entries.rows.length === 0 && <tr><td colSpan={8} className="p-3 text-slate-600">No entries in this period.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-slate-600">{entries.total === 0 ? "0" : `${page * PAGE + 1}–${Math.min((page + 1) * PAGE, entries.total)}`} of {entries.total}</span>
            <span className="flex gap-2">
              <button type="button" className="btn-ghost !min-h-[38px]" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← Newer</button>
              <button type="button" className="btn-ghost !min-h-[38px]" disabled={(page + 1) * PAGE >= entries.total} onClick={() => setPage((p) => p + 1)}>Older →</button>
            </span>
          </div>
        </section>
      ))}
    </div>
  );
}

const Skeleton = () => <div className="space-y-2" aria-busy="true" aria-label="Loading"><div className="skeleton h-10 w-full" /><div className="skeleton h-10 w-full" /><div className="skeleton h-10 w-full" /></div>;
