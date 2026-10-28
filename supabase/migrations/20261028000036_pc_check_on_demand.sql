-- No timed heartbeat from the Print Agent (0.2.2+). A PC is asked "are you there?" only when someone needs to know:
-- the weighment page is opened or "Check vehicle" is pressed, Settings / Print centre are opened. The question is a data-less
-- Realtime signal ("ping"); the PC answers with one dka_ping call, which stamps last_heartbeat_at. Printing itself (claim / events)
-- also counts as "alive". Owner decisions that concern a PC (approval, printer change, route) send it a "state" signal at once.
-- Agents before 0.2.2 keep their own 30 s heartbeat and simply ignore these signals.

alter table public.print_agents add column if not exists last_check_at timestamptz;

-- Ask the firm's PCs (optionally of one site) whether they are there. Returns the server time of the question: the page shows a PC
-- as online when it answered after that time. The same PC is asked at most every 15 s, however many pages ask.
create or replace function public.check_pcs(p_org uuid, p_site uuid default null) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare a record; t timestamptz := now();
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not public.has_permission(p_org, 'print.view') then raise exception 'forbidden' using errcode = '42501'; end if;
  for a in
    update public.print_agents set last_check_at = t
     where organization_id = p_org and status = 'active' and (p_site is null or site_id = p_site)
       and (last_check_at is null or last_check_at < t - interval '15 seconds')
    returning signal_key
  loop
    begin perform realtime.send(jsonb_build_object('p', 1), 'ping', 'dk-agent-' || a.signal_key, false); exception when others then null; end;
  end loop;
  return t;
end $$;
revoke all on function public.check_pcs(uuid, uuid) from public, anon;
grant execute on function public.check_pcs(uuid, uuid) to authenticated;

-- the platform administrator's printer list asks every firm's PCs
create or replace function public.admin_check_pcs() returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare a record; t timestamptz := now();
begin
  if not exists (select 1 from public.platform_admins where user_id = (select auth.uid())) then raise exception 'forbidden' using errcode = '42501'; end if;
  for a in
    update public.print_agents set last_check_at = t
     where status = 'active' and (last_check_at is null or last_check_at < t - interval '15 seconds')
    returning signal_key
  loop
    begin perform realtime.send(jsonb_build_object('p', 1), 'ping', 'dk-agent-' || a.signal_key, false); exception when others then null; end;
  end loop;
  return t;
end $$;
revoke all on function public.admin_check_pcs() from public, anon;
grant execute on function public.admin_check_pcs() to authenticated;

-- printing counts as "alive"
create or replace function public.dka_claim(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ag uuid := public.dka_agent(p_token);
begin
  update public.print_agents set last_heartbeat_at = now() where id = ag and status = 'active';
  return public.agent_claim_job(ag);
end $$;

-- "Detect weight" no longer refuses a PC that has not sent a heartbeat lately (0.2.2 sends none while idle): the request is signalled
-- and a PC that does not answer within 30 s gives the usual "did not answer in time" message.
do $$
declare d text;
begin
  select pg_get_functiondef('public.request_scale_weight(uuid, uuid)'::regprocedure) into d;
  d := replace(d, E'  if ag.last_heartbeat_at is null or ag.last_heartbeat_at < now() - interval ''2 minutes'' then raise exception ''scale_pc_offline'' using errcode = ''55000''; end if;\n', '');
  if position('scale_pc_offline' in d) > 0 then raise exception 'request_scale_weight patch did not apply'; end if;
  execute d;
end $$;

-- tell a PC at once that something about it changed (approval, its printer, the site's route)
create or replace function public.signal_agent_state(p_agent uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  select signal_key into k from public.print_agents where id = p_agent and status = 'active';
  if k is not null then
    begin perform realtime.send(jsonb_build_object('s', 1), 'state', 'dk-agent-' || k, false); exception when others then null; end;
  end if;
end $$;
revoke all on function public.signal_agent_state(uuid) from public, anon, authenticated;

create or replace function public.agent_state_signal_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'print_agents' then
    perform public.signal_agent_state(new.id);
  elsif tg_table_name = 'print_agent_requests' or tg_table_name = 'printer_devices' then
    perform public.signal_agent_state(new.agent_id);
  elsif tg_table_name = 'print_destinations' then
    perform public.signal_agent_state(pr.agent_id) from public.printer_devices pr where pr.id = new.printer_id;
  end if;
  return null;
end $$;
revoke all on function public.agent_state_signal_trigger() from public, anon, authenticated;

create trigger print_agents_state_signal after update of approval, site_id on public.print_agents
  for each row when (old.approval is distinct from new.approval or old.site_id is distinct from new.site_id)
  execute function public.agent_state_signal_trigger();
create trigger print_agent_requests_state_signal after insert or update of status on public.print_agent_requests
  for each row execute function public.agent_state_signal_trigger();
create trigger printer_devices_state_signal after insert or update of active, os_printer_name on public.printer_devices
  for each row execute function public.agent_state_signal_trigger();
create trigger print_destinations_state_signal after insert or update of active, is_default on public.print_destinations
  for each row execute function public.agent_state_signal_trigger();
