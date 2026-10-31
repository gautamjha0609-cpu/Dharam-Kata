"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { inr } from "@/lib/format";
import { fetchDashboard, type DashboardData } from "@/lib/dashboard-data";
import { useLive } from "@/lib/use-live";
import { Alert, PageHead } from "@/components/ui";
import { useReceipt } from "@/components/receipt";

export function DashboardView({ initial }: { initial: DashboardData | null }) {
  const { org, can, settings, me } = useApp();
  const [data, setData] = useState<DashboardData | null>(initial);

  // the server already sent the first firm's numbers; fetch only for another firm (or when none came)
  useEffect(() => {
    if (!org || !can("invoice.read")) return;
    if (data && data.orgId === org.organization_id) return;
    let alive = true;
    void fetchDashboard(supabase(), org.organization_id).then((r) => { if (alive) setData(r); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, can]);

  useLive(async () => {
    if (!org || !can("invoice.read")) return;
    setData(await fetchDashboard(supabase(), org.organization_id));
  }, ["invoices", "print_jobs"]); // every entry change also updates its invoice, so weighments need no live feed

  const s = data && org && data.orgId === org.organization_id ? data.stats : null;
  const recent = s ? data!.recent : [];
  const updated = s ? new Date(data!.at) : null;

  const cards: [string, string | number, string?][] = s ? [
    ["Open entries (second weight pending)", s.pending, "/weighments"],
    ["Invoices today", s.invoicesToday, "/invoices"], ["Cash today", inr(s.cashToday), "/invoices"],
    ["Credit outstanding", inr(s.creditOut), "/collections"], ["Print needs attention", s.printAttention, "/print"],
  ] : [];

  return (
    <div>
      <PageHead title={`Hello, ${me.full_name || me.login_id}`} sub={org ? org.display_name : "No organisation assigned"}
        actions={org && can("weighment.create") ? <Link href="/weighments/new" className="btn-primary !min-h-[48px] px-5 text-base shadow-sm">＋ New weighment</Link> : undefined} />
      {!org && <Alert kind="warn">Your account is not linked to an organisation yet.</Alert>}
      {org && !settings.weight_unit && can("pricing.manage") && <div className="mb-4"><Alert kind="warn">Finish setup: choose the billing unit and invoice series in <Link className="underline" href="/settings">Settings</Link>.</Alert></div>}
      {org && can("ticket.image") && !can("pricing.manage") && <TicketHint />}
      {!s && org && can("invoice.read") && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3" aria-busy="true" aria-label="Loading your numbers">
          {Array.from({ length: 5 }, (_, i) => <div key={i} className="card min-h-[88px]"><div className="skeleton h-4 w-28" /><div className="skeleton mt-3 h-7 w-20" /></div>)}
        </div>
      )}
      {s && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {cards.map(([label, value, href]) => (
              <Link key={label} href={href!} className="card hover:border-brand">
                <p className="text-sm text-slate-600">{label}</p><p className="mt-1 text-2xl font-bold text-navy">{value}</p>
              </Link>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-600">Last synced {updated?.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}</p>
          {recent.length > 0 && (
            <section className="card mt-5">
              <div className="mb-2 flex items-center justify-between"><h2 className="font-bold text-navy">Recent entries</h2><Link href="/invoices" className="text-sm underline">See all</Link></div>
              <ul className="divide-y divide-slate-100 text-sm">
                {recent.map((r) => (
                  <li key={r.id}>
                    <Link href={`/invoices/${r.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2 hover:bg-slate-50">
                      <span><b className="text-navy">{r.vehicle_display}</b> <span className="text-slate-600">{r.invoice_number}</span>{r.party_name ? <span className="text-slate-600"> · {r.party_name}</span> : null}</span>
                      <span className="flex items-center gap-2">
                        {r.status === "cancelled" ? <span className="badge bg-red-100 text-red-800">Cancelled</span> : r.stage === "open" ? <span className="badge bg-amber-100 text-amber-900">Open</span> : <span className="badge bg-green-100 text-green-800">Closed</span>}
                        <b>{inr(r.fee_total)}</b>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function TicketHint() {
  const r = useReceipt();
  if (r.imageUrl) return null;
  return <div className="mb-4"><Alert kind="info">Upload your ticket image once so you can preview each invoice. <Link className="underline" href="/settings">Open Settings</Link></Alert></div>;
}
