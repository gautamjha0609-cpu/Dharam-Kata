"use client";
import { DateInput } from "@/components/ios";
import { Select } from "@/components/ios";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLive } from "@/lib/use-live";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { friendlyError } from "@/lib/errors";
import { fmtDateTime, inr, num } from "@/lib/format";
import { Alert, Empty, PageHead } from "@/components/ui";
import type { Invoice } from "@/lib/types";

const PAGE = 25;

export default function InvoicesPage() {
  const { org } = useApp();
  const [rows, setRows] = useState<Invoice[]>([]);
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [mode, setMode] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (append: boolean, after: string | null) => {
    if (!org) return;
    setLoading(true); setErr(null);
    let qb = supabase().from("invoices").select("*").eq("organization_id", org.organization_id).order("issued_at", { ascending: false }).limit(PAGE + 1);
    if (after) qb = qb.lt("issued_at", after);
    if (from) qb = qb.gte("issued_at", new Date(`${from}T00:00:00+05:30`).toISOString());
    if (to) qb = qb.lt("issued_at", new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86400000).toISOString());
    if (mode) qb = qb.eq("payment_mode", mode);
    if (q.trim()) qb = qb.or(`invoice_number.ilike.%${q.trim().replace(/[%,()]/g, "")}%,vehicle_display.ilike.%${q.trim().replace(/[%,()]/g, "")}%,party_name.ilike.%${q.trim().replace(/[%,()]/g, "")}%`);
    const { data, error } = await qb;
    if (error) setErr(friendlyError(error));
    const list = ((data ?? []) as Invoice[]);
    setMore(list.length > PAGE);
    const page = list.slice(0, PAGE);
    setRows((prev) => (append ? [...prev, ...page] : page));
    setCursor(page.at(-1)?.issued_at ?? null);
    setLoading(false);
  }, [org, q, from, to, mode]);

  // the list loads at once when the page opens; the short wait is only for typing in the search / changing filters
  const firstLoad = useRef(true);
  useEffect(() => {
    const wait = firstLoad.current ? 0 : 250;
    firstLoad.current = false;
    const t = setTimeout(() => void load(false, null), wait);
    return () => clearTimeout(t);
  }, [load]);
  useLive(() => { if (rows.length <= PAGE) void load(false, null); }, ["invoices"]);

  return (
    <div>
      <PageHead title="Invoices" sub="Search issued invoices. Most recent first." />
      <div className="card mb-3 grid gap-3 sm:grid-cols-4">
        <input className="field sm:col-span-2" type="search" placeholder="Invoice no, vehicle or debtor…" aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        <DateInput clearable className="field" aria-label="From date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <DateInput clearable className="field" aria-label="To date" value={to} onChange={(e) => setTo(e.target.value)} />
        <Select className="field" aria-label="Payment mode" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="">All payments</option><option value="cash">Cash</option><option value="credit">Credit</option>
        </Select>
      </div>
      {err && <Alert>{err}</Alert>}
      {!loading && rows.length === 0 ? <Empty title="No invoices found" hint="Try a different search or date range." /> : (
        <ul className="space-y-2">
          {rows.map((i) => (
            <li key={i.id}>
              <Link href={`/invoices/${i.id}`} className="card flex flex-wrap items-center justify-between gap-2 hover:border-brand">
                <div>
                  <p className="font-bold text-navy">{i.invoice_number} {i.status === "cancelled" && <span className="badge bg-red-100 text-red-800">✕ Cancelled</span>} {i.status !== "cancelled" && i.stage === "open" && <span className="badge bg-amber-100 text-amber-900">⏳ Open</span>}</p>
                  <p className="text-sm text-slate-600">{i.vehicle_display} · {i.party_name || "Walk-in"}</p>
                  <p className="text-xs text-slate-600">{fmtDateTime(i.issued_at)} · {i.stage === "open" ? `first weight ${num(i.gross_weight_kg)} kg` : `${num(i.net_weight_kg ?? 0)} kg net`}</p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-bold">{inr(i.fee_total)}</p>
                  <span className={`badge ${i.payment_mode === "cash" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-900"}`}>{i.payment_mode === "cash" ? "● Cash" : "◷ Credit"}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {loading && <p className="mt-3 text-slate-600">Loading…</p>}
      {more && !loading && <button className="btn-ghost mt-3 w-full" onClick={() => void load(true, cursor)}>Load more</button>}
    </div>
  );
}
