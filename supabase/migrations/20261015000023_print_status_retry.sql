-- Printing status + safe retry (print redesign, build step 2).
-- 1. Removing / revoking a printer PC also switches off its printers and routes, so the site never keeps a dead default
--    printer (that caused "Printer routing error" on new slips). Rows are kept for history.
-- 2. site_print_status: where a slip of this site prints now (printer, PC, online/offline) + slips that are not printed yet.
-- 3. retry_print_job: one-click "Print again" for a slip that never reached a printer (no double-print risk).

-- 1. ---------------------------------------------------------------------------------------------------------
create or replace function public.switch_off_agent_printers(p_agent uuid) returns void
language sql security definer set search_path = '' as $$
  update public.print_destinations pd set active = false, is_default = false
    from public.printer_devices pr where pr.id = pd.printer_id and pr.agent_id = p_agent and pd.active;
  update public.printer_devices set active = false where agent_id = p_agent and active;
$$;
revoke all on function public.switch_off_agent_printers(uuid) from public, anon, authenticated;

create or replace function public.revoke_agent(p_org uuid, p_agent uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare ag public.print_agents;
begin
  select * into ag from public.print_agents where id = p_agent and organization_id = p_org;
  if not found then raise exception 'agent_not_found' using errcode = 'P0002'; end if;
  perform public.assert_can(p_org, 'print.route.manage', ag.site_id);
  update public.print_agents set status = 'revoked', revoked_at = now() where id = ag.id;
  update public.print_jobs set status = 'cancelled' where agent_id = ag.id and status = 'queued';
  perform public.switch_off_agent_printers(ag.id);
  perform public.write_audit(p_org, ag.site_id, (select auth.uid()), 'agent.revoke', 'agent', ag.id::text);
end $$;

create or replace function public.remove_agent(p_org uuid, p_agent uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare ag public.print_agents;
begin
  select * into ag from public.print_agents where id = p_agent and organization_id = p_org for update;
  if not found then raise exception 'agent_not_found' using errcode = 'P0002'; end if;
  if public.has_permission(p_org, 'print.route.manage') then perform public.assert_can(p_org, 'print.route.manage', ag.site_id);
  else perform public.assert_can(p_org, 'agent.remove', ag.site_id); end if;
  if ag.status = 'revoked' then return; end if;
  update public.print_agents set status = 'revoked', revoked_at = now() where id = ag.id;
  update public.print_jobs set status = 'cancelled' where agent_id = ag.id and status = 'queued';
  perform public.switch_off_agent_printers(ag.id);
  perform public.write_audit(p_org, ag.site_id, (select auth.uid()), 'agent.remove', 'agent', ag.id::text);
end $$;

-- PCs removed before this change still have live routes: switch those off too.
select public.switch_off_agent_printers(id) from public.print_agents where status = 'revoked';

-- 2. ---------------------------------------------------------------------------------------------------------
-- The route a new slip of this site takes (same choice as enqueue_print_job).
create or replace function public.site_print_route(p_org uuid, p_site uuid)
returns table (printer_id uuid, printer_label text, os_printer_name text, printer_active boolean, offset_x_mm numeric, offset_y_mm numeric,
  dest_site uuid, agent_id uuid, agent_label text, agent_status public.agent_status, last_heartbeat_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select pr.id, pr.label, pr.os_printer_name, pr.active, pr.offset_x_mm, pr.offset_y_mm, pr.site_id, ag.id, ag.label, ag.status, ag.last_heartbeat_at
  from public.print_destinations pd
  join public.printer_devices pr on pr.id = pd.printer_id and pr.organization_id = pd.organization_id
  join public.print_agents ag on ag.id = pr.agent_id and ag.organization_id = pr.organization_id
  where pd.organization_id = p_org and pd.origin_site_id = p_site and pd.active
  order by pd.is_default desc, pd.created_at limit 1
$$;
revoke all on function public.site_print_route(uuid, uuid) from public, anon, authenticated;

create or replace function public.site_print_status(p_org uuid, p_site uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r record; waiting jsonb;
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not public.has_permission(p_org, 'print.view') or not public.has_site_access(p_org, p_site) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into r from public.site_print_route(p_org, p_site);
  -- the latest slip of each invoice (last 24 h) that has not reached a printer: waiting 2+ minutes, failed or without a route
  select coalesce(jsonb_agg(jsonb_build_object('job_id', j.id, 'invoice_id', j.invoice_id, 'invoice_number', i.invoice_number,
           'vehicle', i.vehicle_display, 'status', j.status, 'error', j.last_error_code, 'queued_at', j.queued_at) order by j.queued_at desc), '[]'::jsonb)
    into waiting
  from public.print_jobs j join public.invoices i on i.id = j.invoice_id and i.organization_id = j.organization_id
  where j.organization_id = p_org and j.origin_site_id = p_site and j.job_type <> 'test' and i.status = 'issued'
    and j.queued_at > now() - interval '24 hours'
    and (j.status in ('failed', 'routing_error', 'not_configured') or (j.status = 'queued' and j.queued_at < now() - interval '2 minutes'))
    and not exists (select 1 from public.print_jobs n where n.invoice_id = j.invoice_id and n.organization_id = j.organization_id
                    and n.job_type <> 'test' and n.queued_at > j.queued_at);
  return jsonb_build_object(
    'printer', case when r.printer_id is null then null else jsonb_build_object(
      'id', r.printer_id, 'label', r.printer_label, 'os_name', r.os_printer_name, 'active', r.printer_active,
      'pc', r.agent_label, 'pc_active', r.agent_status = 'active', 'last_seen', r.last_heartbeat_at,
      'online', r.agent_status = 'active' and r.last_heartbeat_at > now() - interval '90 seconds') end,
    'waiting', waiting, 'now', now());
end $$;
revoke all on function public.site_print_status(uuid, uuid) from public, anon;
grant execute on function public.site_print_status(uuid, uuid) to authenticated;

-- 3. ---------------------------------------------------------------------------------------------------------
-- "Print again" for a slip that never reached a printer. Allowed to anyone who may make entries at that site.
-- Prints exactly the same slip (same values and layout) on the site's current printer. A slip that may already
-- be on paper (picked up, sent, unknown) is refused: that needs a reprint with a reason.
create or replace function public.retry_print_job(p_org uuid, p_job uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare j public.print_jobs; r record; st public.print_status := 'queued'; v_job uuid; inv_status public.invoice_status;
begin
  select * into j from public.print_jobs where id = p_job and organization_id = p_org for update;
  if not found or j.job_type = 'test' then raise exception 'print_job_not_found' using errcode = 'P0002'; end if;
  if public.has_permission(p_org, 'print.reprint') then perform public.assert_can(p_org, 'print.reprint', j.origin_site_id);
  else perform public.assert_can(p_org, 'weighment.create', j.origin_site_id); end if;
  select status into inv_status from public.invoices where id = j.invoice_id and organization_id = p_org;
  if inv_status is distinct from 'issued' then raise exception 'invoice_not_issued' using errcode = '23514'; end if;
  if exists (select 1 from public.print_jobs n where n.invoice_id = j.invoice_id and n.organization_id = p_org and n.job_type <> 'test' and n.queued_at > j.queued_at) then
    raise exception 'print_job_superseded' using errcode = '23514';
  end if;
  if j.status = 'queued' then
    if j.queued_at > now() - interval '2 minutes' then raise exception 'print_job_still_waiting' using errcode = '23514'; end if;
    -- still not picked up: take it back so the old PC can never print it as well
    update public.print_jobs set status = 'cancelled', last_error_code = 'replaced_by_retry' where id = j.id and status = 'queued';
    insert into public.print_job_events (organization_id, job_id, status, actor_user_id, error_code) values (p_org, j.id, 'cancelled', (select auth.uid()), 'replaced_by_retry');
  elsif j.status not in ('failed', 'routing_error', 'not_configured') then
    raise exception 'print_job_may_have_printed' using errcode = '23514';
  end if;

  select * into r from public.site_print_route(p_org, j.origin_site_id);
  if r.printer_id is null then st := 'not_configured';
  elsif not r.printer_active or r.agent_status <> 'active' then st := 'routing_error';
  end if;
  insert into public.print_jobs (organization_id, invoice_id, origin_site_id, destination_site_id, printer_id, agent_id, job_type, status,
    idempotency_key, reprint_reason, requested_by, payload, template_version_id, template_snapshot)
  values (p_org, j.invoice_id, j.origin_site_id, r.dest_site,
    case when st = 'queued' then r.printer_id end, case when st = 'queued' then r.agent_id end,
    j.job_type, st, 'retry:' || gen_random_uuid()::text, j.reprint_reason, (select auth.uid()),
    j.payload || jsonb_build_object('_calibration', jsonb_build_object('x', coalesce(r.offset_x_mm, 0), 'y', coalesce(r.offset_y_mm, 0))),
    j.template_version_id, j.template_snapshot)
  returning id into v_job;
  insert into public.print_job_events (organization_id, job_id, status, actor_user_id) values (p_org, v_job, st, (select auth.uid()));
  perform public.write_audit(p_org, j.origin_site_id, (select auth.uid()), 'print.retry', 'invoice', j.invoice_id::text, null, jsonb_build_object('old_job', j.id, 'new_job', v_job));
  return v_job;
end $$;
revoke all on function public.retry_print_job(uuid, uuid) from public, anon;
grant execute on function public.retry_print_job(uuid, uuid) to authenticated;
