-- Printer model + the "environment" chosen for it (readable-size floor, recommended font).
alter table public.printer_devices
  add column model_key text,
  add column legibility_floor_pt numeric(3,1) check (legibility_floor_pt is null or legibility_floor_pt between 5 and 14),
  add column font_family text check (font_family is null or font_family in ('Courier New', 'Lucida Console', 'Consolas', 'Arial', 'Mangal', 'Nirmala UI'));

create function public.set_printer_model(p_org uuid, p_printer uuid, p_model text, p_floor numeric, p_font text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pr public.printer_devices;
begin
  select * into pr from public.printer_devices where id = p_printer and organization_id = p_org;
  if not found then raise exception 'printer_not_found' using errcode = 'P0002'; end if;
  perform public.assert_can(p_org, 'print.route.manage', pr.site_id);
  if p_model is null or p_model !~ '^[a-z0-9-]{2,60}$' then raise exception 'invalid_model' using errcode = '22023'; end if;
  update public.printer_devices set model_key = p_model, legibility_floor_pt = p_floor, font_family = p_font where id = pr.id returning * into pr;
  perform public.write_audit(p_org, pr.site_id, (select auth.uid()), 'printer.model', 'printer', pr.id::text, null,
    jsonb_build_object('model', p_model, 'floor_pt', p_floor, 'font', p_font));
  return to_jsonb(pr);
end $$;
revoke all on function public.set_printer_model(uuid, uuid, text, numeric, text) from public, anon;
grant execute on function public.set_printer_model(uuid, uuid, text, numeric, text) to authenticated;

-- the agent receives the printer's environment with each claimed job
create or replace function public.agent_claim_job(p_agent uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j public.print_jobs; pr public.printer_devices; tok uuid := gen_random_uuid();
begin
  update public.print_jobs set status = 'unknown', last_error_code = 'lease_expired_after_submit'
   where agent_id = p_agent and status = 'submitting' and lease_expires_at < now();
  update public.print_jobs set status = 'failed', last_error_code = 'max_attempts'
   where agent_id = p_agent and status in ('claimed', 'rendering') and lease_expires_at < now() and attempt_count >= 3;

  select * into j from public.print_jobs
   where agent_id = p_agent
     and ((status = 'queued' and (retry_after is null or retry_after <= now()))
          or (status in ('claimed', 'rendering') and lease_expires_at < now() and attempt_count < 3))
   order by queued_at limit 1 for update skip locked;
  if not found then return null; end if;

  select * into pr from public.printer_devices where id = j.printer_id and organization_id = j.organization_id and active;
  if not found then
    update public.print_jobs set status = 'routing_error', last_error_code = 'printer_inactive' where id = j.id;
    return null;
  end if;
  update public.print_jobs set status = 'claimed', lease_token = tok, lease_expires_at = now() + interval '120 seconds',
    attempt_count = attempt_count + 1, claimed_at = now(), retry_after = null where id = j.id returning * into j;
  insert into public.print_job_events (organization_id, job_id, status, actor_agent_id, attempt) values (j.organization_id, j.id, 'claimed', p_agent, j.attempt_count);
  return jsonb_build_object('id', j.id, 'lease_token', tok, 'attempt', j.attempt_count, 'job_type', j.job_type,
    'invoice_id', j.invoice_id,
    'payload', j.payload, 'template', j.template_snapshot,
    'printer', jsonb_build_object('os_name', pr.os_printer_name, 'paper_w_mm', pr.paper_w_mm, 'paper_h_mm', pr.paper_h_mm,
                                  'offset_x_mm', pr.offset_x_mm, 'offset_y_mm', pr.offset_y_mm,
                                  'model_key', pr.model_key, 'legibility_floor_pt', pr.legibility_floor_pt));
end $$;
