-- Print flow fixes found by break-testing (2026-10-31). Nothing else changes.
--
-- 1. The printer PC waits at most 60 s for Windows to accept a slip. When Windows does not answer in time the slip may still come
--    out, but the job was turned "failed" ("did not print" + Print again): a second slip. Print Agent 0.2.4 reports that case as
--    failed / print_timeout, and the job is now marked "unknown" (check the paper before reprinting), like a PC that stopped answering.
-- 2. A status that already reached the database but whose answer was lost (slow network: the agent then repeats it through the
--    website) was refused as an invalid change. For "submitting" the agent then never printed and the slip turned "unknown": a lost
--    slip. The same status again with the same lease is now accepted and changes nothing.

create or replace function public.agent_record_event(p_agent uuid, p_job uuid, p_lease uuid, p_status public.print_status, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare j public.print_jobs; retryable boolean;
begin
  select * into j from public.print_jobs where id = p_job and agent_id = p_agent for update;
  if not found or j.lease_token is distinct from p_lease then raise exception 'lease_invalid' using errcode = '42501'; end if;
  -- the same status again (its answer was lost): already done
  if j.status = p_status and p_status in ('rendering', 'submitting', 'submitted_to_spooler') then return; end if;
  if not ((j.status = 'claimed' and p_status in ('rendering', 'submitting', 'failed'))
       or (j.status = 'rendering' and p_status in ('submitting', 'failed'))
       or (j.status = 'submitting' and p_status in ('submitted_to_spooler', 'failed'))) then
    raise exception 'invalid_transition' using errcode = '23514';
  end if;

  -- Windows did not answer in time after the slip was handed over: it may still print, so a person checks the paper
  if j.status = 'submitting' and p_status = 'failed' and p_error = 'print_timeout' then
    update public.print_jobs set status = 'unknown', last_error_code = 'print_timeout', reported_at = now() where id = j.id;
    insert into public.print_job_events (organization_id, job_id, status, actor_agent_id, error_code, attempt)
    values (j.organization_id, j.id, 'unknown', p_agent, 'print_timeout', j.attempt_count);
    return;
  end if;

  -- Only known pre-submit conditions that clear up by themselves (paper, power, cable) are auto-retried,
  -- and only if the job had not reached 'submitting'. Anything else needs a person.
  retryable := p_status = 'failed' and j.status in ('claimed', 'rendering')
               and p_error in ('printer_offline', 'paper_out', 'paper_jam') and j.attempt_count < 6;

  if retryable then
    update public.print_jobs set status = 'queued', last_error_code = left(p_error, 80), lease_token = null, lease_expires_at = null,
      retry_after = now() + make_interval(secs => least(120, 20 * j.attempt_count)) where id = j.id;
    insert into public.print_job_events (organization_id, job_id, status, actor_agent_id, error_code, attempt)
    values (j.organization_id, j.id, 'failed', p_agent, left(p_error, 80), j.attempt_count),
           (j.organization_id, j.id, 'queued', p_agent, 'auto_retry', j.attempt_count);
    return;
  end if;

  update public.print_jobs set status = p_status, last_error_code = left(p_error, 80),
    lease_expires_at = case when p_status in ('rendering', 'submitting') then now() + interval '120 seconds' else lease_expires_at end,
    submitted_at = case when p_status = 'submitted_to_spooler' then now() else submitted_at end,
    reported_at = case when p_status in ('submitted_to_spooler', 'failed') then now() else reported_at end
  where id = j.id;
  insert into public.print_job_events (organization_id, job_id, status, actor_agent_id, error_code, attempt)
  values (j.organization_id, j.id, p_status, p_agent, left(p_error, 80), j.attempt_count);
end $$;
