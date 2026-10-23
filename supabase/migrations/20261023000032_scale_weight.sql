-- Weighing scale (RS-232 / USB-serial / network indicator on the site's printer PC).
-- Flow: the operator taps "Detect weight" -> request_scale_weight() records a request and sends a data-less "check now" signal to
-- that PC -> the Print Agent reads the STEADY weight from the indicator and answers with agent_finish_weight_read() -> the page
-- shows it. Saving the entry with that reading (open_entry / close_entry p_weight_read) makes the server check it: same firm and
-- site, steady, recent, unused, and exactly the weight being saved. A weight typed by hand stays possible and is recorded as manual.

-- 1. what the agent reports about its scale (heartbeat) and its secret signal topic
alter table public.print_agents add column if not exists scale jsonb;
alter table public.print_agents add column if not exists signal_key text not null default encode(extensions.gen_random_bytes(16), 'hex');
grant select (scale) on public.print_agents to authenticated;

-- 2. one row per "Detect weight" tap
create table public.weight_reads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  site_id uuid not null,
  agent_id uuid not null references public.print_agents(id) on delete cascade,
  requested_by uuid,
  status text not null default 'pending' check (status in ('pending', 'reading', 'done', 'failed', 'expired')),
  weight_kg numeric(12, 3) check (weight_kg is null or (weight_kg > 0 and weight_kg < 1000000)),
  frames int,
  raw text check (raw is null or char_length(raw) <= 200),
  error_code text check (error_code is null or error_code ~ '^[a-z_]{2,40}$'),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  used_at timestamptz,
  used_by uuid,
  weighment_id uuid,
  used_stage text check (used_stage is null or used_stage in ('first', 'second'))
);
create index weight_reads_agent_pending on public.weight_reads (agent_id, created_at) where status in ('pending', 'reading');
create index weight_reads_org_site on public.weight_reads (organization_id, site_id, created_at desc);
create index weight_reads_weighment on public.weight_reads (weighment_id) where weighment_id is not null;
alter table public.weight_reads enable row level security;
create policy weight_reads_read on public.weight_reads for select to authenticated
  using ((public.has_permission(organization_id, 'weighment.create') or public.has_permission(organization_id, 'weighment.complete'))
         and public.has_site_access(organization_id, site_id));
grant select on public.weight_reads to authenticated;
alter publication supabase_realtime add table public.weight_reads;

-- 3. the PC that weighs for a site: the active, approved agent of the site with a scale switched on
create function public.site_scale_agent(p_org uuid, p_site uuid) returns public.print_agents
language sql stable security definer set search_path = '' as $$
  select a.* from public.print_agents a
   where a.organization_id = p_org and a.site_id = p_site and a.status = 'active' and coalesce(a.approval, 'approved') = 'approved'
     and coalesce((a.scale ->> 'enabled')::boolean, false)
   order by a.last_heartbeat_at desc nulls last limit 1
$$;
revoke all on function public.site_scale_agent(uuid, uuid) from public, anon, authenticated;

-- 4. "Detect weight": a request for the site's scale PC (taps within 10 s by anyone at the site share one reading)
create function public.request_scale_weight(p_org uuid, p_site uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ag public.print_agents; r public.weight_reads; uid uuid := (select auth.uid());
begin
  if public.has_permission(p_org, 'weighment.create') then perform public.assert_can(p_org, 'weighment.create', p_site);
  else perform public.assert_can(p_org, 'weighment.complete', p_site); end if;
  ag := public.site_scale_agent(p_org, p_site);
  if ag.id is null then raise exception 'scale_not_connected' using errcode = 'P0002'; end if;
  if ag.last_heartbeat_at is null or ag.last_heartbeat_at < now() - interval '2 minutes' then raise exception 'scale_pc_offline' using errcode = '55000'; end if;
  update public.weight_reads set status = 'expired', completed_at = now(), error_code = 'timeout'
   where agent_id = ag.id and status in ('pending', 'reading') and created_at < now() - interval '30 seconds';
  select * into r from public.weight_reads
   where agent_id = ag.id and site_id = p_site and status in ('pending', 'reading') and created_at > now() - interval '10 seconds'
   order by created_at desc limit 1;
  if not found then
    insert into public.weight_reads (organization_id, site_id, agent_id, requested_by) values (p_org, p_site, ag.id, uid) returning * into r;
  end if;
  -- data-less signal: the agent then asks the server (with its own credential) what to do
  begin
    perform realtime.send(jsonb_build_object('r', 1), 'weigh', 'dk-agent-' || ag.signal_key, false);
  exception when others then null; -- the agent's 5-second poll picks the request up anyway
  end;
  return jsonb_build_object('id', r.id, 'pc', ag.label);
end $$;
revoke all on function public.request_scale_weight(uuid, uuid) from public, anon;
grant execute on function public.request_scale_weight(uuid, uuid) to authenticated;

-- 5. agent side (called by the web server with the service key after the device credential was checked)
create function public.agent_report_scale(p_agent uuid, p_scale jsonb) returns void
language sql security definer set search_path = '' as $$
  update public.print_agents set scale = case when jsonb_typeof(p_scale) = 'object' and length(p_scale::text) <= 2000 then p_scale else null end
   where id = p_agent and status = 'active';
$$;

create function public.agent_next_weight_read(p_agent uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.weight_reads;
begin
  update public.weight_reads set status = 'expired', completed_at = now(), error_code = 'timeout'
   where agent_id = p_agent and status in ('pending', 'reading') and created_at < now() - interval '30 seconds';
  select * into r from public.weight_reads where agent_id = p_agent and status = 'pending' order by created_at limit 1 for update skip locked;
  if not found then return null; end if;
  update public.weight_reads set status = 'reading', claimed_at = now() where id = r.id;
  return jsonb_build_object('id', r.id);
end $$;

create function public.agent_finish_weight_read(p_agent uuid, p_id uuid, p_ok boolean, p_weight numeric, p_frames int, p_raw text, p_error text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.weight_reads;
begin
  select * into r from public.weight_reads where id = p_id and agent_id = p_agent for update;
  if not found then raise exception 'weight_read_not_found' using errcode = 'P0002'; end if;
  if r.status not in ('pending', 'reading') or r.created_at < now() - interval '60 seconds' then raise exception 'weight_read_closed' using errcode = '23514'; end if;
  if p_ok then
    if p_weight is null or p_weight <= 0 or p_weight >= 1000000 then raise exception 'invalid_weight' using errcode = '22023'; end if;
    update public.weight_reads set status = 'done', weight_kg = round(p_weight, 3), frames = p_frames, raw = left(p_raw, 200), completed_at = now() where id = r.id;
  else
    update public.weight_reads set status = 'failed', completed_at = now(),
      error_code = case when p_error ~ '^[a-z_]{2,40}$' then p_error else 'scale_error' end where id = r.id;
  end if;
end $$;

revoke all on function public.agent_report_scale(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.agent_next_weight_read(uuid) from public, anon, authenticated;
revoke all on function public.agent_finish_weight_read(uuid, uuid, boolean, numeric, int, text, text) from public, anon, authenticated;
grant execute on function public.agent_report_scale(uuid, jsonb) to service_role;
grant execute on function public.agent_next_weight_read(uuid) to service_role;
grant execute on function public.agent_finish_weight_read(uuid, uuid, boolean, numeric, int, text, text) to service_role;

-- the signal topic of an agent, for its heartbeat answer (service key only)
create function public.agent_signal_key(p_agent uuid) returns text
language sql stable security definer set search_path = '' as $$ select signal_key from public.print_agents where id = p_agent and status = 'active' $$;
revoke all on function public.agent_signal_key(uuid) from public, anon, authenticated;
grant execute on function public.agent_signal_key(uuid) to service_role;

-- 6. saving an entry with a scale reading: the server checks it and links it (both functions get p_weight_read, default null)
create function public.take_weight_read(p_org uuid, p_site uuid, p_read uuid, p_weight numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.weight_reads;
begin
  select * into r from public.weight_reads where id = p_read and organization_id = p_org for update;
  if not found or r.site_id <> p_site then raise exception 'weight_read_invalid' using errcode = '22023'; end if;
  if r.status <> 'done' or r.used_at is not null then raise exception 'weight_read_invalid' using errcode = '22023'; end if;
  if r.completed_at < now() - interval '15 minutes' then raise exception 'weight_read_expired' using errcode = '22023'; end if;
  if round(r.weight_kg, 3) <> round(p_weight, 3) then raise exception 'weight_read_mismatch' using errcode = '22023'; end if;
end $$;
revoke all on function public.take_weight_read(uuid, uuid, uuid, numeric) from public, anon, authenticated;

do $$
declare d text; sig text;
begin
  -- open_entry
  sig := 'public.open_entry(uuid,uuid,text,numeric,numeric,payment_mode,uuid,text,text,jsonb,time_mode,timestamp with time zone,text,text,boolean,numeric)';
  select pg_get_functiondef(sig::regprocedure) into d;
  d := replace(d, 'p_amount_paid numeric DEFAULT NULL::numeric)', 'p_amount_paid numeric DEFAULT NULL::numeric, p_weight_read uuid DEFAULT NULL::uuid)');
  d := replace(d, E'  if p_weight is null or p_weight <= 0 then raise exception ''invalid_weight'' using errcode = ''22023''; end if;\n  if p_amount is null',
    E'  if p_weight is null or p_weight <= 0 then raise exception ''invalid_weight'' using errcode = ''22023''; end if;\n  if p_weight_read is not null then perform public.take_weight_read(p_org, p_site, p_weight_read, p_weight); end if;\n  if p_amount is null');
  d := replace(d, E'  perform public.sync_entry_payment(inv, case when p_payment_mode = ''cash''',
    E'  if p_weight_read is not null then update public.weight_reads set used_at = now(), used_by = uid, weighment_id = w.id, used_stage = ''first'' where id = p_weight_read; end if;\n  perform public.sync_entry_payment(inv, case when p_payment_mode = ''cash''');
  d := replace(d, E'jsonb_build_object(''number'', inv.invoice_number, ''amount'', inv.fee_total, ''replaced_open'', n)',
    E'jsonb_build_object(''number'', inv.invoice_number, ''amount'', inv.fee_total, ''replaced_open'', n, ''weight_source'', case when p_weight_read is null then ''manual'' else ''scale'' end)');
  if (length(d) - length(replace(d, 'p_weight_read', ''))) / length('p_weight_read') <> 6 then raise exception 'open_entry patch did not apply'; end if;
  execute 'drop function ' || sig;
  execute d;
  execute 'grant execute on function public.open_entry(uuid,uuid,text,numeric,numeric,payment_mode,uuid,text,text,jsonb,time_mode,timestamp with time zone,text,text,boolean,numeric,uuid) to authenticated, service_role';
  execute 'revoke all on function public.open_entry(uuid,uuid,text,numeric,numeric,payment_mode,uuid,text,text,jsonb,time_mode,timestamp with time zone,text,text,boolean,numeric,uuid) from public, anon';

  -- close_entry
  sig := 'public.close_entry(uuid,uuid,numeric,numeric,payment_mode,uuid,text,text,jsonb,time_mode,timestamp with time zone,text,integer,text,numeric)';
  select pg_get_functiondef(sig::regprocedure) into d;
  d := replace(d, 'p_amount_paid numeric DEFAULT NULL::numeric)', 'p_amount_paid numeric DEFAULT NULL::numeric, p_weight_read uuid DEFAULT NULL::uuid)');
  d := replace(d, E'  if p_weight is null or p_weight <= 0 then raise exception ''invalid_weight'' using errcode = ''22023''; end if;\n  if p_amount is null',
    E'  if p_weight is null or p_weight <= 0 then raise exception ''invalid_weight'' using errcode = ''22023''; end if;\n  if p_weight_read is not null then perform public.take_weight_read(p_org, w.site_id, p_weight_read, p_weight); end if;\n  if p_amount is null');
  d := replace(d, E'  perform public.sync_entry_payment(inv, target, uid);',
    E'  if p_weight_read is not null then update public.weight_reads set used_at = now(), used_by = uid, weighment_id = w.id, used_stage = ''second'' where id = p_weight_read; end if;\n  perform public.sync_entry_payment(inv, target, uid);');
  d := replace(d, E'''loaded_was'', loaded, ''opening_amount'', w.rate_at_gross)',
    E'''loaded_was'', loaded, ''opening_amount'', w.rate_at_gross, ''weight_source'', case when p_weight_read is null then ''manual'' else ''scale'' end)');
  if (length(d) - length(replace(d, 'p_weight_read', ''))) / length('p_weight_read') <> 6 then raise exception 'close_entry patch did not apply'; end if;
  execute 'drop function ' || sig;
  execute d;
  execute 'grant execute on function public.close_entry(uuid,uuid,numeric,numeric,payment_mode,uuid,text,text,jsonb,time_mode,timestamp with time zone,text,integer,text,numeric,uuid) to authenticated, service_role';
  execute 'revoke all on function public.close_entry(uuid,uuid,numeric,numeric,payment_mode,uuid,text,text,jsonb,time_mode,timestamp with time zone,text,integer,text,numeric,uuid) from public, anon';
end $$;

-- 7. old readings are not kept forever (they are only needed to save an entry): nightly purge after 7 days, with the print history
create function public.purge_old_weight_reads() returns void language sql security definer set search_path = '' as $$
  delete from public.weight_reads where created_at < now() - interval '7 days' and weighment_id is null;
  delete from public.weight_reads where created_at < now() - interval '90 days';
$$;
revoke all on function public.purge_old_weight_reads() from public, anon, authenticated;
select cron.unschedule(jobid) from cron.job where jobname = 'dk-purge-old-weight-reads';
select cron.schedule('dk-purge-old-weight-reads', '40 21 * * *', 'select public.purge_old_weight_reads()');
