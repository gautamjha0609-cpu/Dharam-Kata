-- Per-firm extra fields (driver name, challan no., destination ...). ----------------------------------------------
-- A firm defines up to 8 extra fields (keys x1..x8). They can be placed on the receipt like any built-in field, are
-- asked for in the New weighment form (first weight) or in the second-weight step, are stored on the weighment and
-- copied into the immutable invoice, and are sent to the print agent as ordinary typed text values.

create table public.custom_fields (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  key text not null check (key ~ '^x[1-8]$'),
  label_en text not null check (char_length(btrim(label_en)) between 1 and 40),
  label_hi text check (label_hi is null or char_length(label_hi) <= 40),
  kind text not null default 'text' check (kind in ('text', 'number')),
  required boolean not null default false,
  ask_at text not null default 'first' check (ask_at in ('first', 'second')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, key)
);
alter table public.custom_fields enable row level security;
create policy custom_fields_read on public.custom_fields for select to authenticated
  using (public.is_org_member(organization_id) or public.is_platform_admin());
grant select on public.custom_fields to authenticated;
revoke insert, update, delete, truncate on public.custom_fields from anon, authenticated;

alter table public.weighments add column extra jsonb not null default '{}'::jsonb;
alter table public.invoices add column extra jsonb not null default '{}'::jsonb;

-- manage definitions -------------------------------------------------------------------------------------------
-- p_key NULL = create the next free key. Fields are never deleted (invoices keep their values); they are deactivated.
create function public.save_custom_field(p_org uuid, p_key text, p_label_en text, p_label_hi text, p_kind text,
  p_required boolean, p_ask_at text, p_active boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text := p_key; r public.custom_fields;
begin
  perform public.assert_can(p_org, 'template.manage');
  if k is null then
    select 'x' || n into k from generate_series(1, 8) n
      where not exists (select 1 from public.custom_fields c where c.organization_id = p_org and c.key = 'x' || n) order by n limit 1;
    if k is null then raise exception 'custom_field_limit' using errcode = '54000'; end if;
    insert into public.custom_fields (organization_id, key, label_en, label_hi, kind, required, ask_at, active)
    values (p_org, k, btrim(p_label_en), nullif(btrim(p_label_hi), ''), coalesce(p_kind, 'text'), coalesce(p_required, false), coalesce(p_ask_at, 'first'), coalesce(p_active, true))
    returning * into r;
  else
    update public.custom_fields set label_en = btrim(p_label_en), label_hi = nullif(btrim(p_label_hi), ''), kind = coalesce(p_kind, kind),
      required = coalesce(p_required, required), ask_at = coalesce(p_ask_at, ask_at), active = coalesce(p_active, active)
      where organization_id = p_org and key = k returning * into r;
    if not found then raise exception 'custom_field_not_found' using errcode = 'P0002'; end if;
  end if;
  perform public.write_audit(p_org, null, (select auth.uid()), 'custom_field.save', 'custom_field', r.key, null,
    jsonb_build_object('label', r.label_en, 'kind', r.kind, 'ask_at', r.ask_at, 'active', r.active));
  return to_jsonb(r);
end $$;
revoke all on function public.save_custom_field(uuid, text, text, text, text, boolean, text, boolean) from public, anon;
grant execute on function public.save_custom_field(uuid, text, text, text, text, boolean, text, boolean) to authenticated;

-- validate + normalise submitted values: only the firm's own active keys, short text, numbers must be numeric ------
create function public.clean_extra(p_org uuid, p_extra jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare out jsonb := '{}'::jsonb; e record; d public.custom_fields; v text;
begin
  if p_extra is null or p_extra = 'null'::jsonb then return out; end if;
  if jsonb_typeof(p_extra) <> 'object' then raise exception 'invalid_extra' using errcode = '22023'; end if;
  for e in select key, value from jsonb_each(p_extra) loop
    select * into d from public.custom_fields where organization_id = p_org and key = e.key and active;
    if not found then raise exception 'unknown_custom_field' using errcode = '22023'; end if;
    if jsonb_typeof(e.value) not in ('string', 'number') then raise exception 'invalid_extra' using errcode = '22023'; end if;
    v := btrim(e.value #>> '{}');
    if v = '' then continue; end if;
    if char_length(v) > 100 or v ~ '[\x00-\x08\x0B\x0C\x0E-\x1F]' then raise exception 'invalid_extra' using errcode = '22023'; end if;
    if d.kind = 'number' and v !~ '^-?[0-9]+(\.[0-9]+)?$' then raise exception 'invalid_extra_number' using errcode = '22023'; end if;
    out := out || jsonb_build_object(e.key, v);
  end loop;
  return out;
end $$;
revoke all on function public.clean_extra(uuid, jsonb) from public, anon, authenticated;

-- first weight: accepts the extra values -------------------------------------------------------------------------
drop function public.create_loaded_weighment(uuid, uuid, text, numeric, text, uuid, text, public.time_mode, timestamptz, text, text, numeric);
create function public.create_loaded_weighment(p_org uuid, p_site uuid, p_vehicle text, p_gross numeric, p_material text,
  p_party uuid, p_notes text, p_time_mode public.time_mode, p_at timestamptz, p_reason text, p_idem text, p_rate numeric default null,
  p_extra jsonb default null)
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
    gross_weight_kg, gross_weight_at, gross_time_mode, gross_manual_reason, gross_entered_by, idempotency_key, rate_at_gross, extra)
  values (p_org, p_site, btrim(p_vehicle), norm, p_party, nullif(btrim(p_material), ''), p_notes, round(p_gross, 3), t, p_time_mode,
    case when p_time_mode = 'manual' then p_reason end, (select auth.uid()), p_idem, round(p_rate, 2), public.clean_extra(p_org, p_extra))
  returning * into r;
  perform public.write_audit(p_org, p_site, (select auth.uid()), 'weighment.create', 'weighment', r.id::text, p_reason,
    jsonb_build_object('time_mode', p_time_mode));
  return to_jsonb(r);
end $$;
revoke all on function public.create_loaded_weighment(uuid, uuid, text, numeric, text, uuid, text, public.time_mode, timestamptz, text, text, numeric, jsonb) from public, anon;
grant execute on function public.create_loaded_weighment(uuid, uuid, text, numeric, text, uuid, text, public.time_mode, timestamptz, text, text, numeric, jsonb) to authenticated;

-- second weight: merges more extra values (second-weight fields) --------------------------------------------------
drop function public.complete_empty_weighment(uuid, uuid, numeric, public.time_mode, timestamptz, text, int, numeric);
create function public.complete_empty_weighment(p_org uuid, p_weighment uuid, p_tare numeric, p_time_mode public.time_mode,
  p_at timestamptz, p_reason text, p_expected_version int, p_rate numeric default null, p_extra jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.weighments; t timestamptz; second numeric; uid uuid := (select auth.uid()); ex jsonb;
begin
  select * into w from public.weighments where id = p_weighment and organization_id = p_org for update;
  if not found then raise exception 'weighment_not_found' using errcode = 'P0002'; end if;
  perform public.assert_can(p_org, 'weighment.complete', w.site_id);
  if w.status <> 'pending_empty' then raise exception 'weighment_not_pending' using errcode = '23514'; end if;
  if p_expected_version is not null and p_expected_version <> w.version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if p_tare is null or p_tare <= 0 then raise exception 'invalid_weight' using errcode = '22023'; end if;
  second := round(p_tare, 3);
  if second = w.gross_weight_kg then raise exception 'weights_equal' using errcode = '22023'; end if;
  if p_rate is not null and p_rate < 0 then raise exception 'invalid_rate' using errcode = '22023'; end if;
  t := public.resolve_time(p_org, p_time_mode, p_at, p_reason);
  ex := w.extra || public.clean_extra(p_org, p_extra);

  if second < w.gross_weight_kg then
    update public.weighments set tare_weight_kg = second, tare_weight_at = t, tare_time_mode = p_time_mode,
      tare_manual_reason = case when p_time_mode = 'manual' then p_reason end, tare_recorded_at = now(), tare_entered_by = uid,
      net_weight_kg = gross_weight_kg - second, loaded_was = 'first', rate_at_tare = round(p_rate, 2), extra = ex,
      status = 'ready_to_invoice', version = version + 1 where id = w.id returning * into w;
  else
    update public.weighments set
      tare_weight_kg = w.gross_weight_kg, tare_weight_at = w.gross_weight_at, tare_time_mode = w.gross_time_mode,
      tare_manual_reason = w.gross_manual_reason, tare_recorded_at = w.gross_recorded_at, tare_entered_by = w.gross_entered_by,
      gross_weight_kg = second, gross_weight_at = t, gross_time_mode = p_time_mode,
      gross_manual_reason = case when p_time_mode = 'manual' then p_reason end, gross_recorded_at = now(), gross_entered_by = uid,
      net_weight_kg = second - w.gross_weight_kg, loaded_was = 'second', rate_at_tare = round(p_rate, 2), extra = ex,
      status = 'ready_to_invoice', version = version + 1 where id = w.id returning * into w;
  end if;
  perform public.write_audit(p_org, w.site_id, uid, 'weighment.complete', 'weighment', w.id::text, p_reason,
    jsonb_build_object('time_mode', p_time_mode, 'loaded_was', w.loaded_was));
  return to_jsonb(w);
end $$;
revoke all on function public.complete_empty_weighment(uuid, uuid, numeric, public.time_mode, timestamptz, text, int, numeric, jsonb) from public, anon;
grant execute on function public.complete_empty_weighment(uuid, uuid, numeric, public.time_mode, timestamptz, text, int, numeric, jsonb) to authenticated;

-- the invoice snapshot carries the extra values, and the print payload includes them ---------------------------------
-- (finalize_invoice itself is unchanged except that it copies w.extra: done by a trigger so the audited function stays as is)
create function public.copy_extra_to_invoice() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  select w.extra into new.extra from public.weighments w where w.id = new.weighment_id;
  new.extra := coalesce(new.extra, '{}'::jsonb);
  return new;
end $$;
create trigger invoices_copy_extra before insert on public.invoices for each row execute function public.copy_extra_to_invoice();

create or replace function public.build_print_values(inv public.invoices) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(inv.extra, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
    'serial', inv.invoice_number,
    'party', inv.party_name,
    'material', inv.material,
    'vehicle', inv.vehicle_display,
    'gross_weight', trim_scale(inv.gross_weight_kg)::text,
    'gross_date', to_char(inv.gross_weight_at at time zone o.timezone, 'DD/MM/YYYY'),
    'gross_time', to_char(inv.gross_weight_at at time zone o.timezone, 'HH24:MI'),
    'tare_weight', trim_scale(inv.tare_weight_kg)::text,
    'tare_date', to_char(inv.tare_weight_at at time zone o.timezone, 'DD/MM/YYYY'),
    'tare_time', to_char(inv.tare_weight_at at time zone o.timezone, 'HH24:MI'),
    'net_weight', trim_scale(inv.net_weight_kg)::text,
    'charge', trim_scale(inv.fee_total)::text,
    'payment_mode', inv.payment_mode::text,
    'notes', inv.notes))
  from public.organizations o where o.id = inv.organization_id
$$;
