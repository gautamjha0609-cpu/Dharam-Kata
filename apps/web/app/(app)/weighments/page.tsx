"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { friendlyError } from "@/lib/errors";
import { fmtDateTime, inr, num } from "@/lib/format";
import { Alert, Empty, PageHead } from "@/components/ui";
import { useLive } from "@/lib/use-live";
import type { Invoice } from "@/lib/types";
import { DeleteEntryButton } from "@/components/delete-entry";

/** Open entries: vehicles weighed once whose second weighing (closing) has not happened yet. */
export default function OpenEntriesPage() {
  const { org, can, sites } = useApp();
  const [rows, setRows] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!org) return;
    setErr(null);
    const { data, error } = await supabase().from("invoices").select("*")
      .eq("organization_id", org.organization_id).eq("stage", "open").eq("status", "issued")
      .order("issued_at", { ascending: false }).limit(200);
    if (error) setErr(friendlyError(error));
    setRows((data ?? []) as Invoice[]);
    setLoading(false);
  }, [org]);

  useEffect(() => { void load(); }, [load]);
  useLive(load, ["invoices"]); // realtime is only a hint: it refetches the authoritative list

  const shown = useMemo(() => rows.filter((r) => !q || `${r.vehicle_display} ${r.material ?? ""} ${r.invoice_number}`.toLowerCase().includes(q.toLowerCase())), [rows, q]);
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? "";

  return (
    <div>
      <PageHead title="Open entries" sub="Vehicles weighed once. When one comes back, check its number on the Weighment page to close it."
        actions={can("weighment.create") ? <Link href="/weighments/new" className="btn-primary">＋ Weighment</Link> : undefined} />
      <input className="field mb-3" type="search" placeholder="Search vehicle, material or invoice no…" aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
      {err && <Alert>{err}</Alert>}
      {loading ? <p className="text-slate-600">Loading…</p> : shown.length === 0 ? (
        <Empty title="No open entries" hint="A vehicle appears here after its first weighing and disappears when it is closed." />
      ) : (
        <ul className="space-y-3">
          {shown.map((r) => (
            <li key={r.id} className="card">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-lg font-bold tracking-wide text-navy">{r.vehicle_display}</p>
                  <p className="text-sm text-slate-600">{r.invoice_number}{r.material ? ` · ${r.material}` : ""}{sites.length > 1 && ` · ${siteName(r.site_id)}`}</p>
                </div>
                <span className="badge bg-amber-100 text-amber-900">⏳ Waiting for second weight</span>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                <div><dt className="text-slate-600">First weight</dt><dd className="font-semibold">{num(r.gross_weight_kg)} kg</dd></div>
                <div><dt className="text-slate-600">Weighed at</dt><dd>{fmtDateTime(r.gross_weight_at)}</dd></div>
                <div><dt className="text-slate-600">Amount entered</dt><dd>{inr(r.fee_total)}</dd></div>
                {r.party_name && <div><dt className="text-slate-600">Party</dt><dd>{r.party_name}</dd></div>}
              </dl>
              <div className="mt-3 flex flex-wrap gap-2">
                {can("weighment.complete") && <Link className="btn-navy" href={`/weighments/new?vehicle=${encodeURIComponent(r.vehicle_display)}`}>Close this entry</Link>}
                <DeleteEntryButton invoiceId={r.id} label={`entry ${r.invoice_number} (${r.vehicle_display})`} onDone={() => void load()} className="btn-ghost !text-red-700" />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
