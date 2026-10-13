-- One form, two visits. -------------------------------------------------------------------------------------------
-- A vehicle's FIRST weighing "opens" an entry: it gets its invoice number and a receipt is printed straight away.
-- When the vehicle comes back, the SAME entry is "closed": second weight (heavier = loaded, lighter = empty), the final
-- amount, and a second receipt with the SAME invoice number. If instead the vehicle arrives for a brand-new job while an
-- entry is still open, the operator can replace the open one: it is cancelled (number kept, never reused) and a new
-- entry with a new invoice number is opened.
-- The amount is a flat figure typed by the operator (not rate x weight). The LAST amount entered is the sale amount.

alter table public.invoices
  alter column tare_weight_kg drop not null,
  alter column tare_weight_at drop not null,
  alter column net_weight_kg drop not null,
  add column stage text not null default 'closed' check (stage in ('open', 'closed')),
  add column closed_at timestamptz,
  add column close_idempotency_key text;
create unique index invoices_close_idem on public.invoices (organization_id, close_idempotency_key) where close_idempotency_key is not null;

-- An OPEN invoice may still be completed (only through the SECURITY DEFINER functions below: clients have no UPDATE grant).
-- A closed invoice stays immutable except for the cancellation fields.
create or replace function public.invoice_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'invoices cannot be deleted'; end if;
  if old.stage = 'open' and old.status = 'issued' then return new; end if;
  if (to_jsonb(new) - 'status' - 'cancel_reason' - 'cancelled_at' - 'cancelled_by')
     is distinct from (to_jsonb(old) - 'status' - 'cancel_reason' - 'cancelled_at' - 'cancelled_by') then
    raise exception 'issued invoice values are immutable';
  end if;
  return new;
end $$;

-- Print payload: an opening slip carries only the first weight (printed under the Loaded heading, which the renderer
-- relabels "First weight" because `stage` = open); a closing slip carries loaded / empty / net.
create or replace function public.build_print_values(inv public.invoices) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(inv.extra, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
    'serial', inv.invoice_number,
    'stage', case when inv.stage = 'open' then 'open' end,
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

-- keep the payments ledger equal to what should have been received (append-only: differences become payment / reversal rows)
create function public.sync_entry_payment(p_inv public.invoices, p_target numeric, p_uid uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare paid numeric;
begin
  select coalesce(sum(amount), 0) into paid from public.invoice_payments where invoice_id = p_inv.id and organization_id = p_inv.organization_id;
  if p_target > paid then
    insert into public.invoice_payments (organization_id, site_id, invoice_id, party_id, kind, amount, method, recorded_by)
    values (p_inv.organization_id, p_inv.site_id, p_inv.id, p_inv.party_id, 'payment', p_target - paid,
      case when p_inv.payment_mode = 'cash' then 'cash' else 'on_account' end, p_uid);
  elsif p_target < paid then
    insert into public.invoice_payments (organization_id, site_id, invoice_id, party_id, kind, amount, method, reason, recorded_by)
    values (p_inv.organization_id, p_inv.site_id, p_inv.id, p_inv.party_id, 'reversal', p_target - paid, 'reversal', 'Amount or payment mode changed', p_uid);
  end if;
end $$;
revoke all on function public.sync_entry_payment(public.invoices, numeric, uuid) from public, anon, authenticated;

-- look up the open entries of a vehicle (called when the operator presses "Check vehicle") --------------------------
create function public.find_open_entry(p_org uuid, p_site uuid, p_vehicle text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare norm text := regexp_replace(upper(coalesce(p_vehicle, '')), '[^A-Z0-9]', '', 'g');
begin
  if not (public.has_permission(p_org, 'weighment.create') or public.has_permission(p_org, 'weighment.complete')) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if norm = '' then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'weighment_id', w.id, 'version', w.version, 'site_id', w.site_id, 'vehicle', w.vehicle_display,
      'first_weight_kg', w.gross_weight_kg, 'first_at', w.gross_weight_at,
      'invoice_id', i.id, 'invoice_number', i.invoice_number, 'amount', i.fee_total, 'payment_mode', i.payment_mode,
      'party_id', i.party_id, 'party_name', i.party_name, 'material', w.material, 'notes', w.notes, 'extra', w.extra) order by w.created_at desc)
    from public.weighments w
    join public.invoices i on i.weighment_id = w.id and i.organization_id = w.organization_id and i.status = 'issued' and i.stage = 'open'
    where w.organization_id = p_org and w.vehicle_normalized = norm and w.status = 'pending_empty'
      and public.has_site_access(p_org, w.site_id)), '[]'::jsonb);
end $$;
revoke all on function public.find_open_entry(uuid, uuid, text) from public, anon;
grant execute on function public.find_open_entry(uuid, uuid, text) to authenticated;

-- OPEN: first weighing --------------------------------------------------------------------------------------------
create function public.open_entry(p_org uuid, p_site uuid, p_vehicle text, p_weight numeric, p_amount numeric,
  p_payment_mode public.payment_mode, p_party uuid, p_material text, p_notes text, p_extra jsonb,
  p_time_mode public.time_mode, p_at timestamptz, p_reason text, p_idem text,
  p_replace_open boolean default false, p_amount_paid numeric default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.weighments; inv public.invoices; o record; a record; t timestamptz; unit public.weight_unit; party public.parties;
  uid uuid := (select auth.uid()); norm text := regexp_replace(upper(coalesce(p_vehicle, '')), '[^A-Z0-9]', '', 'g'); n int := 0;
begin
  perform public.assert_can(p_org, 'weighment.create', p_site);
  if p_idem is null or char_length(p_idem) < 8 then raise exception 'idempotency_key_required' using errcode = '22023'; end if;
  select * into w from public.weighments where organization_id = p_org and idempotency_key = p_idem;
  if found then
    select * into inv from public.invoices where weighment_id = w.id;
    return jsonb_build_object('weighment', to_jsonb(w), 'invoice', to_jsonb(inv));
  end if;
  if norm = '' then raise exception 'vehicle_required' using errcode = '22023'; end if;
  if p_weight is null or p_weight <= 0 then raise exception 'invalid_weight' using errcode = '22023'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;
  select weight_unit into unit from public.pricing_settings where organization_id = p_org;
  if unit is null then raise exception 'weight_unit_not_set' using errcode = '55000'; end if;
  if p_payment_mode = 'credit' then
    select * into party from public.parties where id = p_party and organization_id = p_org and active;
    if not found then raise exception 'party_required_for_credit' using errcode = '22023'; end if;
  elsif p_party is not null then
    select * into party from public.parties where id = p_party and organization_id = p_org;
  end if;

  -- an entry for this vehicle is still open: the operator must say what to do
  for o in select w2.id, w2.site_id from public.weighments w2
    where w2.organization_id = p_org and w2.vehicle_normalized = norm and w2.status = 'pending_empty' for update loop
    n := n + 1;
    if not p_replace_open then raise exception 'open_entry_exists' using errcode = '23505'; end if;
    perform public.assert_can(p_org, 'weighment.create', o.site_id);
    update public.weighments set status = 'voided', version = version + 1 where id = o.id;
    declare oi public.invoices; paid numeric; begin
      select * into oi from public.invoices where weighment_id = o.id for update;
      if found and oi.status = 'issued' then
        select coalesce(sum(amount), 0) into paid from public.invoice_payments where invoice_id = oi.id;
        if paid > 0 then
          insert into public.invoice_payments (organization_id, site_id, invoice_id, party_id, kind, amount, method, reason, recorded_by)
          values (p_org, oi.site_id, oi.id, oi.party_id, 'reversal', -paid, 'reversal', 'Replaced by a new opening', uid);
        end if;
        update public.invoices set status = 'cancelled', cancel_reason = 'Replaced by a new opening', cancelled_at = now(), cancelled_by = uid where id = oi.id;
        perform public.write_audit(p_org, oi.site_id, uid, 'entry.replace', 'invoice', oi.id::text, 'Replaced by a new opening',
          jsonb_build_object('number', oi.invoice_number));
      end if;
    end;
  end loop;

  t := public.resolve_time(p_org, p_time_mode, p_at, p_reason);
  insert into public.weighments (organization_id, site_id, vehicle_display, vehicle_normalized, party_id, material, notes,
    gross_weight_kg, gross_weight_at, gross_time_mode, gross_manual_reason, gross_entered_by, idempotency_key, rate_at_gross, extra)
  values (p_org, p_site, btrim(p_vehicle), norm, party.id, nullif(btrim(p_material), ''), nullif(btrim(p_notes), ''), round(p_weight, 3), t, p_time_mode,
    case when p_time_mode = 'manual' then p_reason end, uid, p_idem, round(p_amount, 2), public.clean_extra(p_org, p_extra))
  returning * into w;

  select * into a from public.allocate_invoice_number(p_org, p_site, now());
  insert into public.invoices (organization_id, site_id, weighment_id, series_id, period_key, seq_value, invoice_number, issued_by, stage,
    payment_mode, party_id, party_name, party_snapshot, vehicle_display, material, notes,
    gross_weight_kg, gross_weight_at, weight_unit, quantity, rate, fee_total, idempotency_key)
  values (p_org, p_site, w.id, a.o_series, a.o_period, a.o_seq, a.o_number, uid, 'open',
    p_payment_mode, party.id, party.display_name,
    case when party.id is null then '{}'::jsonb else jsonb_build_object('name', party.display_name, 'gstin', party.gstin, 'address', party.address, 'city', party.city) end,
    w.vehicle_display, w.material, w.notes,
    w.gross_weight_kg, w.gross_weight_at, unit, 0, round(p_amount, 2), round(p_amount, 2), p_idem)
  returning * into inv;

  perform public.sync_entry_payment(inv, case when p_payment_mode = 'cash' then inv.fee_total else least(coalesce(p_amount_paid, 0), inv.fee_total) end, uid);
  perform public.write_audit(p_org, p_site, uid, 'entry.open', 'invoice', inv.id::text, p_reason,
    jsonb_build_object('number', inv.invoice_number, 'amount', inv.fee_total, 'replaced_open', n));
  return jsonb_build_object('weighment', to_jsonb(w), 'invoice', to_jsonb(inv));
end $$;
revoke all on function public.open_entry(uuid, uuid, text, numeric, numeric, public.payment_mode, uuid, text, text, jsonb, public.time_mode, timestamptz, text, text, boolean, numeric) from public, anon;
grant execute on function public.open_entry(uuid, uuid, text, numeric, numeric, public.payment_mode, uuid, text, text, jsonb, public.time_mode, timestamptz, text, text, boolean, numeric) to authenticated;

-- CLOSE: second weighing -------------------------------------------------------------------------------------------
create function public.close_entry(p_org uuid, p_weighment uuid, p_weight numeric, p_amount numeric,
  p_payment_mode public.payment_mode, p_party uuid, p_material text, p_notes text, p_extra jsonb,
  p_time_mode public.time_mode, p_at timestamptz, p_reason text, p_expected_version int, p_idem text,
  p_amount_paid numeric default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.weighments; inv public.invoices; party public.parties; t timestamptz; second numeric; first numeric; ex jsonb := '{}'::jsonb; k text;
  g numeric; g_at timestamptz; g_mode public.time_mode; g_reason text; g_rec timestamptz; g_by uuid;
  tr numeric; tr_at timestamptz; tr_mode public.time_mode; tr_reason text; tr_rec timestamptz; tr_by uuid; loaded text;
  uid uuid := (select auth.uid()); target numeric; was_credit boolean; paid numeric; qty numeric;
begin
  select * into w from public.weighments where id = p_weighment and organization_id = p_org for update;
  if not found then raise exception 'weighment_not_found' using errcode = 'P0002'; end if;
  perform public.assert_can(p_org, 'weighment.complete', w.site_id);
  if p_idem is null or char_length(p_idem) < 8 then raise exception 'idempotency_key_required' using errcode = '22023'; end if;
  select * into inv from public.invoices where weighment_id = w.id and organization_id = p_org for update;
  if not found then raise exception 'invoice_not_found' using errcode = 'P0002'; end if;
  if inv.close_idempotency_key = p_idem then return jsonb_build_object('weighment', to_jsonb(w), 'invoice', to_jsonb(inv)); end if;
  if w.status <> 'pending_empty' or inv.stage <> 'open' or inv.status <> 'issued' then raise exception 'weighment_not_pending' using errcode = '23514'; end if;
  if p_expected_version is not null and p_expected_version <> w.version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if p_weight is null or p_weight <= 0 then raise exception 'invalid_weight' using errcode = '22023'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'invalid_amount' using errcode = '22023'; end if;
  second := round(p_weight, 3); first := w.gross_weight_kg;
  if second = first then raise exception 'weights_equal' using errcode = '22023'; end if;
  if p_payment_mode = 'credit' then
    select * into party from public.parties where id = p_party and organization_id = p_org and active;
    if not found then raise exception 'party_required_for_credit' using errcode = '22023'; end if;
  elsif p_party is not null then
    select * into party from public.parties where id = p_party and organization_id = p_org;
  end if;
  t := public.resolve_time(p_org, p_time_mode, p_at, p_reason);

  -- extra values: what the form sent replaces the stored value of the same key (an empty value clears it)
  ex := w.extra;
  if p_extra is not null and jsonb_typeof(p_extra) = 'object' then
    for k in select jsonb_object_keys(p_extra) loop ex := ex - k; end loop;
    ex := ex || public.clean_extra(p_org, p_extra);
  end if;

  -- the heavier weighing is the LOADED (gross) weight, the lighter the EMPTY (tare) weight
  if second < first then
    g := first; g_at := w.gross_weight_at; g_mode := w.gross_time_mode; g_reason := w.gross_manual_reason; g_rec := w.gross_recorded_at; g_by := w.gross_entered_by;
    tr := second; tr_at := t; tr_mode := p_time_mode; tr_reason := case when p_time_mode = 'manual' then p_reason end; tr_rec := now(); tr_by := uid; loaded := 'first';
  else
    g := second; g_at := t; g_mode := p_time_mode; g_reason := case when p_time_mode = 'manual' then p_reason end; g_rec := now(); g_by := uid;
    tr := first; tr_at := w.gross_weight_at; tr_mode := w.gross_time_mode; tr_reason := w.gross_manual_reason; tr_rec := w.gross_recorded_at; tr_by := w.gross_entered_by; loaded := 'second';
  end if;

  update public.weighments set
    gross_weight_kg = g, gross_weight_at = g_at, gross_time_mode = g_mode, gross_manual_reason = g_reason, gross_recorded_at = g_rec, gross_entered_by = g_by,
    tare_weight_kg = tr, tare_weight_at = tr_at, tare_time_mode = tr_mode, tare_manual_reason = tr_reason, tare_recorded_at = tr_rec, tare_entered_by = tr_by,
    net_weight_kg = g - tr, loaded_was = loaded, rate_at_tare = round(p_amount, 2), extra = ex,
    party_id = party.id, material = nullif(btrim(p_material), ''), notes = nullif(btrim(p_notes), ''),
    status = 'invoiced', version = version + 1
  where id = w.id returning * into w;

  qty := case inv.weight_unit when 'tonne' then w.net_weight_kg / 1000 else w.net_weight_kg end;
  was_credit := inv.payment_mode = 'credit';
  select coalesce(sum(amount), 0) into paid from public.invoice_payments where invoice_id = inv.id;
  update public.invoices set stage = 'closed', closed_at = now(), close_idempotency_key = p_idem,
    payment_mode = p_payment_mode, party_id = party.id, party_name = party.display_name,
    party_snapshot = case when party.id is null then '{}'::jsonb else jsonb_build_object('name', party.display_name, 'gstin', party.gstin, 'address', party.address, 'city', party.city) end,
    material = w.material, notes = w.notes, extra = ex,
    gross_weight_kg = w.gross_weight_kg, gross_weight_at = w.gross_weight_at, tare_weight_kg = w.tare_weight_kg, tare_weight_at = w.tare_weight_at,
    net_weight_kg = w.net_weight_kg, quantity = round(qty, 3), rate = round(p_amount, 2), fee_total = round(p_amount, 2)
  where id = inv.id returning * into inv;

  target := case when p_payment_mode = 'cash' then inv.fee_total
    else least(coalesce(p_amount_paid, case when was_credit then paid else 0 end), inv.fee_total) end;
  perform public.sync_entry_payment(inv, target, uid);
  perform public.enqueue_print_job(inv, 'original', null, uid, 'close:' || inv.id::text);
  perform public.write_audit(p_org, w.site_id, uid, 'entry.close', 'invoice', inv.id::text, p_reason,
    jsonb_build_object('number', inv.invoice_number, 'amount', inv.fee_total, 'loaded_was', loaded, 'opening_amount', w.rate_at_gross));
  return jsonb_build_object('weighment', to_jsonb(w), 'invoice', to_jsonb(inv));
end $$;
revoke all on function public.close_entry(uuid, uuid, numeric, numeric, public.payment_mode, uuid, text, text, jsonb, public.time_mode, timestamptz, text, int, text, numeric) from public, anon;
grant execute on function public.close_entry(uuid, uuid, numeric, numeric, public.payment_mode, uuid, text, text, jsonb, public.time_mode, timestamptz, text, int, text, numeric) to authenticated;

-- the three older two-step functions are replaced by open_entry / close_entry; they must not be called any more
revoke execute on function public.create_loaded_weighment(uuid, uuid, text, numeric, text, uuid, text, public.time_mode, timestamptz, text, text, numeric, jsonb) from authenticated;
revoke execute on function public.complete_empty_weighment(uuid, uuid, numeric, public.time_mode, timestamptz, text, int, numeric, jsonb) from authenticated;
revoke execute on function public.finalize_invoice(uuid, uuid, public.payment_mode, uuid, numeric, numeric, text, text) from authenticated;

-- the print job of the closing slip is a normal 'original' job; its idempotency key (close:<invoice>) differs from the opening one.
