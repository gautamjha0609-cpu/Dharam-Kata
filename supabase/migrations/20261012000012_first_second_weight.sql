-- A vehicle can be weighed loaded-first OR empty-first. The operator enters a FIRST and a SECOND weight; the heavier
-- one is the loaded (gross) weight and the lighter one the empty (tare) weight. Stored columns keep their meaning
-- (gross = heavier, tare = lighter) once the weighment is completed; before completion gross_* holds the first weight.
-- Price columns rate_at_gross / rate_at_tare keep meaning "first entry" / "second entry" (the last entry still wins).

alter table public.weighments add column loaded_was text check (loaded_was in ('first', 'second'));

create or replace function public.complete_empty_weighment(p_org uuid, p_weighment uuid, p_tare numeric, p_time_mode public.time_mode,
  p_at timestamptz, p_reason text, p_expected_version int, p_rate numeric default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.weighments; t timestamptz; second numeric; uid uuid := (select auth.uid());
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

  if second < w.gross_weight_kg then
    -- first weighing was the loaded one
    update public.weighments set tare_weight_kg = second, tare_weight_at = t, tare_time_mode = p_time_mode,
      tare_manual_reason = case when p_time_mode = 'manual' then p_reason end, tare_recorded_at = now(), tare_entered_by = uid,
      net_weight_kg = gross_weight_kg - second, loaded_was = 'first', rate_at_tare = round(p_rate, 2),
      status = 'ready_to_invoice', version = version + 1 where id = w.id returning * into w;
  else
    -- first weighing was the EMPTY one: swap so that gross = heavier (second), tare = lighter (first)
    update public.weighments set
      tare_weight_kg = w.gross_weight_kg, tare_weight_at = w.gross_weight_at, tare_time_mode = w.gross_time_mode,
      tare_manual_reason = w.gross_manual_reason, tare_recorded_at = w.gross_recorded_at, tare_entered_by = w.gross_entered_by,
      gross_weight_kg = second, gross_weight_at = t, gross_time_mode = p_time_mode,
      gross_manual_reason = case when p_time_mode = 'manual' then p_reason end, gross_recorded_at = now(), gross_entered_by = uid,
      net_weight_kg = second - w.gross_weight_kg, loaded_was = 'second', rate_at_tare = round(p_rate, 2),
      status = 'ready_to_invoice', version = version + 1 where id = w.id returning * into w;
  end if;
  perform public.write_audit(p_org, w.site_id, uid, 'weighment.complete', 'weighment', w.id::text, p_reason,
    jsonb_build_object('time_mode', p_time_mode, 'loaded_was', w.loaded_was));
  return to_jsonb(w);
end $$;
