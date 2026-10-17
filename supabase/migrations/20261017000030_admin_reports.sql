-- Platform admin reports (owner decision, 2026-10-17). Read-only, admin only, aggregated in the database (one call per view;
-- entries are paged) so firm screens stay fast. Days are India time. Cancelled (deleted) entries are left out.
-- Every row carries the firm's unique id (organization_id) so two firms with the same name are never mixed up.

create index if not exists invoices_org_closed_idx on public.invoices (organization_id, closed_at) where closed_at is not null;

-- One row per debtor (party) per firm: total billed, number of opening slips (every entry) and closing slips (closed entries),
-- paid and still due, contact and tax ids. p_org null = all firms; p_from / p_to null = all time (entry date, India time).
create or replace function public.admin_debtor_report(p_org uuid default null, p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'org_id', o.id, 'slug', o.slug, 'firm', o.display_name, 'debtor_id', p.id, 'debtor', p.display_name, 'party_type', p.party_type,
      'mobile', p.phone, 'gstin', p.gstin, 'pan', p.pan, 'email', p.email, 'contact', p.contact_person,
      'address', concat_ws(', ', nullif(p.address, ''), nullif(p.city, ''), nullif(p.state, ''), nullif(p.pin, '')), 'active', p.active,
      'billed', coalesce(t.billed, 0), 'opening_slips', coalesce(t.opening, 0), 'closing_slips', coalesce(t.closing, 0),
      'paid', coalesce(t.paid, 0), 'due', coalesce(t.due, 0), 'first_bill', t.first_bill, 'last_bill', t.last_bill)
      order by o.display_name, p.display_name)
    from public.parties p
    join public.organizations o on o.id = p.organization_id
    left join lateral (
      select sum(i.fee_total) as billed, count(*) as opening, count(*) filter (where i.stage = 'closed') as closing,
             sum(b.amount_paid) as paid, sum(b.outstanding) as due, min(i.issued_at) as first_bill, max(i.issued_at) as last_bill
      from public.invoices i left join public.invoice_balances b on b.invoice_id = i.id
      where i.organization_id = p.organization_id and i.party_id = p.id and i.status = 'issued'
        and (p_from is null or (i.issued_at at time zone 'Asia/Kolkata')::date >= p_from)
        and (p_to is null or (i.issued_at at time zone 'Asia/Kolkata')::date <= p_to)
    ) t on true
    where (p_org is null or p.organization_id = p_org)), '[]'::jsonb);
end $$;
revoke all on function public.admin_debtor_report(uuid, date, date) from public, anon;
grant execute on function public.admin_debtor_report(uuid, date, date) to authenticated;

-- Per firm per day: opening slips (entries started that day), closing slips (entries finished that day), amount billed
-- (entries started that day; cash / credit), first-weight-only entries still open.
create or replace function public.admin_daily_report(p_org uuid default null, p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('org_id', d.org_id, 'slug', o.slug, 'firm', o.display_name, 'day', d.day,
      'opening_slips', d.opening, 'closing_slips', d.closing, 'still_open', d.still_open,
      'billed', d.billed, 'cash', d.cash, 'credit', d.credit) order by d.day desc, o.display_name)
    from (
      select x.org_id, x.day, sum(x.opening) as opening, sum(x.closing) as closing, sum(x.still_open) as still_open,
             sum(x.billed) as billed, sum(x.cash) as cash, sum(x.credit) as credit
      from (
        select i.organization_id as org_id, (i.issued_at at time zone 'Asia/Kolkata')::date as day, 1 as opening, 0 as closing,
               case when i.stage = 'open' then 1 else 0 end as still_open, i.fee_total as billed,
               case when i.payment_mode = 'cash' then i.fee_total else 0 end as cash, case when i.payment_mode = 'credit' then i.fee_total else 0 end as credit
        from public.invoices i where i.status = 'issued' and (p_org is null or i.organization_id = p_org)
        union all
        select i.organization_id, (i.closed_at at time zone 'Asia/Kolkata')::date, 0, 1, 0, 0, 0, 0
        from public.invoices i where i.status = 'issued' and i.closed_at is not null and (p_org is null or i.organization_id = p_org)
      ) x
      where (p_from is null or x.day >= p_from) and (p_to is null or x.day <= p_to)
      group by x.org_id, x.day
    ) d join public.organizations o on o.id = d.org_id), '[]'::jsonb);
end $$;
revoke all on function public.admin_daily_report(uuid, date, date) from public, anon;
grant execute on function public.admin_daily_report(uuid, date, date) to authenticated;

-- Every entry (opening and closing), day-wise, paged. Returns {total, rows}.
create or replace function public.admin_entries_report(p_org uuid default null, p_from date default null, p_to date default null,
  p_limit int default 200, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare lim int := least(greatest(coalesce(p_limit, 200), 1), 5000); off int := greatest(coalesce(p_offset, 0), 0); total bigint; rows jsonb;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select count(*) into total from public.invoices i
   where i.status = 'issued' and (p_org is null or i.organization_id = p_org)
     and (p_from is null or (i.issued_at at time zone 'Asia/Kolkata')::date >= p_from)
     and (p_to is null or (i.issued_at at time zone 'Asia/Kolkata')::date <= p_to);
  select coalesce(jsonb_agg(r order by r_day desc, r_firm, r_no desc), '[]'::jsonb) into rows from (
    select jsonb_build_object('org_id', i.organization_id, 'slug', o.slug, 'firm', o.display_name, 'site', s.name,
      'day', (i.issued_at at time zone 'Asia/Kolkata')::date, 'invoice_no', i.invoice_number, 'vehicle', i.vehicle_display,
      'stage', i.stage, 'opened_at', i.issued_at, 'closed_at', i.closed_at,
      'first_weight', i.gross_weight_kg, 'gross', case when i.stage = 'closed' then i.gross_weight_kg end,
      'tare', case when i.stage = 'closed' then i.tare_weight_kg end, 'net', case when i.stage = 'closed' then i.net_weight_kg end,
      'amount', i.fee_total, 'payment', i.payment_mode, 'party', i.party_name, 'material', i.material) as r,
      (i.issued_at at time zone 'Asia/Kolkata')::date as r_day, o.display_name as r_firm, i.seq_value as r_no
    from public.invoices i join public.organizations o on o.id = i.organization_id join public.sites s on s.id = i.site_id
    where i.status = 'issued' and (p_org is null or i.organization_id = p_org)
      and (p_from is null or (i.issued_at at time zone 'Asia/Kolkata')::date >= p_from)
      and (p_to is null or (i.issued_at at time zone 'Asia/Kolkata')::date <= p_to)
    order by i.issued_at desc, o.display_name
    limit lim offset off
  ) q;
  return jsonb_build_object('total', total, 'rows', rows);
end $$;
revoke all on function public.admin_entries_report(uuid, date, date, int, int) from public, anon;
grant execute on function public.admin_entries_report(uuid, date, date, int, int) to authenticated;
