import type { SupabaseClient } from "@supabase/supabase-js";

export interface Recent { id: string; invoice_number: string; vehicle_display: string; stage: "open" | "closed"; status: string; fee_total: string | number; issued_at: string; party_name: string | null }
export interface Stats { pending: number; ready: number; invoicesToday: number; cashToday: number; creditOut: number; printAttention: number }
export interface DashboardData { orgId: string; stats: Stats; recent: Recent[]; at: string }

/**
 * The dashboard numbers: ONE database call that adds everything up inside the database (exact, no row limits).
 * The same function runs on the server (so the numbers arrive with the page) and in the browser (after switching firm).
 */
export async function fetchDashboard(sb: SupabaseClient, id: string): Promise<DashboardData> {
  const since = new Date(`${new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)}T00:00:00+05:30`).toISOString();
  const { data } = await sb.rpc("dashboard_summary", { p_org: id, p_since: since });
  const d = (data ?? {}) as { pending?: number; ready?: number; invoices_today?: number; cash_today?: number; credit_out?: number; print_attention?: number; recent?: Recent[] };
  return {
    orgId: id,
    recent: d.recent ?? [],
    at: new Date().toISOString(),
    stats: {
      pending: d.pending ?? 0, ready: d.ready ?? 0, invoicesToday: d.invoices_today ?? 0,
      cashToday: Number(d.cash_today ?? 0), creditOut: Number(d.credit_out ?? 0), printAttention: d.print_attention ?? 0,
    },
  };
}
