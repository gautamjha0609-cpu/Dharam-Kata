-- (1) Ticket image per firm (preview only, uploaded once, replaceable in Settings)
-- (3) Price can be entered at BOTH weighings; the invoice uses the LAST entry's price.

create table public.tenant_assets (
  organization_id uuid not null references public.organizations (id) on delete restrict,
  kind text not null check (kind in ('ticket_preview')),
  path text not null,
  mime text not null,
  bytes_original int not null,
  bytes_optimized int not null,
  width int not null,
  height int not null,
  checksum text not null,
  version int not null default 1,
  uploaded_by uuid,
  updated_at timestamptz not null default now(),
  primary key (organization_id, kind)
);
alter table public.tenant_assets enable row level security;
create policy tenant_assets_read on public.tenant_assets for select to authenticated
  using (public.has_permission(organization_id, 'print.view') or public.has_permission(organization_id, 'ticket.image'));
revoke insert, update, delete, truncate on public.tenant_assets from anon, authenticated;
revoke all on public.tenant_assets from anon;

-- private bucket: no client policies, only the web server (service role) reads/writes
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tenant-assets', 'tenant-assets', false, 2097152, array['image/webp', 'image/png', 'image/jpeg'])
on conflict (id) do nothing;

-- operators may upload the ticket image (preview only; it is never sent to the printer)
create or replace function public.role_permissions(r public.org_role) returns text[]
language sql immutable set search_path = '' as $$
  select case r
    when 'owner' then array['org.manage','site.manage','user.manage','party.manage','pricing.manage','series.manage',
      'template.manage','ticket.image','print.route.manage','weighment.create','weighment.complete','weighment.manual_time','invoice.finalize','invoice.cancel',
      'invoice.read','payment.record','report.view','report.export','print.view','print.test','print.reprint','audit.view']
    when 'admin' then array['site.manage','user.manage','party.manage','pricing.manage','series.manage',
      'template.manage','ticket.image','print.route.manage','weighment.create','weighment.complete','weighment.manual_time','invoice.finalize','invoice.cancel',
      'invoice.read','payment.record','report.view','report.export','print.view','print.test','print.reprint','audit.view']
    when 'operator' then array['weighment.create','weighment.complete','weighment.manual_time','invoice.finalize','invoice.read','party.read','print.view','ticket.image']
    when 'accounts' then array['invoice.read','party.manage','payment.record','report.view','report.export','print.view']
    when 'remote_site' then array['invoice.read','print.view']
  end
$$;

-- price at each weighing -----------------------------------------------------------------------------
alter table public.weighments
  add column rate_at_gross numeric(14,2) check (rate_at_gross is null or rate_at_gross >= 0),
  add column rate_at_tare numeric(14,2) check (rate_at_tare is null or rate_at_tare >= 0);

drop function public.create_loaded_weighment(uuid, uuid, text, numeric, text, uuid, text, public.time_mode, timestamptz, text, text);
create function public.create_loaded_weighment(p_org uuid, p_site uuid, p_vehicle text, p_gross numeric, p_material text,
  p_party uuid, p_notes text, p_time_mode public.time_mode, p_at timestamptz, p_reason text, p_idem text, p_rate numeric default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.weighments; t timestamptz; norm text := regexp_replace(upper(p_vehicle), '[^A-Z0-9]', '', 'g');
begin
  perform public.assert_can(p_org, 'weighment.create', p_site);
  if p_idem is null or char_length(p_idem) < 8 then raise exception 'idempotency_key_required' using errcode = '22023'; end if;
  select * into r from public.weighments where organization_id = p_org and idempotency_key = p_idem;
  if found then return to_jsonb(r); end if;
  if norm = '' then raise exception 'vehicle_required' using errcode = '22023'; end if;
  if p_gross is null or p_gross <= 0 then raise exception 'invalid_weight' using errcode = '22023'; end if;
  if p_rate is not null and p_rate < 0 then raise exception 'invalid_rate' using errcode = '22023'; end if;
  t := public.resolve_time(p_org, p_time_mode, p_at, p_reason);
  insert into public.weighments (organization_id, site_id, vehicle_display, vehicle_normalized, party_id, material, notes,
    gross_weight_kg, gross_weight_at, gross_time_mode, gross_manual_reason, gross_entered_by, idempotency_key, rate_at_gross)
  values (p_org, p_site, btrim(p_vehicle), norm, p_party, nullif(btrim(p_material), ''), p_notes, round(p_gross, 3), t, p_time_mode,
    case when p_time_mode = 'manual' then p_reason end, (select auth.uid()), p_idem, round(p_rate, 2))
  returning * into r;
  perform public.write_audit(p_org, p_site, (select auth.uid()), 'weighment.create', 'weighment', r.id::text, p_reason,
    jsonb_build_object('time_mode', p_time_mode));
  return to_jsonb(r);
end $$;

drop function public.complete_empty_weighment(uuid, uuid, numeric, public.time_mode, timestamptz, text, int);
create function public.complete_empty_weighment(p_org uuid, p_weighment uuid, p_tare numeric, p_time_mode public.time_mode,
  p_at timestamptz, p_reason text, p_expected_version int, p_rate numeric default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.weighments; t timestamptz;
begin
  select * into w from public.weighments where id = p_weighment and organization_id = p_org for update;
  if not found then raise exception 'weighment_not_found' using errcode = 'P0002'; end if;
  perform public.assert_can(p_org, 'weighment.complete', w.site_id);
  if w.status <> 'pending_empty' then raise exception 'weighment_not_pending' using errcode = '23514'; end if;
  if p_expected_version is not null and p_expected_version <> w.version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if p_tare is null or p_tare < 0 then raise exception 'invalid_weight' using errcode = '22023'; end if;
  if round(p_tare, 3) > w.gross_weight_kg then raise exception 'tare_exceeds_gross' using errcode = '22023'; end if;
  if p_rate is not null and p_rate < 0 then raise exception 'invalid_rate' using errcode = '22023'; end if;
  t := public.resolve_time(p_org, p_time_mode, p_at, p_reason);
  update public.weighments set tare_weight_kg = round(p_tare, 3), tare_weight_at = t, tare_time_mode = p_time_mode,
    tare_manual_reason = case when p_time_mode = 'manual' then p_reason end, tare_recorded_at = now(),
    tare_entered_by = (select auth.uid()), net_weight_kg = gross_weight_kg - round(p_tare, 3),
    rate_at_tare = round(p_rate, 2),
    status = 'ready_to_invoice', version = version + 1 where id = w.id returning * into w;
  perform public.write_audit(p_org, w.site_id, (select auth.uid()), 'weighment.complete', 'weighment', w.id::text, p_reason,
    jsonb_build_object('time_mode', p_time_mode));
  return to_jsonb(w);
end $$;

-- finalize: p_rate NULL => use the last entry's price (second weighing, else first). A value overrides (audited).
create or replace function public.finalize_invoice(p_org uuid, p_weighment uuid, p_payment_mode public.payment_mode, p_party uuid,
  p_rate numeric, p_amount_paid numeric, p_notes text, p_idem text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.weighments; inv public.invoices; unit public.weight_unit; qty numeric; fee numeric; v_rate numeric;
  a record; party public.parties; paid numeric; uid uuid := (select auth.uid());
begin
  select * into w from public.weighments where id = p_weighment and organization_id = p_org for update;
  if not found then raise exception 'weighment_not_found' using errcode = 'P0002'; end if;
  perform public.assert_can(p_org, 'invoice.finalize', w.site_id);
  if p_idem is null or char_length(p_idem) < 8 then raise exception 'idempotency_key_required' using errcode = '22023'; end if;
  select * into inv from public.invoices where organization_id = p_org and (idempotency_key = p_idem or weighment_id = w.id);
  if found then return to_jsonb(inv); end if;
  if w.status <> 'ready_to_invoice' then raise exception 'weighment_not_ready' using errcode = '23514'; end if;

  select weight_unit into unit from public.pricing_settings where organization_id = p_org;
  if unit is null then raise exception 'weight_unit_not_set' using errcode = '55000'; end if;
  v_rate := coalesce(p_rate, w.rate_at_tare, w.rate_at_gross);
  if v_rate is null or v_rate < 0 then raise exception 'invalid_rate' using errcode = '22023'; end if;
  qty := case unit when 'tonne' then w.net_weight_kg / 1000 else w.net_weight_kg end;
  fee := round(qty * v_rate, 2);

  if p_payment_mode = 'credit' then
    select * into party from public.parties where id = p_party and organization_id = p_org and active;
    if not found then raise exception 'party_required_for_credit' using errcode = '22023'; end if;
  elsif p_party is not null then
    select * into party from public.parties where id = p_party and organization_id = p_org;
  end if;

  select * into a from public.allocate_invoice_number(p_org, w.site_id, now());

  insert into public.invoices (organization_id, site_id, weighment_id, series_id, period_key, seq_value, invoice_number, issued_by,
    payment_mode, party_id, party_name, party_snapshot, vehicle_display, material, notes,
    gross_weight_kg, gross_weight_at, tare_weight_kg, tare_weight_at, net_weight_kg, weight_unit, quantity, rate, fee_total, idempotency_key)
  values (p_org, w.site_id, w.id, a.o_series, a.o_period, a.o_seq, a.o_number, uid,
    p_payment_mode, party.id, party.display_name,
    case when party.id is null then '{}'::jsonb else jsonb_build_object('name', party.display_name, 'gstin', party.gstin, 'address', party.address, 'city', party.city) end,
    w.vehicle_display, w.material, coalesce(p_notes, w.notes),
    w.gross_weight_kg, w.gross_weight_at, w.tare_weight_kg, w.tare_weight_at, w.net_weight_kg, unit, round(qty, 3), round(v_rate, 2), fee, p_idem)
  returning * into inv;

  paid := case when p_payment_mode = 'cash' then fee else coalesce(p_amount_paid, 0) end;
  if paid < 0 or paid > fee then raise exception 'invalid_amount_paid' using errcode = '22023'; end if;
  if paid > 0 then
    insert into public.invoice_payments (organization_id, site_id, invoice_id, party_id, kind, amount, method, recorded_by)
    values (p_org, w.site_id, inv.id, inv.party_id, 'payment', paid, case when p_payment_mode = 'cash' then 'cash' else 'on_account' end, uid);
  end if;

  update public.weighments set status = 'invoiced', version = version + 1 where id = w.id;
  perform public.write_audit(p_org, w.site_id, uid, 'invoice.finalize', 'invoice', inv.id::text, null,
    jsonb_build_object('number', inv.invoice_number, 'mode', p_payment_mode, 'total', fee, 'rate', v_rate,
      'rate_source', case when p_rate is not null then 'override' when w.rate_at_tare is not null then 'second_entry' else 'first_entry' end));
  return to_jsonb(inv);
end $$;

revoke all on function public.create_loaded_weighment(uuid, uuid, text, numeric, text, uuid, text, public.time_mode, timestamptz, text, text, numeric) from public, anon;
grant execute on function public.create_loaded_weighment(uuid, uuid, text, numeric, text, uuid, text, public.time_mode, timestamptz, text, text, numeric) to authenticated;
revoke all on function public.complete_empty_weighment(uuid, uuid, numeric, public.time_mode, timestamptz, text, int, numeric) from public, anon;
grant execute on function public.complete_empty_weighment(uuid, uuid, numeric, public.time_mode, timestamptz, text, int, numeric) to authenticated;
