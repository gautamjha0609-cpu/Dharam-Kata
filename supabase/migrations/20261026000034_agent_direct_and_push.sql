-- Print Agent without polling the website.
-- Before: every printer PC asked the website (a Vercel function) every 5 s "any job?" and "any weight request?" and sent a heartbeat
-- every 30 s, all day and night: ~15,000 server calls per PC per day, almost all answered "nothing".
-- Now (agent 0.1.9+):
--   * the agent calls these dka_* functions DIRECTLY on the database (PostgREST, public key). Each one checks the PC's own secret
--     credential first, exactly like the website routes did, then runs the same agent_* function. The website is not involved.
--   * a slip queued for a PC sends it a data-less "check now" signal (Realtime broadcast on the PC's secret topic, as the scale already
--     does), so it prints at once; nothing is polled while nothing happens.
--   * the 30 s heartbeat is ONE light call; it also says whether work is waiting (safety net if a signal was missed).
-- Older agents keep using the website routes unchanged.
-- HTTP status: SQLSTATE 'PTxxx' makes PostgREST answer with status xxx, so the agent sees the same 401 / 403 / 409 as before.

-- the PC behind a credential, or 401
create function public.dka_agent(p_token text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare a uuid;
begin
  if p_token is null or char_length(p_token) < 32 or char_length(p_token) > 200 then
    raise exception 'unauthenticated' using errcode = 'PT401';
  end if;
  a := public.agent_authenticate(p_token);
  if a is null then raise exception 'unauthenticated' using errcode = 'PT401'; end if;
  return a;
end $$;

-- heartbeat. p_info (version, os, printers, machine_id, scale) is sent when something changed and every few minutes; otherwise only
-- "still here" is recorded. Answers: approval + printer (agent_state), the signal topic, and whether a job / weight request waits.
create function public.dka_ping(p_token text, p_info jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ag uuid := public.dka_agent(p_token);
  v text; os text; prn jsonb := '[]'::jsonb; mid text; key text; nxt timestamptz; jobs boolean; weights boolean;
begin
  if p_info is not null then
    if jsonb_typeof(p_info) <> 'object' or length(p_info::text) > 20000 then raise exception 'invalid_request' using errcode = 'PT400'; end if;
    v := left(coalesce(p_info->>'version', ''), 40);
    os := left(coalesce(p_info->>'os', ''), 80);
    if jsonb_typeof(p_info->'printers') = 'array' then
      select coalesce(jsonb_agg(jsonb_build_object('name', left(x->>'name', 200), 'status', left(coalesce(x->>'status', 'ready'), 40))), '[]'::jsonb)
        into prn from (select x from jsonb_array_elements(p_info->'printers') x where jsonb_typeof(x->'name') = 'string' limit 50) s;
    end if;
    mid := case when p_info->>'machine_id' ~ '^[0-9a-f]{64}$' then p_info->>'machine_id' end;
    perform public.agent_heartbeat(ag, v, os, prn);
    perform public.agent_version_seen(ag, v);
    if p_info ? 'scale' then perform public.agent_report_scale(ag, p_info->'scale'); end if;
  else
    update public.print_agents set last_heartbeat_at = now() where id = ag and status = 'active';
  end if;
  select signal_key into key from public.print_agents where id = ag;
  jobs := exists (select 1 from public.print_jobs where agent_id = ag
    and ((status = 'queued' and (retry_after is null or retry_after <= now()))
      or (status in ('claimed', 'rendering') and lease_expires_at < now() and attempt_count < 3)));
  select min(retry_after) into nxt from public.print_jobs where agent_id = ag and status = 'queued' and retry_after > now();
  weights := exists (select 1 from public.weight_reads where agent_id = ag and status = 'pending' and created_at > now() - interval '30 seconds');
  return jsonb_build_object('server_time', now(), 'state', public.agent_state(ag, mid), 'topic', 'dk-agent-' || key,
    'jobs', jobs, 'weights', weights,
    'next_job_in_ms', case when nxt is null then null else greatest(0, (extract(epoch from (nxt - now())) * 1000)::bigint) end);
end $$;

create function public.dka_claim(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  return public.agent_claim_job(public.dka_agent(p_token));
end $$;

create function public.dka_event(p_token text, p_job uuid, p_lease uuid, p_status text, p_error text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ag uuid := public.dka_agent(p_token);
begin
  if p_job is null or p_lease is null or p_status is null or p_status not in ('rendering', 'submitting', 'submitted_to_spooler', 'failed')
     or char_length(coalesce(p_error, '')) > 80 then
    raise exception 'invalid_request' using errcode = 'PT400';
  end if;
  begin
    perform public.agent_record_event(ag, p_job, p_lease, p_status::public.print_status, p_error);
  exception when others then
    if sqlerrm like '%lease_invalid%' then raise exception 'event_rejected' using errcode = 'PT403'; end if;
    raise exception 'event_rejected' using errcode = 'PT409';
  end;
  return jsonb_build_object('accepted', true);
end $$;

create function public.dka_weight_next(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  return public.agent_next_weight_read(public.dka_agent(p_token));
end $$;

create function public.dka_weight_finish(p_token text, p_id uuid, p_ok boolean, p_weight numeric, p_raw text, p_frames integer, p_error text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare ag uuid := public.dka_agent(p_token);
begin
  if p_id is null or p_ok is null
     or (p_weight is not null and (p_weight <= 0 or p_weight >= 1000000))
     or (p_ok and p_weight is null)
     or char_length(coalesce(p_raw, '')) > 200
     or (p_frames is not null and (p_frames < 0 or p_frames > 1000))
     or (p_error is not null and p_error !~ '^[a-z_]{2,40}$') then
    raise exception 'invalid_request' using errcode = 'PT400';
  end if;
  begin
    perform public.agent_finish_weight_read(ag, p_id, p_ok, p_weight, p_frames, p_raw, p_error);
  exception when others then
    if sqlerrm like '%weight_read_closed%' then raise exception 'weight_read_closed' using errcode = 'PT409'; end if;
    if sqlerrm like '%weight_read_not_found%' then raise exception 'not_found' using errcode = 'PT404'; end if;
    raise exception 'weight_rejected' using errcode = 'PT400';
  end;
  return jsonb_build_object('saved', true);
end $$;

create function public.dka_request_printer(p_token text, p_printer text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ag uuid := public.dka_agent(p_token); st jsonb;
begin
  if char_length(btrim(coalesce(p_printer, ''))) not between 1 and 200 then raise exception 'invalid_request' using errcode = 'PT400'; end if;
  begin
    st := public.agent_request_printer(ag, btrim(p_printer));
  exception when others then
    raise exception 'request_failed' using errcode = 'PT409';
  end;
  return jsonb_build_object('state', st);
end $$;

-- the internal helper is never callable from outside; the dka_* entry points are (they all check the credential first)
revoke all on function public.dka_agent(text) from public, anon, authenticated;
revoke all on function public.dka_ping(text, jsonb) from public;
revoke all on function public.dka_claim(text) from public;
revoke all on function public.dka_event(text, uuid, uuid, text, text) from public;
revoke all on function public.dka_weight_next(text) from public;
revoke all on function public.dka_weight_finish(text, uuid, boolean, numeric, text, integer, text) from public;
revoke all on function public.dka_request_printer(text, text) from public;
grant execute on function public.dka_ping(text, jsonb) to anon;
grant execute on function public.dka_claim(text) to anon;
grant execute on function public.dka_event(text, uuid, uuid, text, text) to anon;
grant execute on function public.dka_weight_next(text) to anon;
grant execute on function public.dka_weight_finish(text, uuid, boolean, numeric, text, integer, text) to anon;
grant execute on function public.dka_request_printer(text, text) to anon;

-- "check now" for the PC a slip is queued for (new job, retry, reprint). Data-less; a failed signal only means the heartbeat's
-- "work waiting" answer picks the job up instead.
create function public.print_job_signal() returns trigger
language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  if new.agent_id is not null and new.status = 'queued'
     and (tg_op = 'INSERT' or old.status is distinct from new.status or old.agent_id is distinct from new.agent_id) then
    select signal_key into k from public.print_agents where id = new.agent_id and status = 'active';
    if k is not null then
      begin
        perform realtime.send(jsonb_build_object('j', 1), 'job', 'dk-agent-' || k, false);
      exception when others then null;
      end;
    end if;
  end if;
  return null;
end $$;
revoke all on function public.print_job_signal() from public, anon, authenticated;
create trigger print_jobs_signal after insert or update of status, agent_id on public.print_jobs
  for each row execute function public.print_job_signal();
