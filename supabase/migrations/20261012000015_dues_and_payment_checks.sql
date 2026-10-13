-- 1. "Paid now" can never exceed the amount of the entry (it used to be silently clamped). Enforced in the database. ----
do $$
declare d text;
begin
  select pg_get_functiondef('public.open_entry(uuid, uuid, text, numeric, numeric, public.payment_mode, uuid, text, text, jsonb, public.time_mode, timestamptz, text, text, boolean, numeric)'::regprocedure) into d;
  d := replace(d, 'least(coalesce(p_amount_paid, 0), inv.fee_total)', 'coalesce(p_amount_paid, 0)');
  d := replace(d, E'  select weight_unit into unit from public.pricing_settings where organization_id = p_org;',
    E'  if p_amount_paid is not null and (p_amount_paid < 0 or round(p_amount_paid, 2) > round(p_amount, 2)) then raise exception ''invalid_amount_paid'' using errcode = ''22023''; end if;\n  select weight_unit into unit from public.pricing_settings where organization_id = p_org;');
  if position('invalid_amount_paid' in d) = 0 then raise exception 'open_entry patch did not apply'; end if;
  execute d;

  select pg_get_functiondef('public.close_entry(uuid, uuid, numeric, numeric, public.payment_mode, uuid, text, text, jsonb, public.time_mode, timestamptz, text, int, text, numeric)'::regprocedure) into d;
  d := replace(d, 'least(coalesce(p_amount_paid, case when was_credit then paid else 0 end), inv.fee_total)', 'coalesce(p_amount_paid, case when was_credit then least(paid, inv.fee_total) else 0 end)');
  d := replace(d, E'  second := round(p_weight, 3); first := w.gross_weight_kg;',
    E'  if p_amount_paid is not null and (p_amount_paid < 0 or round(p_amount_paid, 2) > round(p_amount, 2)) then raise exception ''invalid_amount_paid'' using errcode = ''22023''; end if;\n  second := round(p_weight, 3); first := w.gross_weight_kg;');
  if position('invalid_amount_paid' in d) = 0 then raise exception 'close_entry patch did not apply'; end if;
  execute d;
end $$;

-- 2. Previous dues of a vehicle (closed, issued, still outstanding), shown when the operator checks the vehicle. -------
create function public.find_vehicle_dues(p_org uuid, p_vehicle text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare norm text := regexp_replace(upper(coalesce(p_vehicle, '')), '[^A-Z0-9]', '', 'g');
begin
  if not (public.has_permission(p_org, 'invoice.read') or public.has_permission(p_org, 'weighment.create')) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if norm = '' then return jsonb_build_object('total', 0, 'count', 0, 'items', '[]'::jsonb); end if;
  return (
    select jsonb_build_object('total', coalesce(sum(b.outstanding), 0), 'count', count(*),
      'items', coalesce(jsonb_agg(jsonb_build_object('invoice_id', i.id, 'invoice_number', i.invoice_number, 'issued_at', i.issued_at,
        'amount', i.fee_total, 'paid', b.amount_paid, 'outstanding', b.outstanding, 'party_name', i.party_name) order by i.issued_at), '[]'::jsonb))
    from public.invoices i
    join public.weighments w on w.id = i.weighment_id and w.organization_id = i.organization_id
    join public.invoice_balances b on b.invoice_id = i.id
    where i.organization_id = p_org and w.vehicle_normalized = norm and i.status = 'issued' and i.stage = 'closed'
      and b.outstanding > 0 and public.has_site_access(p_org, i.site_id));
end $$;
revoke all on function public.find_vehicle_dues(uuid, text) from public, anon;
grant execute on function public.find_vehicle_dues(uuid, text) to authenticated;

-- 3. Collections: a repeated request (double click, retry after a network drop) must not record the payment twice. ----
alter table public.invoice_payments add column idempotency_key text;
create unique index invoice_payments_idem on public.invoice_payments (organization_id, idempotency_key) where idempotency_key is not null;

drop function public.post_collection(uuid, uuid, numeric, text, text, timestamptz);
create function public.post_collection(p_org uuid, p_invoice uuid, p_amount numeric, p_method text, p_reference text, p_occurred_at timestamptz,
  p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare inv public.invoices; out_amt numeric; p public.invoice_payments;
begin
  select * into inv from public.invoices where id = p_invoice and organization_id = p_org for update;   -- serialises concurrent payments on one invoice
  if not found then raise exception 'invoice_not_found' using errcode = 'P0002'; end if;
  perform public.assert_can(p_org, 'payment.record', inv.site_id);
  if p_idem is not null then
    select * into p from public.invoice_payments where organization_id = p_org and idempotency_key = p_idem;
    if found then return to_jsonb(p); end if;
  end if;
  if inv.status <> 'issued' then raise exception 'invoice_not_issued' using errcode = '23514'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;
  select outstanding into out_amt from public.invoice_balances where invoice_id = inv.id;
  if round(p_amount, 2) > out_amt then raise exception 'amount_exceeds_outstanding' using errcode = '22023'; end if;
  insert into public.invoice_payments (organization_id, site_id, invoice_id, party_id, kind, amount, method, reference, occurred_at, recorded_by, idempotency_key)
  values (p_org, inv.site_id, inv.id, inv.party_id, 'payment', round(p_amount, 2), coalesce(p_method, 'cash'), p_reference,
    coalesce(p_occurred_at, now()), (select auth.uid()), p_idem) returning * into p;
  perform public.write_audit(p_org, inv.site_id, (select auth.uid()), 'payment.record', 'invoice', inv.id::text, null,
    jsonb_build_object('amount', p.amount, 'method', p.method));
  return to_jsonb(p);
end $$;
revoke all on function public.post_collection(uuid, uuid, numeric, text, text, timestamptz, text) from public, anon;
grant execute on function public.post_collection(uuid, uuid, numeric, text, text, timestamptz, text) to authenticated;
