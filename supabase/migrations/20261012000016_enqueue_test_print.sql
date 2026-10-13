-- A test print is a real job on the normal queue (printed by the Print Agent on the chosen printer), but it belongs to no invoice.
alter table public.print_jobs alter column invoice_id drop not null;

create function public.enqueue_test_print(p_org uuid, p_printer uuid, p_layout jsonb, p_values jsonb, p_idem text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pr record; v jsonb := '{}'::jsonb; e record; j uuid; uid uuid := (select auth.uid()); ex public.print_jobs;
begin
  select p.*, ag.status as agent_status into pr
    from public.printer_devices p join public.print_agents ag on ag.id = p.agent_id and ag.organization_id = p.organization_id
   where p.id = p_printer and p.organization_id = p_org;
  if not found then raise exception 'printer_not_found' using errcode = 'P0002'; end if;
  perform public.assert_can(p_org, 'print.test', pr.site_id);
  if p_idem is null or char_length(p_idem) < 8 then raise exception 'idempotency_key_required' using errcode = '22023'; end if;
  select * into ex from public.print_jobs where organization_id = p_org and idempotency_key = p_idem;
  if found then return jsonb_build_object('id', ex.id); end if;
  if not pr.active or pr.agent_status <> 'active' then raise exception 'printer_unavailable' using errcode = '55000'; end if;
  if p_layout is null or jsonb_typeof(p_layout) <> 'object' or length(p_layout::text) > 200000 then raise exception 'invalid_layout' using errcode = '22023'; end if;
  -- only plain short text values with simple names reach the agent
  for e in select key, value from jsonb_each(coalesce(p_values, '{}'::jsonb)) loop
    if e.key !~ '^[a-z][a-z0-9_]{0,30}$' or jsonb_typeof(e.value) <> 'string' or char_length(e.value #>> '{}') > 300 then continue; end if;
    v := v || jsonb_build_object(e.key, e.value);
  end loop;
  v := v || jsonb_build_object('_calibration', jsonb_build_object('x', pr.offset_x_mm, 'y', pr.offset_y_mm));
  insert into public.print_jobs (organization_id, invoice_id, origin_site_id, destination_site_id, printer_id, agent_id, job_type, status,
    idempotency_key, reprint_reason, requested_by, payload, template_snapshot)
  values (p_org, null, pr.site_id, pr.site_id, pr.id, pr.agent_id, 'test', 'queued', p_idem, 'Test print from the layout designer', uid, v, p_layout)
  returning id into j;
  insert into public.print_job_events (organization_id, job_id, status, actor_user_id) values (p_org, j, 'queued', uid);
  perform public.write_audit(p_org, pr.site_id, uid, 'print.test', 'print_job', j::text, null, jsonb_build_object('printer', pr.os_printer_name));
  return jsonb_build_object('id', j);
end $$;
revoke all on function public.enqueue_test_print(uuid, uuid, jsonb, jsonb, text) from public, anon;
grant execute on function public.enqueue_test_print(uuid, uuid, jsonb, jsonb, text) to authenticated;
