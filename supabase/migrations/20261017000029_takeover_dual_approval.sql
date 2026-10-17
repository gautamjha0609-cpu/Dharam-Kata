-- New printer PC for a site ("desktop change") needs TWO approvals (owner decision, 2026-10-17):
--   1. the firm: any signed-in user of the firm with access to that site (operator, owner or administrator), and
--   2. the platform administrator (admin panel).
-- Either side may approve first; the PC is switched over only when both have approved. Either side can reject.
-- Same desktop pairing again (also with another printer) stays automatic, as before. Printer change requests are unchanged.
-- Also: admin overview per firm (pairings, desktop changes, printer changes) from the audit log.

alter table public.print_agent_requests add column if not exists firm_approved_by uuid;
alter table public.print_agent_requests add column if not exists firm_approved_at timestamptz;
alter table public.print_agent_requests add column if not exists platform_approved_by uuid;
alter table public.print_agent_requests add column if not exists platform_approved_at timestamptz;
alter table public.print_agent_requests add column if not exists move_waiting boolean not null default false;
create index if not exists audit_logs_agent_actions_idx on public.audit_logs (organization_id, action)
  where action in ('agent.paired', 'agent.request_approved', 'printer.bind');

-- the switch-over itself (both approvals present)
create or replace function public.finish_takeover(p_request uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare r public.print_agent_requests; ag public.print_agents; moved int;
begin
  select * into r from public.print_agent_requests where id = p_request for update;
  select * into ag from public.print_agents where id = r.agent_id for update;
  update public.print_agent_requests set status = 'approved', decided_at = now(), decided_by = coalesce(r.platform_approved_by, r.firm_approved_by) where id = r.id;
  update public.print_agents set approval = 'approved' where id = ag.id;
  if r.printer_name is not null then perform public.set_agent_printer(ag.id, r.printer_name); end if;
  moved := public.retire_site_agents(r.site_id, ag.id, r.move_waiting);
  perform public.write_audit(r.organization_id, r.site_id, coalesce(r.platform_approved_by, r.firm_approved_by), 'agent.request_approved', 'agent', ag.id::text, null,
    jsonb_build_object('kind', 'takeover', 'printer', r.printer_name, 'moved_waiting', moved, 'firm_by', r.firm_approved_by, 'platform_by', r.platform_approved_by));
  return moved;
end $$;
revoke all on function public.finish_takeover(uuid) from public, anon, authenticated;

create or replace function public.reject_agent_request(p_request uuid, p_by uuid, p_side text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.print_agent_requests;
begin
  select * into r from public.print_agent_requests where id = p_request for update;
  update public.print_agent_requests set status = 'rejected', decided_by = p_by, decided_at = now() where id = r.id;
  if r.kind = 'takeover' then
    update public.print_agents set status = 'revoked', revoked_at = now(), approval = 'rejected' where id = r.agent_id;
    perform public.switch_off_agent_printers(r.agent_id);
  end if;
  perform public.write_audit(r.organization_id, r.site_id, p_by, 'agent.request_rejected', 'agent', r.agent_id::text, null,
    jsonb_build_object('kind', r.kind, 'printer', r.printer_name, 'side', p_side));
end $$;
revoke all on function public.reject_agent_request(uuid, uuid, text) from public, anon, authenticated;

-- Firm side. Takeover: any firm user with access to the site. Printer change: owner / administrator (as before).
create or replace function public.decide_agent_request(p_org uuid, p_request uuid, p_approve boolean, p_move_waiting boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.print_agent_requests; ag public.print_agents; moved int := 0; uid uuid := (select auth.uid());
begin
  select * into r from public.print_agent_requests where id = p_request and organization_id = p_org for update;
  if not found then raise exception 'request_not_found' using errcode = 'P0002'; end if;
  if r.status <> 'pending' then raise exception 'request_already_decided' using errcode = '23514'; end if;
  select * into ag from public.print_agents where id = r.agent_id;
  if ag.status <> 'active' then raise exception 'agent_not_found' using errcode = 'P0002'; end if;

  if r.kind = 'takeover' then
    if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
    if not public.is_org_member(p_org) or not public.has_site_access(p_org, r.site_id) then raise exception 'forbidden' using errcode = '42501'; end if;
    if not public.org_is_writable(p_org) then raise exception 'organization_not_writable' using errcode = '42501'; end if;
    if not p_approve then
      perform public.reject_agent_request(r.id, uid, 'firm');
      return jsonb_build_object('approved', false);
    end if;
    update public.print_agent_requests set firm_approved_by = uid, firm_approved_at = now(), move_waiting = coalesce(p_move_waiting, false) where id = r.id;
    perform public.write_audit(p_org, r.site_id, uid, 'agent.takeover_firm_approved', 'agent', ag.id::text, null, jsonb_build_object('printer', r.printer_name));
    if r.platform_approved_at is null then return jsonb_build_object('approved', false, 'waiting_for', 'platform'); end if;
    moved := public.finish_takeover(r.id);
    return jsonb_build_object('approved', true, 'moved', moved);
  end if;

  -- change_printer: owner / administrator
  perform public.assert_can(p_org, 'print.route.manage', r.site_id);
  if not p_approve then
    perform public.reject_agent_request(r.id, uid, 'firm');
    return jsonb_build_object('approved', false);
  end if;
  if r.printer_name is null then raise exception 'printer_required' using errcode = '22023'; end if;
  update public.print_agent_requests set status = 'approved', decided_by = uid, decided_at = now() where id = r.id;
  perform public.set_agent_printer(ag.id, r.printer_name);
  perform public.write_audit(p_org, r.site_id, uid, 'agent.request_approved', 'agent', ag.id::text, null, jsonb_build_object('kind', r.kind, 'printer', r.printer_name));
  return jsonb_build_object('approved', true, 'moved', 0);
end $$;
revoke all on function public.decide_agent_request(uuid, uuid, boolean, boolean) from public, anon;
grant execute on function public.decide_agent_request(uuid, uuid, boolean, boolean) to authenticated;

-- Firm side list: takeover requests for every firm user of the site; printer changes only for owner / administrator.
create or replace function public.list_agent_requests(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare mgr boolean := public.has_permission(p_org, 'print.route.manage');
begin
  if not public.is_org_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'printer', r.printer_name, 'requested_at', r.requested_at,
      'site_id', r.site_id, 'site', s.name, 'agent_id', a.id, 'pc', a.label, 'pc_last_seen', a.last_heartbeat_at,
      'firm_approved_at', r.firm_approved_at, 'platform_approved_at', r.platform_approved_at,
      'current_printer', (select pr.os_printer_name from public.printer_devices pr where pr.agent_id = a.id and pr.active order by pr.created_at desc limit 1),
      'old_pcs', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label, 'last_seen', o.last_heartbeat_at)), '[]'::jsonb)
                  from public.print_agents o where o.site_id = r.site_id and o.status = 'active' and o.approval = 'approved' and o.id <> a.id),
      'waiting', (select count(*) from public.print_jobs j join public.print_agents o on o.id = j.agent_id
                  where o.site_id = r.site_id and o.status = 'active' and o.id <> a.id and j.status = 'queued' and j.organization_id = p_org))
      order by r.requested_at)
    from public.print_agent_requests r join public.print_agents a on a.id = r.agent_id join public.sites s on s.id = r.site_id
    where r.organization_id = p_org and r.status = 'pending' and a.status = 'active'
      and public.has_site_access(p_org, r.site_id) and (r.kind = 'takeover' or mgr)), '[]'::jsonb);
end $$;
revoke all on function public.list_agent_requests(uuid) from public, anon;
grant execute on function public.list_agent_requests(uuid) to authenticated;

-- Platform admin: approve / reject a desktop change.
create or replace function public.admin_decide_agent_request(p_request uuid, p_approve boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.print_agent_requests; uid uuid := (select auth.uid()); moved int;
begin
  if not public.is_platform_admin(array['super_admin']::public.platform_role[]) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into r from public.print_agent_requests where id = p_request for update;
  if not found or r.kind <> 'takeover' then raise exception 'request_not_found' using errcode = 'P0002'; end if;
  if r.status <> 'pending' then raise exception 'request_already_decided' using errcode = '23514'; end if;
  if not p_approve then
    perform public.reject_agent_request(r.id, uid, 'platform');
    return jsonb_build_object('approved', false);
  end if;
  update public.print_agent_requests set platform_approved_by = uid, platform_approved_at = now() where id = r.id;
  perform public.write_audit(r.organization_id, r.site_id, uid, 'agent.takeover_platform_approved', 'agent', r.agent_id::text, null, jsonb_build_object('printer', r.printer_name));
  if r.firm_approved_at is null then return jsonb_build_object('approved', false, 'waiting_for', 'firm'); end if;
  moved := public.finish_takeover(r.id);
  return jsonb_build_object('approved', true, 'moved', moved);
end $$;
revoke all on function public.admin_decide_agent_request(uuid, boolean) from public, anon;
grant execute on function public.admin_decide_agent_request(uuid, boolean) to authenticated;

-- Platform admin: every firm's printer PCs, counts and open desktop-change requests (one call, aggregated in the database).
create or replace function public.admin_print_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'org_id', o.id, 'firm', o.display_name, 'slug', o.slug,
      'pairings', coalesce(st.pairings, 0), 'desktop_changes', coalesce(st.desktop_changes, 0), 'printer_changes', coalesce(st.printer_changes, 0),
      'last_pairing', st.last_pairing,
      'pcs', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'pc', a.label, 'site', s.name, 'version', a.app_version, 'last_seen', a.last_heartbeat_at,
                   'approval', a.approval,
                   'printer', (select pr.os_printer_name from public.printer_devices pr where pr.agent_id = a.id and pr.active order by pr.created_at desc limit 1))
                   order by s.name), '[]'::jsonb)
              from public.print_agents a join public.sites s on s.id = a.site_id where a.organization_id = o.id and a.status = 'active'),
      'requests', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'pc', a.label, 'site', s.name, 'printer', r.printer_name, 'requested_at', r.requested_at,
                   'firm_approved_at', r.firm_approved_at, 'platform_approved_at', r.platform_approved_at,
                   'old_pcs', (select coalesce(jsonb_agg(x.label), '[]'::jsonb) from public.print_agents x
                               where x.site_id = r.site_id and x.status = 'active' and x.approval = 'approved' and x.id <> a.id)) order by r.requested_at), '[]'::jsonb)
                   from public.print_agent_requests r join public.print_agents a on a.id = r.agent_id join public.sites s on s.id = r.site_id
                   where r.organization_id = o.id and r.status = 'pending' and r.kind = 'takeover' and a.status = 'active'))
      order by o.display_name)
    from public.organizations o
    left join lateral (
      select count(*) filter (where l.action = 'agent.paired') as pairings,
             count(*) filter (where l.action = 'agent.request_approved' and l.meta->>'kind' = 'takeover') as desktop_changes,
             count(*) filter (where (l.action = 'agent.request_approved' and l.meta->>'kind' = 'change_printer') or l.action = 'printer.bind'
                              or (l.action = 'agent.paired' and l.meta->>'printer_changed' = 'true')) as printer_changes,
             max(l.created_at) filter (where l.action = 'agent.paired') as last_pairing
      from public.audit_logs l
      where l.organization_id = o.id and l.action in ('agent.paired', 'agent.request_approved', 'printer.bind')
    ) st on true), '[]'::jsonb);
end $$;
revoke all on function public.admin_print_overview() from public, anon;
grant execute on function public.admin_print_overview() to authenticated;

-- Pairing records whether the same desktop came back with another printer (counted as a printer change).
create or replace function public.agent_pair(p_code text, p_label text, p_os text, p_machine text default null, p_printer text default null,
  out o_agent uuid, out o_token text, out o_org uuid, out o_site uuid, out o_approval text)
language plpgsql security definer set search_path = '' as $$
declare pc public.pairing_codes; tok text := encode(extensions.gen_random_bytes(32), 'hex'); old public.print_agents; others boolean; old_printer text;
  mach text := nullif(lower(btrim(coalesce(p_machine, ''))), ''); prn text := nullif(btrim(coalesce(p_printer, '')), '');
begin
  if mach is not null and mach !~ '^[0-9a-f]{64}$' then mach := null; end if;
  select * into pc from public.pairing_codes
   where code_hash = encode(extensions.digest(upper(btrim(p_code)), 'sha256'), 'hex') and used_at is null and expires_at > now() for update;
  if not found then raise exception 'invalid_or_expired_code' using errcode = '28000'; end if;
  update public.pairing_codes set used_at = now() where id = pc.id;
  o_org := pc.organization_id; o_site := pc.site_id;

  if mach is not null then
    select * into old from public.print_agents where organization_id = pc.organization_id and machine_id = mach order by created_at desc limit 1 for update;
    if found then
      select pr.os_printer_name into old_printer from public.printer_devices pr where pr.agent_id = old.id and pr.active order by pr.created_at desc limit 1;
      update public.print_jobs set status = 'cancelled', last_error_code = 'pc_paired_again'
       where agent_id in (select id from public.print_agents where organization_id = pc.organization_id and machine_id = mach and id <> old.id) and status = 'queued';
      perform public.switch_off_agent_printers(a.id) from public.print_agents a where a.organization_id = pc.organization_id and a.machine_id = mach and a.id <> old.id;
      update public.print_agents set status = 'revoked', revoked_at = now() where organization_id = pc.organization_id and machine_id = mach and id <> old.id and status = 'active';
    end if;
  end if;

  select exists (select 1 from public.print_agents a where a.site_id = pc.site_id and a.status = 'active' and a.approval = 'approved'
                 and (old.id is null or a.id <> old.id)) into others;

  if old.id is not null then
    if old.site_id <> pc.site_id then perform public.switch_off_agent_printers(old.id); end if;
    o_approval := case when old.status = 'active' and old.approval = 'approved' and old.site_id = pc.site_id then 'approved'
                       when others then 'pending' else 'approved' end;
    if o_approval = 'pending' and old.status = 'active' then
      update public.print_jobs set status = 'cancelled', last_error_code = 'pc_paired_again' where agent_id = old.id and status = 'queued';
      perform public.switch_off_agent_printers(old.id);
    end if;
    update public.print_agents set credential_hash = encode(extensions.digest(tok, 'sha256'), 'hex'), label = left(p_label, 80), os = left(p_os, 80),
      site_id = pc.site_id, status = 'active', revoked_at = null, approval = o_approval
     where id = old.id;
    o_agent := old.id;
  else
    o_approval := case when others then 'pending' else 'approved' end;
    insert into public.print_agents (organization_id, site_id, label, os, credential_hash, created_by, machine_id, approval)
    values (pc.organization_id, pc.site_id, left(p_label, 80), left(p_os, 80), encode(extensions.digest(tok, 'sha256'), 'hex'), pc.created_by, mach, o_approval)
    returning id into o_agent;
  end if;
  o_token := tok;

  update public.print_agent_requests set status = 'cancelled' where agent_id = o_agent and status = 'pending';
  if o_approval = 'pending' then
    insert into public.print_agent_requests (organization_id, site_id, agent_id, kind, printer_name) values (pc.organization_id, pc.site_id, o_agent, 'takeover', prn);
  elsif prn is not null then
    perform public.set_agent_printer(o_agent, prn);
  end if;
  perform public.write_audit(pc.organization_id, pc.site_id, pc.created_by, 'agent.paired', 'agent', o_agent::text, null,
    jsonb_build_object('approval', o_approval, 'repaired', old.id is not null, 'printer', prn,
                       'printer_changed', old.id is not null and prn is not null and old_printer is not null and prn <> old_printer));
end $$;
revoke all on function public.agent_pair(text, text, text, text, text) from public, anon, authenticated;
