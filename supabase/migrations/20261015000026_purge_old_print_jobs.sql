-- Print history older than 7 days is deleted automatically, firm by firm, to save database space (owner decision, 2026-10-15).
-- Only print jobs and their events are deleted, and only finished ones (printed, failed, cancelled, no route, unknown).
-- Slips still waiting or printing are never touched. Invoices, weighments, payments and debtors stay forever, and every
-- printer PC keeps its own Excel + PDF copy of each slip.

-- print_job_events stays append-only, except for this purge (flag set inside purge_old_print_jobs only)
create or replace function public.print_job_events_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and current_setting('dk.allow_purge', true) = 'on' then return old; end if;
  raise exception 'append_only' using errcode = '42501';
end $$;
drop trigger if exists print_job_events_append_only on public.print_job_events;
create trigger print_job_events_append_only before update or delete on public.print_job_events
  for each row execute function public.print_job_events_guard();

create or replace function public.purge_old_print_jobs(p_days int default 7) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o record; cutoff timestamptz := now() - make_interval(days => greatest(coalesce(p_days, 7), 7)); n int; total int := 0; per jsonb := '{}'::jsonb;
  done constant public.print_status[] := array['submitted_to_spooler', 'failed', 'cancelled', 'routing_error', 'not_configured', 'unknown']::public.print_status[];
begin
  perform set_config('dk.allow_purge', 'on', true);
  for o in select id from public.organizations loop
    delete from public.print_job_events e using public.print_jobs j
     where e.job_id = j.id and j.organization_id = o.id and j.status = any (done) and j.queued_at < cutoff;
    delete from public.print_jobs where organization_id = o.id and status = any (done) and queued_at < cutoff;
    get diagnostics n = row_count;
    if n > 0 then per := per || jsonb_build_object(o.id::text, n); total := total + n; end if;
  end loop;
  perform set_config('dk.allow_purge', 'off', true);
  return jsonb_build_object('deleted', total, 'per_firm', per, 'older_than', cutoff);
end $$;
-- not callable from the website or the app: only the nightly job below (and the service key)
revoke all on function public.purge_old_print_jobs(int) from public, anon, authenticated;

-- every night at 03:00 IST (21:30 UTC)
create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname = 'dk-purge-old-print-jobs';
select cron.schedule('dk-purge-old-print-jobs', '30 21 * * *', 'select public.purge_old_print_jobs(7)');
