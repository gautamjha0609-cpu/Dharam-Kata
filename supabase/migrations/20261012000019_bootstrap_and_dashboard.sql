-- Fewer round trips when a page opens.

-- 1. everything the app frame needs in ONE call: who you are, your firms, the first firm's sites and billing unit.
create or replace function public.app_bootstrap() returns jsonb
language sql stable security definer set search_path = '' as $$
  with m as (select public.me() as me),
       f as (select (me -> 'memberships' -> 0 ->> 'organization_id')::uuid as org from m)
  select m.me || jsonb_build_object(
    'sites', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'code', s.code) order by s.name)
                         from public.sites s, f where s.organization_id = f.org and s.active), '[]'::jsonb),
    'weight_unit', (select p.weight_unit from public.pricing_settings p, f where p.organization_id = f.org))
  from m
$$;
revoke all on function public.app_bootstrap() from public, anon;
grant execute on function public.app_bootstrap() to authenticated;

-- 2. the dashboard numbers, added up inside the database (exact, no row limits, one call). Row-level security still applies (security invoker).
create or replace function public.dashboard_summary(p_org uuid, p_since timestamptz) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'pending', (select count(*) from public.weighments w where w.organization_id = p_org and w.status = 'pending_empty'),
    'ready', (select count(*) from public.weighments w where w.organization_id = p_org and w.status = 'ready_to_invoice'),
    'invoices_today', (select count(*) from public.invoices i where i.organization_id = p_org and i.status = 'issued' and i.issued_at >= p_since),
    'cash_today', (select coalesce(sum(i.fee_total), 0) from public.invoices i where i.organization_id = p_org and i.status = 'issued' and i.issued_at >= p_since and i.payment_mode = 'cash'),
    'credit_out', (select coalesce(sum(b.outstanding), 0) from public.invoice_balances b where b.organization_id = p_org and b.outstanding > 0),
    'print_attention', (select count(*) from public.print_jobs j where j.organization_id = p_org and j.status in ('not_configured', 'routing_error', 'failed', 'unknown')),
    'recent', coalesce((select jsonb_agg(r) from (
        select i.id, i.invoice_number, i.vehicle_display, i.stage, i.status, i.fee_total, i.issued_at, i.party_name
          from public.invoices i where i.organization_id = p_org order by i.issued_at desc limit 8) r), '[]'::jsonb))
$$;
revoke all on function public.dashboard_summary(uuid, timestamptz) from public, anon;
grant execute on function public.dashboard_summary(uuid, timestamptz) to authenticated;
