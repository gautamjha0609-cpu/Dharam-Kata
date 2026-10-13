-- Core weighment -> invoice domain (SRS sections 5, 6, A3). All writes go through RPCs.

create type public.weight_unit as enum ('kg', 'tonne');
create type public.weighment_status as enum ('pending_empty', 'ready_to_invoice', 'invoiced', 'voided');
create type public.time_mode as enum ('automatic', 'manual');
create type public.payment_mode as enum ('cash', 'credit');
create type public.invoice_status as enum ('issued', 'cancelled');
create type public.party_type as enum ('debtor', 'vendor', 'both', 'customer');
create type public.series_reset as enum ('none', 'fiscal_year');

-- operators may use manual time by default (reason required + audited); tenants can revoke via permissions.
create or replace function public.role_permissions(r public.org_role) returns text[]
language sql immutable set search_path = '' as $$
  select case r
    when 'owner' then array['org.manage','site.manage','user.manage','party.manage','pricing.manage','series.manage',
      'template.manage','print.route.manage','weighment.create','weighment.complete','weighment.manual_time','invoice.finalize','invoice.cancel',
      'invoice.read','payment.record','report.view','report.export','print.view','print.test','print.reprint','audit.view']
    when 'admin' then array['site.manage','user.manage','party.manage','pricing.manage','series.manage',
      'template.manage','print.route.manage','weighment.create','weighment.complete','weighment.manual_time','invoice.finalize','invoice.cancel',
      'invoice.read','payment.record','report.view','report.export','print.view','print.test','print.reprint','audit.view']
    when 'operator' then array['weighment.create','weighment.complete','weighment.manual_time','invoice.finalize','invoice.read','party.read','print.view']
    when 'accounts' then array['invoice.read','party.manage','payment.record','report.view','report.export','print.view']
    when 'remote_site' then array['invoice.read','print.view']
  end
$$;

-- tenant billing settings: unit is fixed once, rate is entered per invoice ------------------------
create table public.pricing_settings (
  organization_id uuid primary key references public.organizations (id) on delete restrict,
  weight_unit public.weight_unit,            -- null until the operator/admin fixes it
  default_rate numeric(14,2) check (default_rate is null or default_rate >= 0),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table public.parties (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  party_code text,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 200),
  normalized_name text not null,
  party_type public.party_type not null default 'debtor',
  gstin text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  pan text check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  address text, city text, state text, pin text,
  contact_person text, phone text, email text,
  active boolean not null default true,
  created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, normalized_name)
);
create trigger parties_updated before update on public.parties for each row execute function public.set_updated_at();
create index parties_search_idx on public.parties (organization_id, normalized_name text_pattern_ops);

create table public.invoice_series (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  site_id uuid,
  prefix text not null default '' check (char_length(prefix) <= 40),
  start_number bigint not null check (start_number >= 0),
  next_number bigint not null check (next_number >= 0),
  padding_width int not null default 0 check (padding_width between 0 and 12),
  reset_policy public.series_reset not null default 'none',
  period_key text not null default '',
  active boolean not null default true,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key (site_id, organization_id) references public.sites (id, organization_id),
  unique (id, organization_id)
);
create unique index invoice_series_scope_key on public.invoice_series
  (organization_id, coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid), period_key);

create table public.weighments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  site_id uuid not null,
  vehicle_display text not null check (char_length(btrim(vehicle_display)) between 1 and 40),
  vehicle_normalized text not null,
  party_id uuid,
  material text, notes text,
  status public.weighment_status not null default 'pending_empty',
  gross_weight_kg numeric(12,3) not null check (gross_weight_kg >= 0),
  gross_weight_at timestamptz not null,
  gross_time_mode public.time_mode not null default 'automatic',
  gross_manual_reason text,
  gross_recorded_at timestamptz not null default now(),
  gross_entered_by uuid not null,
  tare_weight_kg numeric(12,3) check (tare_weight_kg is null or tare_weight_kg >= 0),
  tare_weight_at timestamptz,
  tare_time_mode public.time_mode,
  tare_manual_reason text,
  tare_recorded_at timestamptz,
  tare_entered_by uuid,
  net_weight_kg numeric(12,3),
  idempotency_key text not null,
  version int not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key (site_id, organization_id) references public.sites (id, organization_id),
  foreign key (party_id, organization_id) references public.parties (id, organization_id),
  unique (id, organization_id),
  unique (organization_id, idempotency_key),
  check (status = 'pending_empty' or tare_weight_kg is not null or status = 'voided'),
  check (tare_weight_kg is null or tare_weight_kg <= gross_weight_kg),
  check (gross_time_mode = 'automatic' or char_length(btrim(coalesce(gross_manual_reason, ''))) > 0),
  check (tare_time_mode is distinct from 'manual' or char_length(btrim(coalesce(tare_manual_reason, ''))) > 0)
);
create trigger weighments_updated before update on public.weighments for each row execute function public.set_updated_at();
create index weighments_queue_idx on public.weighments (organization_id, site_id, status, created_at desc);
create index weighments_vehicle_idx on public.weighments (organization_id, vehicle_normalized, status);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  site_id uuid not null,
  weighment_id uuid not null,
  series_id uuid not null,
  period_key text not null default '',
  seq_value bigint not null,
  invoice_number text not null,
  status public.invoice_status not null default 'issued',
  issued_at timestamptz not null default now(),
  issued_by uuid not null,
  payment_mode public.payment_mode not null,
  party_id uuid,
  party_name text,                          -- immutable snapshot
  party_snapshot jsonb not null default '{}'::jsonb,
  vehicle_display text not null,
  material text, notes text,
  gross_weight_kg numeric(12,3) not null, gross_weight_at timestamptz not null,
  tare_weight_kg numeric(12,3) not null,  tare_weight_at timestamptz not null,
  net_weight_kg numeric(12,3) not null,
  weight_unit public.weight_unit not null,
  quantity numeric(14,3) not null,          -- net in billing unit
  rate numeric(14,2) not null check (rate >= 0),
  fee_total numeric(14,2) not null check (fee_total >= 0),
  currency text not null default 'INR',
  idempotency_key text not null,
  cancel_reason text, cancelled_at timestamptz, cancelled_by uuid,
  created_at timestamptz not null default now(),
  foreign key (site_id, organization_id) references public.sites (id, organization_id),
  foreign key (weighment_id, organization_id) references public.weighments (id, organization_id),
  foreign key (series_id, organization_id) references public.invoice_series (id, organization_id),
  foreign key (party_id, organization_id) references public.parties (id, organization_id),
  unique (id, organization_id),
  unique (weighment_id),
  unique (organization_id, invoice_number),
  unique (organization_id, idempotency_key),
  check (payment_mode = 'cash' or party_id is not null)
);
create index invoices_issued_idx on public.invoices (organization_id, issued_at desc);
create index invoices_party_idx on public.invoices (organization_id, party_id, issued_at desc);

create table public.invoice_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  site_id uuid not null,
  invoice_id uuid not null,
  party_id uuid,
  kind text not null check (kind in ('payment', 'reversal')),
  amount numeric(14,2) not null,
  method text not null default 'cash',
  reference text,
  reason text,
  occurred_at timestamptz not null default now(),
  recorded_at timestamptz not null default now(),
  recorded_by uuid not null,
  foreign key (invoice_id, organization_id) references public.invoices (id, organization_id),
  check ((kind = 'payment' and amount > 0) or (kind = 'reversal' and amount < 0))
);
create index invoice_payments_invoice_idx on public.invoice_payments (organization_id, invoice_id);

create function public.immutable_row() returns trigger language plpgsql set search_path = '' as $$
begin raise exception '% is append-only', tg_table_name; end $$;
create trigger payments_append_only before update or delete on public.invoice_payments for each row execute function public.immutable_row();

-- Issued invoices are immutable except for the cancellation fields.
create function public.invoice_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'invoices cannot be deleted'; end if;
  if (to_jsonb(new) - 'status' - 'cancel_reason' - 'cancelled_at' - 'cancelled_by')
     is distinct from (to_jsonb(old) - 'status' - 'cancel_reason' - 'cancelled_at' - 'cancelled_by') then
    raise exception 'issued invoice values are immutable';
  end if;
  return new;
end $$;
create trigger invoices_guard before update or delete on public.invoices for each row execute function public.invoice_guard();

create view public.invoice_balances with (security_invoker = true) as
select i.id as invoice_id, i.organization_id,
  i.fee_total,
  coalesce(sum(p.amount), 0)::numeric(14,2) as amount_paid,
  case when i.status = 'cancelled' then 0 else (i.fee_total - coalesce(sum(p.amount), 0)) end::numeric(14,2) as outstanding
from public.invoices i left join public.invoice_payments p on p.invoice_id = i.id and p.organization_id = i.organization_id
group by i.id;

-- RLS ---------------------------------------------------------------------------------------------
alter table public.pricing_settings enable row level security;
alter table public.parties enable row level security;
alter table public.invoice_series enable row level security;
alter table public.weighments enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_payments enable row level security;

create policy pricing_read on public.pricing_settings for select to authenticated using (public.is_org_member(organization_id));
create policy parties_read on public.parties for select to authenticated
  using (public.has_permission(organization_id, 'party.read') or public.has_permission(organization_id, 'party.manage'));
create policy series_read on public.invoice_series for select to authenticated
  using (public.has_permission(organization_id, 'series.manage') or public.has_permission(organization_id, 'weighment.create'));
create policy weighments_read on public.weighments for select to authenticated
  using (public.has_site_access(organization_id, site_id)
    and (public.has_permission(organization_id, 'weighment.create') or public.has_permission(organization_id, 'weighment.complete')
         or public.has_permission(organization_id, 'invoice.read')));
create policy invoices_read on public.invoices for select to authenticated
  using (public.has_site_access(organization_id, site_id) and public.has_permission(organization_id, 'invoice.read'));
create policy payments_read on public.invoice_payments for select to authenticated
  using (public.has_site_access(organization_id, site_id) and public.has_permission(organization_id, 'invoice.read'));

revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;
revoke all on all tables in schema public from anon;
grant select on public.invoice_balances to authenticated;

-- RPCs --------------------------------------------------------------------------------------------
create function public.assert_can(p_org uuid, p_perm text, p_site uuid default null) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not public.has_permission(p_org, p_perm) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_site is not null and not public.has_site_access(p_org, p_site) then raise exception 'forbidden_site' using errcode = '42501'; end if;
  if not public.org_is_writable(p_org) then raise exception 'organization_not_writable' using errcode = '42501'; end if;
end $$;
revoke all on function public.assert_can(uuid, text, uuid) from public, anon, authenticated;

-- resolve business time: automatic = server clock; manual needs permission, reason, and no future time.
create function public.resolve_time(p_org uuid, p_mode public.time_mode, p_at timestamptz, p_reason text)
returns timestamptz language plpgsql stable security definer set search_path = '' as $$
begin
  if p_mode = 'automatic' then return clock_timestamp(); end if;
  if not public.has_permission(p_org, 'weighment.manual_time') then raise exception 'manual_time_forbidden' using errcode = '42501'; end if;
  if p_at is null then raise exception 'manual_time_required' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'manual_reason_required' using errcode = '22023'; end if;
  if p_at > clock_timestamp() + interval '5 minutes' then raise exception 'manual_time_in_future' using errcode = '22023'; end if;
  return p_at;
end $$;
revoke all on function public.resolve_time(uuid, public.time_mode, timestamptz, text) from public, anon, authenticated;

create function public.set_weight_unit(p_org uuid, p_unit public.weight_unit) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cur public.weight_unit;
begin
  perform public.assert_can(p_org, 'pricing.manage');
  select weight_unit into cur from public.pricing_settings where organization_id = p_org;
  if cur is distinct from p_unit and exists (select 1 from public.invoices where organization_id = p_org) then
    raise exception 'unit_locked_after_first_invoice' using errcode = '23514';
  end if;
  insert into public.pricing_settings (organization_id, weight_unit, updated_by) values (p_org, p_unit, (select auth.uid()))
  on conflict (organization_id) do update set weight_unit = excluded.weight_unit, updated_by = excluded.updated_by, updated_at = now();
  perform public.write_audit(p_org, null, (select auth.uid()), 'pricing.unit_set', 'pricing_settings', p_org::text, null, jsonb_build_object('unit', p_unit));
  return jsonb_build_object('weight_unit', p_unit);
end $$;

create function public.upsert_party(p_org uuid, p_id uuid, p_name text, p_type public.party_type default 'debtor',
  p_gstin text default null, p_pan text default null, p_address text default null, p_city text default null,
  p_state text default null, p_pin text default null, p_contact text default null, p_phone text default null, p_email text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.parties; n text := regexp_replace(upper(btrim(p_name)), '\s+', ' ', 'g');
begin
  perform public.assert_can(p_org, 'party.manage');
  if p_id is null then
    insert into public.parties (organization_id, display_name, normalized_name, party_type, gstin, pan, address, city, state, pin, contact_person, phone, email, created_by)
    values (p_org, btrim(p_name), n, p_type, nullif(upper(btrim(p_gstin)), ''), nullif(upper(btrim(p_pan)), ''), p_address, p_city, p_state, p_pin, p_contact, p_phone, p_email, (select auth.uid()))
    returning * into r;
  else
    update public.parties set display_name = btrim(p_name), normalized_name = n, party_type = p_type,
      gstin = nullif(upper(btrim(p_gstin)), ''), pan = nullif(upper(btrim(p_pan)), ''), address = p_address, city = p_city,
      state = p_state, pin = p_pin, contact_person = p_contact, phone = p_phone, email = p_email
    where id = p_id and organization_id = p_org returning * into r;
    if not found then raise exception 'party_not_found' using errcode = 'P0002'; end if;
  end if;
  perform public.write_audit(p_org, null, (select auth.uid()), case when p_id is null then 'party.create' else 'party.update' end, 'party', r.id::text);
  return to_jsonb(r);
exception when unique_violation then raise exception 'party_name_exists' using errcode = '23505';
end $$;

create function public.initialize_invoice_series(p_org uuid, p_site uuid, p_prefix text, p_start bigint, p_padding int,
  p_reset public.series_reset default 'none') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.invoice_series; last_used bigint;
begin
  perform public.assert_can(p_org, 'series.manage', p_site);
  select * into s from public.invoice_series
   where organization_id = p_org and site_id is not distinct from p_site and period_key = '' for update;
  if not found then
    insert into public.invoice_series (organization_id, site_id, prefix, start_number, next_number, padding_width, reset_policy, created_by, updated_by)
    values (p_org, p_site, coalesce(p_prefix, ''), p_start, p_start, p_padding, p_reset, (select auth.uid()), (select auth.uid()))
    returning * into s;
    perform public.write_audit(p_org, p_site, (select auth.uid()), 'series.initialize', 'invoice_series', s.id::text, null,
      jsonb_build_object('prefix', p_prefix, 'start', p_start, 'padding', p_padding, 'reset', p_reset));
  else
    -- changing after invoices exist may never reuse an issued number
    select max(seq_value) into last_used from public.invoices where series_id = s.id;
    if last_used is not null and p_start <= last_used and p_reset = s.reset_policy and p_start <> s.start_number then
      raise exception 'series_would_reuse_numbers' using errcode = '23514';
    end if;
    update public.invoice_series set prefix = coalesce(p_prefix, ''), padding_width = p_padding, reset_policy = p_reset,
      start_number = p_start, next_number = case when last_used is null then p_start else greatest(next_number, p_start) end,
      updated_by = (select auth.uid()) where id = s.id returning * into s;
    perform public.write_audit(p_org, p_site, (select auth.uid()), 'series.change', 'invoice_series', s.id::text, null,
      jsonb_build_object('prefix', p_prefix, 'start', p_start, 'padding', p_padding, 'reset', p_reset, 'had_invoices', last_used is not null));
  end if;
  return to_jsonb(s);
end $$;

create function public.create_loaded_weighment(p_org uuid, p_site uuid, p_vehicle text, p_gross numeric, p_material text,
  p_party uuid, p_notes text, p_time_mode public.time_mode, p_at timestamptz, p_reason text, p_idem text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.weighments; t timestamptz; norm text := regexp_replace(upper(p_vehicle), '[^A-Z0-9]', '', 'g');
begin
  perform public.assert_can(p_org, 'weighment.create', p_site);
  if p_idem is null or char_length(p_idem) < 8 then raise exception 'idempotency_key_required' using errcode = '22023'; end if;
  select * into r from public.weighments where organization_id = p_org and idempotency_key = p_idem;
  if found then return to_jsonb(r); end if;
  if norm = '' then raise exception 'vehicle_required' using errcode = '22023'; end if;
  if p_gross is null or p_gross <= 0 then raise exception 'invalid_weight' using errcode = '22023'; end if;
  t := public.resolve_time(p_org, p_time_mode, p_at, p_reason);
  insert into public.weighments (organization_id, site_id, vehicle_display, vehicle_normalized, party_id, material, notes,
    gross_weight_kg, gross_weight_at, gross_time_mode, gross_manual_reason, gross_entered_by, idempotency_key)
  values (p_org, p_site, btrim(p_vehicle), norm, p_party, nullif(btrim(p_material), ''), p_notes, round(p_gross, 3), t, p_time_mode,
    case when p_time_mode = 'manual' then p_reason end, (select auth.uid()), p_idem)
  returning * into r;
  perform public.write_audit(p_org, p_site, (select auth.uid()), 'weighment.create', 'weighment', r.id::text, p_reason,
    jsonb_build_object('time_mode', p_time_mode));
  return to_jsonb(r);
end $$;

create function public.complete_empty_weighment(p_org uuid, p_weighment uuid, p_tare numeric, p_time_mode public.time_mode,
  p_at timestamptz, p_reason text, p_expected_version int) returns jsonb
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
  t := public.resolve_time(p_org, p_time_mode, p_at, p_reason);
  update public.weighments set tare_weight_kg = round(p_tare, 3), tare_weight_at = t, tare_time_mode = p_time_mode,
    tare_manual_reason = case when p_time_mode = 'manual' then p_reason end, tare_recorded_at = now(),
    tare_entered_by = (select auth.uid()), net_weight_kg = gross_weight_kg - round(p_tare, 3),
    status = 'ready_to_invoice', version = version + 1 where id = w.id returning * into w;
  perform public.write_audit(p_org, w.site_id, (select auth.uid()), 'weighment.complete', 'weighment', w.id::text, p_reason,
    jsonb_build_object('time_mode', p_time_mode));
  return to_jsonb(w);
end $$;

create function public.allocate_invoice_number(p_org uuid, p_site uuid, p_at timestamptz,
  out o_series uuid, out o_period text, out o_seq bigint, out o_number text)
language plpgsql security definer set search_path = '' as $$
declare base public.invoice_series; s public.invoice_series; tz text; loc timestamp; y int; pk text := '';
begin
  select * into base from public.invoice_series
   where organization_id = p_org and site_id = p_site and period_key = '' and active;
  if not found then
    select * into base from public.invoice_series
     where organization_id = p_org and site_id is null and period_key = '' and active;
  end if;
  if not found then raise exception 'series_not_initialized' using errcode = '55000'; end if;

  if base.reset_policy = 'fiscal_year' then
    select timezone into tz from public.organizations where id = p_org;
    loc := p_at at time zone tz; y := extract(year from loc)::int;
    pk := case when extract(month from loc) >= 4 then lpad((y % 100)::text, 2, '0') || '-' || lpad(((y + 1) % 100)::text, 2, '0')
               else lpad(((y - 1) % 100)::text, 2, '0') || '-' || lpad((y % 100)::text, 2, '0') end;
    insert into public.invoice_series (organization_id, site_id, prefix, start_number, next_number, padding_width, reset_policy, period_key, created_by, updated_by)
    values (p_org, base.site_id, base.prefix, base.start_number, base.start_number, base.padding_width, base.reset_policy, pk, base.created_by, base.updated_by)
    on conflict do nothing;
    select * into s from public.invoice_series
     where organization_id = p_org and site_id is not distinct from base.site_id and period_key = pk for update;
  else
    select * into s from public.invoice_series where id = base.id for update;
  end if;
  -- the row lock above serialises concurrent finalizations; no MAX()+1 anywhere
  update public.invoice_series set next_number = next_number + 1 where id = s.id;
  o_series := s.id; o_period := pk; o_seq := s.next_number;
  o_number := replace(s.prefix, '{FY}', pk) || lpad(s.next_number::text, s.padding_width, '0');
end $$;
revoke all on function public.allocate_invoice_number(uuid, uuid, timestamptz) from public, anon, authenticated;

create function public.finalize_invoice(p_org uuid, p_weighment uuid, p_payment_mode public.payment_mode, p_party uuid,
  p_rate numeric, p_amount_paid numeric, p_notes text, p_idem text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.weighments; inv public.invoices; unit public.weight_unit; qty numeric; fee numeric;
  a record; party public.parties; paid numeric; uid uuid := (select auth.uid());
begin
  select * into w from public.weighments where id = p_weighment and organization_id = p_org for update;
  if not found then raise exception 'weighment_not_found' using errcode = 'P0002'; end if;
  perform public.assert_can(p_org, 'invoice.finalize', w.site_id);
  if p_idem is null or char_length(p_idem) < 8 then raise exception 'idempotency_key_required' using errcode = '22023'; end if;
  -- idempotent retry: same key or already invoiced returns the original invoice, never a second number
  select * into inv from public.invoices where organization_id = p_org and (idempotency_key = p_idem or weighment_id = w.id);
  if found then return to_jsonb(inv); end if;
  if w.status <> 'ready_to_invoice' then raise exception 'weighment_not_ready' using errcode = '23514'; end if;

  select weight_unit into unit from public.pricing_settings where organization_id = p_org;
  if unit is null then raise exception 'weight_unit_not_set' using errcode = '55000'; end if;
  if p_rate is null or p_rate < 0 then raise exception 'invalid_rate' using errcode = '22023'; end if;
  qty := case unit when 'tonne' then w.net_weight_kg / 1000 else w.net_weight_kg end;
  fee := round(qty * p_rate, 2);  -- numeric, half away from zero == half-up for non-negative money

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
    w.gross_weight_kg, w.gross_weight_at, w.tare_weight_kg, w.tare_weight_at, w.net_weight_kg, unit, round(qty, 3), round(p_rate, 2), fee, p_idem)
  returning * into inv;

  paid := case when p_payment_mode = 'cash' then fee else coalesce(p_amount_paid, 0) end;
  if paid < 0 or paid > fee then raise exception 'invalid_amount_paid' using errcode = '22023'; end if;
  if paid > 0 then
    insert into public.invoice_payments (organization_id, site_id, invoice_id, party_id, kind, amount, method, recorded_by)
    values (p_org, w.site_id, inv.id, inv.party_id, 'payment', paid, case when p_payment_mode = 'cash' then 'cash' else 'on_account' end, uid);
  end if;

  update public.weighments set status = 'invoiced', version = version + 1 where id = w.id;
  perform public.write_audit(p_org, w.site_id, uid, 'invoice.finalize', 'invoice', inv.id::text, null,
    jsonb_build_object('number', inv.invoice_number, 'mode', p_payment_mode, 'total', fee));
  return to_jsonb(inv);
end $$;

create function public.post_collection(p_org uuid, p_invoice uuid, p_amount numeric, p_method text, p_reference text, p_occurred_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare inv public.invoices; out_amt numeric; p public.invoice_payments;
begin
  select * into inv from public.invoices where id = p_invoice and organization_id = p_org for update;
  if not found then raise exception 'invoice_not_found' using errcode = 'P0002'; end if;
  perform public.assert_can(p_org, 'payment.record', inv.site_id);
  if inv.status <> 'issued' then raise exception 'invoice_not_issued' using errcode = '23514'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;
  select outstanding into out_amt from public.invoice_balances where invoice_id = inv.id;
  if round(p_amount, 2) > out_amt then raise exception 'amount_exceeds_outstanding' using errcode = '22023'; end if;
  insert into public.invoice_payments (organization_id, site_id, invoice_id, party_id, kind, amount, method, reference, occurred_at, recorded_by)
  values (p_org, inv.site_id, inv.id, inv.party_id, 'payment', round(p_amount, 2), coalesce(p_method, 'cash'), p_reference,
    coalesce(p_occurred_at, now()), (select auth.uid())) returning * into p;
  perform public.write_audit(p_org, inv.site_id, (select auth.uid()), 'payment.record', 'invoice', inv.id::text, null,
    jsonb_build_object('amount', p.amount, 'method', p.method));
  return to_jsonb(p);
end $$;

create function public.cancel_invoice(p_org uuid, p_invoice uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare inv public.invoices; paid numeric; uid uuid := (select auth.uid());
begin
  select * into inv from public.invoices where id = p_invoice and organization_id = p_org for update;
  if not found then raise exception 'invoice_not_found' using errcode = 'P0002'; end if;
  perform public.assert_can(p_org, 'invoice.cancel', inv.site_id);
  if char_length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required' using errcode = '22023'; end if;
  if inv.status <> 'issued' then raise exception 'invoice_not_issued' using errcode = '23514'; end if;
  select coalesce(sum(amount), 0) into paid from public.invoice_payments where invoice_id = inv.id;
  if paid > 0 then
    insert into public.invoice_payments (organization_id, site_id, invoice_id, party_id, kind, amount, method, reason, recorded_by)
    values (p_org, inv.site_id, inv.id, inv.party_id, 'reversal', -paid, 'reversal', p_reason, uid);
  end if;
  -- the number is never recycled: the row stays, status flips
  update public.invoices set status = 'cancelled', cancel_reason = p_reason, cancelled_at = now(), cancelled_by = uid where id = inv.id returning * into inv;
  perform public.write_audit(p_org, inv.site_id, uid, 'invoice.cancel', 'invoice', inv.id::text, p_reason, jsonb_build_object('number', inv.invoice_number, 'reversed', paid));
  return to_jsonb(inv);
end $$;

do $$ declare f text; begin
  foreach f in array array[
    'set_weight_unit(uuid, public.weight_unit)',
    'upsert_party(uuid, uuid, text, public.party_type, text, text, text, text, text, text, text, text, text)',
    'initialize_invoice_series(uuid, uuid, text, bigint, int, public.series_reset)',
    'create_loaded_weighment(uuid, uuid, text, numeric, text, uuid, text, public.time_mode, timestamptz, text, text)',
    'complete_empty_weighment(uuid, uuid, numeric, public.time_mode, timestamptz, text, int)',
    'finalize_invoice(uuid, uuid, public.payment_mode, uuid, numeric, numeric, text, text)',
    'post_collection(uuid, uuid, numeric, text, text, timestamptz)',
    'cancel_invoice(uuid, uuid, text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
