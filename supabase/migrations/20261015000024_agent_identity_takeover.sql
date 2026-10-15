-- Print redesign, build step 3: one printer PC per site, owner-approved takeover and printer change.
-- * The agent sends a stable machine id. Pairing the same PC again reuses its row (new credential): no duplicates, calibration kept.
-- * One active (approved) PC per site. A new PC pairs as "pending" and prints nothing until an owner / administrator approves it on the
--   website; then the old PC is removed (rows kept for history) and its printers and routes are switched off.
-- * The PC's printer is chosen in the agent (first run). Changing it later needs approval on the website.
-- Agents 0.1.4 (no machine id, no printer choice) keep printing unchanged until they are updated.

alter table public.print_agents add column if not exists machine_id text check (machine_id is null or machine_id ~ '^[0-9a-f]{64}$');
alter table public.print_agents add column if not exists approval text not null default 'approved' check (approval in ('approved', 'pending', 'rejected'));
create index if not exists print_agents_machine_idx on public.print_agents (organization_id, machine_id) where machine_id is not null;

create table if not exists public.print_agent_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  site_id uuid not null,
  agent_id uuid not null,
  kind text not null check (kind in ('takeover', 'change_printer')),
  printer_name text check (printer_name is null or char_length(printer_name) between 1 and 200),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_at timestamptz not null default now(),
  decided_by uuid, decided_at timestamptz,
  foreign key (agent_id, organization_id) references public.print_agents (id, organization_id),
  foreign key (site_id, organization_id) references public.sites (id, organization_id)
);
create index if not exists print_agent_requests_open_idx on public.print_agent_requests (organization_id, status) where status = 'pending';
alter table public.print_agent_requests enable row level security;
drop policy if exists agent_requests_read on public.print_agent_requests;
create policy agent_requests_read on public.print_agent_requests for select to authenticated
  using (public.has_permission(organization_id, 'print.route.manage'));
revoke all on public.print_agent_requests from anon;
grant select on public.print_agent_requests to authenticated;

-- Makes `p_printer` THE printer of this PC: one active printer per PC, the site's default route, calibration of a printer seen before is kept.
create or replace function public.set_agent_printer(p_agent uuid, p_printer text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare ag public.print_agents; pr public.printer_devices;
begin
  select * into ag from public.print_agents where id = p_agent;
  insert into public.printer_devices (organization_id, site_id, agent_id, label, os_printer_name)
  values (ag.organization_id, ag.site_id, ag.id, left(p_printer, 200), p_printer)
  on conflict (agent_id, os_printer_name) do update set active = true, site_id = excluded.site_id
  returning * into pr;
  -- the PC's other printers stop receiving slips
  update public.print_destinations pd set active = false, is_default = false
    from public.printer_devices o where o.id = pd.printer_id and o.agent_id = ag.id and o.id <> pr.id and pd.active;
  update public.printer_devices set active = false where agent_id = ag.id and id <> pr.id and active;
  update public.print_destinations set is_default = false where organization_id = ag.organization_id and origin_site_id = ag.site_id and printer_id <> pr.id;
  insert into public.print_destinations (organization_id, origin_site_id, printer_id, is_default)
  values (ag.organization_id, ag.site_id, pr.id, true) on conflict (origin_site_id, printer_id) do update set is_default = true, active = true;
  return pr.id;
end $$;
revoke all on function public.set_agent_printer(uuid, text) from public, anon, authenticated;

-- Removes every other PC of the site. Their queued slips are moved to `p_new` (when asked) or cancelled.
create or replace function public.retire_site_agents(p_site uuid, p_keep uuid, p_move_waiting boolean) returns int
language plpgsql security definer set search_path = '' as $$
declare ag record; moved int := 0; n int; pr uuid;
begin
  select id into pr from public.printer_devices where agent_id = p_keep and active order by created_at desc limit 1;
  for ag in select id from public.print_agents where site_id = p_site and id <> p_keep and status = 'active' for update loop
    if p_move_waiting and pr is not null then
      update public.print_jobs set agent_id = p_keep, printer_id = pr where agent_id = ag.id and status = 'queued';
      get diagnostics n = row_count; moved := moved + n;
    end if;
    update public.print_jobs set status = 'cancelled', last_error_code = 'pc_replaced' where agent_id = ag.id and status = 'queued';
    update public.print_agents set status = 'revoked', revoked_at = now() where id = ag.id;
    update public.print_agent_requests set status = 'cancelled' where agent_id = ag.id and status = 'pending';
    perform public.switch_off_agent_printers(ag.id);
  end loop;
  return moved;
end $$;
revoke all on function public.retire_site_agents(uuid, uuid, boolean) from public, anon, authenticated;

-- Pairing. Same machine (same firm) => its existing row gets the new credential. Another approved PC already at the site => pending.
drop function if exists public.agent_pair(text, text, text);
create or replace function public.agent_pair(p_code text, p_label text, p_os text, p_machine text default null, p_printer text default null,
  out o_agent uuid, out o_token text, out o_org uuid, out o_site uuid, out o_approval text)
language plpgsql security definer set search_path = '' as $$
declare pc public.pairing_codes; tok text := encode(extensions.gen_random_bytes(32), 'hex'); old public.print_agents; others boolean;
  mach text := nullif(lower(btrim(coalesce(p_machine, ''))), ''); prn text := nullif(btrim(coalesce(p_printer, '')), '');
begin
  if mach is not null and mach !~ '^[0-9a-f]{64}$' then mach := null; end if;
  select * into pc from public.pairing_codes
   where code_hash = encode(extensions.digest(upper(btrim(p_code)), 'sha256'), 'hex') and used_at is null and expires_at > now() for update;
  if not found then raise exception 'invalid_or_expired_code' using errcode = '28000'; end if;
  update public.pairing_codes set used_at = now() where id = pc.id;
  o_org := pc.organization_id; o_site := pc.site_id;

  if mach is not null then
    -- the newest row of this machine is reused; older duplicates (earlier pairings) are removed
    select * into old from public.print_agents where organization_id = pc.organization_id and machine_id = mach order by created_at desc limit 1 for update;
    if found then
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
    jsonb_build_object('approval', o_approval, 'repaired', old.id is not null, 'printer', prn));
end $$;
revoke all on function public.agent_pair(text, text, text, text, text) from public, anon, authenticated;

-- What the agent needs to know (sent back with every heartbeat). Also records the machine id the agent reports (agents paired before
-- 0.1.5 had none; 0.1.5 could send a fallback id): the request is authenticated by this PC's own credential.
create or replace function public.agent_state(p_agent uuid, p_machine text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ag public.print_agents; prn text; req public.print_agent_requests;
begin
  select * into ag from public.print_agents where id = p_agent;
  if not found then return null; end if;
  if p_machine ~ '^[0-9a-f]{64}$' and ag.machine_id is distinct from p_machine then update public.print_agents set machine_id = p_machine where id = ag.id; end if;
  select pr.os_printer_name into prn from public.printer_devices pr
    join public.print_destinations pd on pd.printer_id = pr.id and pd.active and pd.origin_site_id = ag.site_id
   where pr.agent_id = ag.id and pr.active order by pd.is_default desc, pd.created_at limit 1;
  select * into req from public.print_agent_requests where agent_id = ag.id and status = 'pending' order by requested_at desc limit 1;
  return jsonb_build_object('approval', ag.approval, 'printer', prn,
    'request', case when req.id is null then null else jsonb_build_object('kind', req.kind, 'printer', req.printer_name, 'at', req.requested_at) end);
end $$;
revoke all on function public.agent_state(uuid, text) from public, anon, authenticated;

-- "Change printer" from the agent: a request the owner approves on the website. The current printer keeps printing until then.
create or replace function public.agent_request_printer(p_agent uuid, p_printer text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ag public.print_agents; prn text := nullif(btrim(coalesce(p_printer, '')), '');
begin
  select * into ag from public.print_agents where id = p_agent and status = 'active' for update;
  if not found then raise exception 'agent_not_found' using errcode = 'P0002'; end if;
  if prn is null or char_length(prn) > 200 then raise exception 'printer_required' using errcode = '22023'; end if;
  if ag.approval = 'pending' then
    update public.print_agent_requests set printer_name = prn where agent_id = ag.id and status = 'pending' and kind = 'takeover';
  else
    update public.print_agent_requests set status = 'cancelled' where agent_id = ag.id and status = 'pending';
    insert into public.print_agent_requests (organization_id, site_id, agent_id, kind, printer_name) values (ag.organization_id, ag.site_id, ag.id, 'change_printer', prn);
  end if;
  return public.agent_state(ag.id);
end $$;
revoke all on function public.agent_request_printer(uuid, text) from public, anon, authenticated;

-- Website: open requests with what the owner needs to decide.
create or replace function public.list_agent_requests(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_permission(p_org, 'print.route.manage') then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'printer', r.printer_name, 'requested_at', r.requested_at,
      'site_id', r.site_id, 'site', s.name, 'agent_id', a.id, 'pc', a.label, 'pc_last_seen', a.last_heartbeat_at,
      'current_printer', (select pr.os_printer_name from public.printer_devices pr where pr.agent_id = a.id and pr.active order by pr.created_at desc limit 1),
      'old_pcs', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label, 'last_seen', o.last_heartbeat_at)), '[]'::jsonb)
                  from public.print_agents o where o.site_id = r.site_id and o.status = 'active' and o.approval = 'approved' and o.id <> a.id),
      'waiting', (select count(*) from public.print_jobs j join public.print_agents o on o.id = j.agent_id
                  where o.site_id = r.site_id and o.status = 'active' and o.id <> a.id and j.status = 'queued' and j.organization_id = p_org))
      order by r.requested_at)
    from public.print_agent_requests r join public.print_agents a on a.id = r.agent_id join public.sites s on s.id = r.site_id
    where r.organization_id = p_org and r.status = 'pending' and a.status = 'active'
      and public.has_site_access(p_org, r.site_id)), '[]'::jsonb);
end $$;
revoke all on function public.list_agent_requests(uuid) from public, anon;
grant execute on function public.list_agent_requests(uuid) to authenticated;

create or replace function public.decide_agent_request(p_org uuid, p_request uuid, p_approve boolean, p_move_waiting boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.print_agent_requests; ag public.print_agents; moved int := 0;
begin
  select * into r from public.print_agent_requests where id = p_request and organization_id = p_org for update;
  if not found then raise exception 'request_not_found' using errcode = 'P0002'; end if;
  perform public.assert_can(p_org, 'print.route.manage', r.site_id);
  if r.status <> 'pending' then raise exception 'request_already_decided' using errcode = '23514'; end if;
  select * into ag from public.print_agents where id = r.agent_id for update;
  if ag.status <> 'active' then raise exception 'agent_not_found' using errcode = 'P0002'; end if;
  update public.print_agent_requests set status = case when p_approve then 'approved' else 'rejected' end, decided_by = (select auth.uid()), decided_at = now()
   where id = r.id;
  if not p_approve then
    if r.kind = 'takeover' then
      update public.print_agents set status = 'revoked', revoked_at = now(), approval = 'rejected' where id = ag.id;
      perform public.switch_off_agent_printers(ag.id);
    end if;
    perform public.write_audit(p_org, r.site_id, (select auth.uid()), 'agent.request_rejected', 'agent', ag.id::text, null, jsonb_build_object('kind', r.kind, 'printer', r.printer_name));
    return jsonb_build_object('approved', false);
  end if;
  if r.kind = 'takeover' then
    update public.print_agents set approval = 'approved' where id = ag.id;
    if r.printer_name is not null then perform public.set_agent_printer(ag.id, r.printer_name); end if;
    moved := public.retire_site_agents(r.site_id, ag.id, p_move_waiting);
  else
    if r.printer_name is null then raise exception 'printer_required' using errcode = '22023'; end if;
    perform public.set_agent_printer(ag.id, r.printer_name);
  end if;
  perform public.write_audit(p_org, r.site_id, (select auth.uid()), 'agent.request_approved', 'agent', ag.id::text, null,
    jsonb_build_object('kind', r.kind, 'printer', r.printer_name, 'moved_waiting', moved));
  return jsonb_build_object('approved', true, 'moved', moved);
end $$;
revoke all on function public.decide_agent_request(uuid, uuid, boolean, boolean) from public, anon;
grant execute on function public.decide_agent_request(uuid, uuid, boolean, boolean) to authenticated;

-- A PC waiting for approval cannot be given a printer from the Settings page (that would skip the approval).
create or replace function public.bind_printer(p_org uuid, p_agent uuid, p_os_name text, p_label text, p_w numeric, p_h numeric,
  p_set_default_route boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ag public.print_agents; pr public.printer_devices;
begin
  select * into ag from public.print_agents where id = p_agent and organization_id = p_org and status = 'active';
  if not found then raise exception 'agent_not_found' using errcode = 'P0002'; end if;
  perform public.assert_can(p_org, 'print.route.manage', ag.site_id);
  if ag.approval <> 'approved' then raise exception 'agent_not_approved' using errcode = '23514'; end if;
  insert into public.printer_devices (organization_id, site_id, agent_id, label, os_printer_name, paper_w_mm, paper_h_mm)
  values (p_org, ag.site_id, ag.id, p_label, p_os_name, p_w, p_h)
  on conflict (agent_id, os_printer_name) do update set label = excluded.label, paper_w_mm = excluded.paper_w_mm, paper_h_mm = excluded.paper_h_mm, active = true
  returning * into pr;
  if p_set_default_route then
    update public.print_destinations set is_default = false where organization_id = p_org and origin_site_id = ag.site_id;
    insert into public.print_destinations (organization_id, origin_site_id, printer_id, is_default)
    values (p_org, ag.site_id, pr.id, true) on conflict (origin_site_id, printer_id) do update set is_default = true, active = true;
  end if;
  perform public.write_audit(p_org, ag.site_id, (select auth.uid()), 'printer.bind', 'printer', pr.id::text);
  return to_jsonb(pr);
end $$;

-- removing a PC also drops its open requests
create or replace function public.switch_off_agent_printers(p_agent uuid) returns void
language sql security definer set search_path = '' as $$
  update public.print_destinations pd set active = false, is_default = false
    from public.printer_devices pr where pr.id = pd.printer_id and pr.agent_id = p_agent and pd.active;
  update public.printer_devices set active = false where agent_id = p_agent and active;
  update public.print_agent_requests set status = 'cancelled' where agent_id = p_agent and status = 'pending';
$$;
revoke all on function public.switch_off_agent_printers(uuid) from public, anon, authenticated;
