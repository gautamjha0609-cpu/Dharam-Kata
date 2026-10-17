-- Copies per slip (owner decision, 2026-10-17).
-- * The layout has default copies for the OPENING slip (copiesOpening) and the CLOSING slip (copiesClosing); old layouts keep "copies".
-- * "Customize copies" on the weighment screen sets the copies of that ONE slip only (stored under the entry's idempotency key just
--   before the entry is saved, used once by the print job, then deleted). Defaults never change.
-- * The number is written into the job's layout snapshot ("copies"), which every Print Agent version already prints.

create table if not exists public.print_copy_overrides (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  idem_key text not null check (char_length(idem_key) between 8 and 200),
  copies int not null check (copies between 1 and 5),
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (organization_id, idem_key)
);
alter table public.print_copy_overrides enable row level security;   -- written and read only by the functions below
revoke all on public.print_copy_overrides from anon, authenticated;

-- Called by the weighment screen right before open_entry / close_entry with the SAME idempotency key.
create or replace function public.set_slip_copies(p_org uuid, p_idem text, p_copies int) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_can(p_org, 'weighment.create');
  if p_copies is null or p_copies < 1 or p_copies > 5 then raise exception 'invalid_copies' using errcode = '22023'; end if;
  if p_idem is null or char_length(p_idem) < 8 then raise exception 'idempotency_key_required' using errcode = '22023'; end if;
  delete from public.print_copy_overrides where created_at < now() - interval '1 day';   -- never-used choices (entry not saved)
  insert into public.print_copy_overrides (organization_id, idem_key, copies, created_by) values (p_org, p_idem, p_copies, (select auth.uid()))
  on conflict (organization_id, idem_key) do update set copies = excluded.copies, created_at = now();
end $$;
revoke all on function public.set_slip_copies(uuid, text, int) from public, anon;
grant execute on function public.set_slip_copies(uuid, text, int) to authenticated;

-- Same as before (route + durable job, fails closed) plus: copies of this slip written into the layout snapshot.
create or replace function public.enqueue_print_job(inv public.invoices, p_type public.print_job_type, p_reason text, p_by uuid, p_idem text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare d record; tpl record; st public.print_status := 'queued'; v_job uuid; vals jsonb; v_layout jsonb; v_custom int; v_copies int; v_key text;
begin
  vals := public.build_print_values(inv);
  select pd.printer_id, pr.agent_id, pr.site_id as dest_site, pr.offset_x_mm, pr.offset_y_mm, pr.active as printer_active, ag.status as agent_status
    into d
  from public.print_destinations pd
  join public.printer_devices pr on pr.id = pd.printer_id and pr.organization_id = pd.organization_id
  join public.print_agents ag on ag.id = pr.agent_id and ag.organization_id = pr.organization_id
  where pd.organization_id = inv.organization_id and pd.origin_site_id = inv.site_id and pd.active
  order by pd.is_default desc, pd.created_at limit 1;

  if not found then st := 'not_configured';
  elsif not d.printer_active or d.agent_status <> 'active' then st := 'routing_error';
  end if;

  select * into tpl from public.resolve_template(inv.organization_id, inv.site_id, d.printer_id);

  -- copies: this slip's own choice (original slips only), else the layout's default for opening / closing
  v_layout := tpl.o_layout;
  if p_type = 'original' then
    v_key := case when inv.stage = 'open' then inv.idempotency_key else inv.close_idempotency_key end;
    if v_key is not null then
      delete from public.print_copy_overrides where organization_id = inv.organization_id and idem_key = v_key returning copies into v_custom;
    end if;
  end if;
  if v_layout is not null then
    v_copies := coalesce(v_custom, case when inv.stage = 'open' then (v_layout->>'copiesOpening')::int else (v_layout->>'copiesClosing')::int end);
    if v_copies between 1 and 5 then v_layout := jsonb_set(v_layout, '{copies}', to_jsonb(v_copies)); end if;
  end if;

  insert into public.print_jobs (organization_id, invoice_id, origin_site_id, destination_site_id, printer_id, agent_id, job_type, status,
    idempotency_key, reprint_reason, requested_by, payload, template_version_id, template_snapshot)
  values (inv.organization_id, inv.id, inv.site_id, d.dest_site,
    case when st in ('queued') then d.printer_id end, case when st in ('queued') then d.agent_id end,
    p_type, st, p_idem, p_reason, p_by,
    vals || jsonb_build_object('_calibration', jsonb_build_object('x', coalesce(d.offset_x_mm, 0), 'y', coalesce(d.offset_y_mm, 0))),
    tpl.o_version, v_layout)
  returning id into v_job;
  insert into public.print_job_events (organization_id, job_id, status, actor_user_id) values (inv.organization_id, v_job, st, p_by);
  return v_job;
end $$;
revoke all on function public.enqueue_print_job(public.invoices, public.print_job_type, text, uuid, text) from public, anon, authenticated;
