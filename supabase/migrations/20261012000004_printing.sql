-- Print routing, templates, durable queue (SRS section 8, A2, A6, A7, A9).
-- Agents never get table access: they talk to the web server, which calls the service-role-only RPCs below.

create type public.print_status as enum
  ('not_configured', 'routing_error', 'queued', 'claimed', 'rendering', 'submitting',
   'submitted_to_spooler', 'failed', 'unknown', 'cancelled');
create type public.print_job_type as enum ('original', 'reprint', 'test');
create type public.agent_status as enum ('active', 'revoked');
create type public.template_scope as enum ('tenant', 'site', 'printer');

create table public.print_agents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  site_id uuid not null,
  label text not null,
  status public.agent_status not null default 'active',
  credential_hash text not null unique,
  app_version text, os text,
  printers_seen jsonb not null default '[]'::jsonb,
  last_heartbeat_at timestamptz,
  revoked_at timestamptz,
  created_by uuid, created_at timestamptz not null default now(),
  foreign key (site_id, organization_id) references public.sites (id, organization_id),
  unique (id, organization_id)
);
create index print_agents_site_idx on public.print_agents (site_id, organization_id);

create table public.pairing_codes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  site_id uuid not null,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid not null, created_at timestamptz not null default now(),
  foreign key (site_id, organization_id) references public.sites (id, organization_id)
);
create index pairing_codes_site_idx on public.pairing_codes (site_id, organization_id);

create table public.printer_devices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  site_id uuid not null,
  agent_id uuid not null,
  label text not null,
  os_printer_name text not null,            -- exact Windows device name
  paper_w_mm numeric(6,1) not null default 170 check (paper_w_mm between 20 and 500),
  paper_h_mm numeric(6,1) not null default 95 check (paper_h_mm between 20 and 500),
  offset_x_mm numeric(5,2) not null default 0 check (offset_x_mm between -30 and 30),
  offset_y_mm numeric(5,2) not null default 0 check (offset_y_mm between -30 and 30),
  active boolean not null default true,
  last_test_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (agent_id, organization_id) references public.print_agents (id, organization_id),
  foreign key (site_id, organization_id) references public.sites (id, organization_id),
  unique (id, organization_id),
  unique (agent_id, os_printer_name)
);
create index printer_devices_agent_idx on public.printer_devices (agent_id, organization_id);
create index printer_devices_site_idx on public.printer_devices (site_id, organization_id);

create table public.print_destinations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  origin_site_id uuid not null,
  printer_id uuid not null,
  is_default boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (origin_site_id, organization_id) references public.sites (id, organization_id),
  foreign key (printer_id, organization_id) references public.printer_devices (id, organization_id),
  unique (origin_site_id, printer_id)
);
create index print_destinations_org_idx on public.print_destinations (organization_id, origin_site_id);
create index print_destinations_printer_idx on public.print_destinations (printer_id, organization_id);

create table public.receipt_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  scope public.template_scope not null default 'tenant',
  site_id uuid, printer_id uuid,
  name text not null check (char_length(name) between 1 and 80),
  draft_layout jsonb not null,
  published_version_id uuid,
  updated_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key (site_id, organization_id) references public.sites (id, organization_id),
  foreign key (printer_id, organization_id) references public.printer_devices (id, organization_id),
  unique (id, organization_id),
  check ((draft_layout->'paper'->>'w')::numeric between 20 and 500 and (draft_layout->'paper'->>'h')::numeric between 20 and 500),
  check ((scope = 'tenant') or (scope = 'site' and site_id is not null) or (scope = 'printer' and printer_id is not null))
);
create index receipt_templates_site_idx on public.receipt_templates (site_id, organization_id);
create index receipt_templates_printer_idx on public.receipt_templates (printer_id, organization_id);

create table public.receipt_template_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  template_id uuid not null,
  version_no int not null,
  layout jsonb not null,
  checksum text not null,
  published_by uuid not null, published_at timestamptz not null default now(),
  foreign key (template_id, organization_id) references public.receipt_templates (id, organization_id),
  unique (template_id, version_no)
);
create trigger template_versions_append_only before update or delete on public.receipt_template_versions
  for each row execute function public.immutable_row();

create table public.print_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  invoice_id uuid not null,
  origin_site_id uuid not null,
  destination_site_id uuid,
  printer_id uuid,
  agent_id uuid,
  job_type public.print_job_type not null default 'original',
  status public.print_status not null default 'queued',
  idempotency_key text not null,
  attempt_count int not null default 0,
  lease_token uuid, lease_expires_at timestamptz,
  queued_at timestamptz not null default now(),
  claimed_at timestamptz, submitted_at timestamptz, reported_at timestamptz,
  last_error_code text,
  reprint_reason text, requested_by uuid,
  payload jsonb not null,                   -- immutable invoice values snapshot
  template_version_id uuid,
  template_snapshot jsonb,                  -- exact layout used
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key (invoice_id, organization_id) references public.invoices (id, organization_id),
  foreign key (origin_site_id, organization_id) references public.sites (id, organization_id),
  foreign key (printer_id, organization_id) references public.printer_devices (id, organization_id),
  foreign key (agent_id, organization_id) references public.print_agents (id, organization_id),
  unique (organization_id, idempotency_key)
);
create trigger print_jobs_updated before update on public.print_jobs for each row execute function public.set_updated_at();
create index print_jobs_agent_idx on public.print_jobs (organization_id, agent_id, status, queued_at);
create index print_jobs_invoice_idx on public.print_jobs (invoice_id, organization_id);
create index print_jobs_site_idx on public.print_jobs (origin_site_id, organization_id);
create index print_jobs_printer_idx on public.print_jobs (printer_id, organization_id);

create table public.print_job_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  job_id uuid not null references public.print_jobs (id),
  actor_agent_id uuid, actor_user_id uuid,
  status public.print_status not null,
  error_code text, attempt int,
  created_at timestamptz not null default now()
);
create index print_job_events_job_idx on public.print_job_events (job_id, created_at);
create trigger print_job_events_append_only before update or delete on public.print_job_events
  for each row execute function public.immutable_row();

-- RLS ----------------------------------------------------------------------------------------------
alter table public.print_agents enable row level security;
alter table public.pairing_codes enable row level security;
alter table public.printer_devices enable row level security;
alter table public.print_destinations enable row level security;
alter table public.receipt_templates enable row level security;
alter table public.receipt_template_versions enable row level security;
alter table public.print_jobs enable row level security;
alter table public.print_job_events enable row level security;

-- credential_hash must never reach the browser: expose agents through a safe view only.
create policy agents_read on public.print_agents for select to authenticated
  using (public.has_permission(organization_id, 'print.route.manage') or public.has_permission(organization_id, 'print.view'));

create policy printers_read on public.printer_devices for select to authenticated
  using (public.has_permission(organization_id, 'print.view') and (public.has_site_access(organization_id, site_id) or public.has_permission(organization_id, 'print.route.manage')));
create policy destinations_read on public.print_destinations for select to authenticated
  using (public.has_permission(organization_id, 'print.view') and (public.has_site_access(organization_id, origin_site_id) or public.has_permission(organization_id, 'print.route.manage')));
create policy templates_read on public.receipt_templates for select to authenticated
  using (public.has_permission(organization_id, 'template.manage') or public.has_permission(organization_id, 'print.view'));
create policy template_versions_read on public.receipt_template_versions for select to authenticated
  using (public.has_permission(organization_id, 'template.manage') or public.has_permission(organization_id, 'print.view'));
create policy jobs_read on public.print_jobs for select to authenticated
  using (public.has_permission(organization_id, 'print.view')
         and (public.has_site_access(organization_id, origin_site_id)
              or (destination_site_id is not null and public.has_site_access(organization_id, destination_site_id))));
create policy job_events_read on public.print_job_events for select to authenticated
  using (exists (select 1 from public.print_jobs j where j.id = job_id and j.organization_id = print_job_events.organization_id
    and public.has_permission(j.organization_id, 'print.view')
    and (public.has_site_access(j.organization_id, j.origin_site_id)
         or (j.destination_site_id is not null and public.has_site_access(j.organization_id, j.destination_site_id)))));

revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;
revoke all on all tables in schema public from anon;
-- credential_hash is never selectable by clients: column-level grant only
revoke all on public.print_agents from authenticated;
grant select (id, organization_id, site_id, label, status, app_version, os, printers_seen, last_heartbeat_at, revoked_at, created_at)
  on public.print_agents to authenticated;
grant select on public.invoice_balances to authenticated;

-- Payload builder: the ONLY data an agent receives (typed values, no raw rows). -------------------------
create function public.build_print_values(inv public.invoices) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'serial', inv.invoice_number,
    'party', inv.party_name,
    'material', inv.material,
    'vehicle', inv.vehicle_display,
    'gross_weight', trim_scale(inv.gross_weight_kg)::text,
    'gross_date', to_char(inv.gross_weight_at at time zone o.timezone, 'DD/MM/YYYY'),
    'gross_time', to_char(inv.gross_weight_at at time zone o.timezone, 'HH24:MI'),
    'tare_weight', trim_scale(inv.tare_weight_kg)::text,
    'tare_date', to_char(inv.tare_weight_at at time zone o.timezone, 'DD/MM/YYYY'),
    'tare_time', to_char(inv.tare_weight_at at time zone o.timezone, 'HH24:MI'),
    'net_weight', trim_scale(inv.net_weight_kg)::text,
    'charge', trim_scale(inv.fee_total)::text,
    'payment_mode', inv.payment_mode::text,
    'notes', inv.notes))
  from public.organizations o where o.id = inv.organization_id
$$;
revoke all on function public.build_print_values(public.invoices) from public, anon, authenticated;

-- Template resolution: printer override -> site -> tenant (system default lives in the agent bundle).
create function public.resolve_template(p_org uuid, p_site uuid, p_printer uuid, out o_version uuid, out o_layout jsonb)
language sql stable security definer set search_path = '' as $$
  select v.id, v.layout
  from public.receipt_templates t
  join public.receipt_template_versions v on v.id = t.published_version_id
  where t.organization_id = p_org
    and ((t.scope = 'printer' and t.printer_id = p_printer) or (t.scope = 'site' and t.site_id = p_site) or t.scope = 'tenant')
  order by case t.scope when 'printer' then 1 when 'site' then 2 else 3 end
  limit 1
$$;
revoke all on function public.resolve_template(uuid, uuid, uuid) from public, anon, authenticated;

-- Server-resolved route + durable job. Fails closed: never guesses a printer. -----------------------------
create function public.enqueue_print_job(inv public.invoices, p_type public.print_job_type, p_reason text, p_by uuid, p_idem text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare d record; tpl record; st public.print_status := 'queued'; v_job uuid; vals jsonb;
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

  insert into public.print_jobs (organization_id, invoice_id, origin_site_id, destination_site_id, printer_id, agent_id, job_type, status,
    idempotency_key, reprint_reason, requested_by, payload, template_version_id, template_snapshot)
  values (inv.organization_id, inv.id, inv.site_id, d.dest_site,
    case when st in ('queued') then d.printer_id end, case when st in ('queued') then d.agent_id end,
    p_type, st, p_idem, p_reason, p_by,
    vals || jsonb_build_object('_calibration', jsonb_build_object('x', coalesce(d.offset_x_mm, 0), 'y', coalesce(d.offset_y_mm, 0))),
    tpl.o_version, tpl.o_layout)
  returning id into v_job;
  insert into public.print_job_events (organization_id, job_id, status, actor_user_id) values (inv.organization_id, v_job, st, p_by);
  return v_job;
end $$;
revoke all on function public.enqueue_print_job(public.invoices, public.print_job_type, text, uuid, text) from public, anon, authenticated;

-- Atomic with invoice creation: AFTER INSERT in the same transaction. A routing problem never rolls back the invoice.
create function public.invoice_enqueue_trigger() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform public.enqueue_print_job(new, 'original', null, new.issued_by, 'orig:' || new.id::text);
  exception when others then
    insert into public.print_jobs (organization_id, invoice_id, origin_site_id, job_type, status, idempotency_key, payload, last_error_code)
    values (new.organization_id, new.id, new.site_id, 'original', 'routing_error', 'orig:' || new.id::text, '{}'::jsonb, 'enqueue_failed');
  end;
  return new;
end $$;
create trigger invoices_enqueue after insert on public.invoices for each row execute function public.invoice_enqueue_trigger();

-- User-facing print actions -----------------------------------------------------------------------------
create function public.reprint_invoice(p_org uuid, p_invoice uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare inv public.invoices; j uuid;
begin
  select * into inv from public.invoices where id = p_invoice and organization_id = p_org;
  if not found then raise exception 'invoice_not_found' using errcode = 'P0002'; end if;
  perform public.assert_can(p_org, 'print.reprint', inv.site_id);
  if char_length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required' using errcode = '22023'; end if;
  if inv.status <> 'issued' then raise exception 'invoice_not_issued' using errcode = '23514'; end if;
  j := public.enqueue_print_job(inv, 'reprint', p_reason, (select auth.uid()), 'reprint:' || gen_random_uuid()::text);
  perform public.write_audit(p_org, inv.site_id, (select auth.uid()), 'print.reprint', 'invoice', inv.id::text, p_reason);
  return j;
end $$;

create function public.create_pairing_code(p_org uuid, p_site uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare code text := upper(encode(extensions.gen_random_bytes(4), 'hex')); exp timestamptz := now() + interval '10 minutes';
begin
  perform public.assert_can(p_org, 'print.route.manage', p_site);
  insert into public.pairing_codes (organization_id, site_id, code_hash, expires_at, created_by)
  values (p_org, p_site, encode(extensions.digest(code, 'sha256'), 'hex'), exp, (select auth.uid()));
  perform public.write_audit(p_org, p_site, (select auth.uid()), 'agent.pairing_code', 'site', p_site::text);
  return jsonb_build_object('code', code, 'expires_at', exp);   -- shown once; only the hash is stored
end $$;

create function public.bind_printer(p_org uuid, p_agent uuid, p_os_name text, p_label text, p_w numeric, p_h numeric,
  p_set_default_route boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ag public.print_agents; pr public.printer_devices;
begin
  select * into ag from public.print_agents where id = p_agent and organization_id = p_org and status = 'active';
  if not found then raise exception 'agent_not_found' using errcode = 'P0002'; end if;
  perform public.assert_can(p_org, 'print.route.manage', ag.site_id);
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

create function public.set_printer_calibration(p_org uuid, p_printer uuid, p_x numeric, p_y numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare pr public.printer_devices;
begin
  select * into pr from public.printer_devices where id = p_printer and organization_id = p_org;
  if not found then raise exception 'printer_not_found' using errcode = 'P0002'; end if;
  perform public.assert_can(p_org, 'print.route.manage', pr.site_id);
  update public.printer_devices set offset_x_mm = p_x, offset_y_mm = p_y where id = pr.id;
  perform public.write_audit(p_org, pr.site_id, (select auth.uid()), 'printer.calibrate', 'printer', pr.id::text, null, jsonb_build_object('x', p_x, 'y', p_y));
end $$;

create function public.revoke_agent(p_org uuid, p_agent uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare ag public.print_agents;
begin
  select * into ag from public.print_agents where id = p_agent and organization_id = p_org;
  if not found then raise exception 'agent_not_found' using errcode = 'P0002'; end if;
  perform public.assert_can(p_org, 'print.route.manage', ag.site_id);
  update public.print_agents set status = 'revoked', revoked_at = now() where id = ag.id;
  update public.print_jobs set status = 'cancelled' where agent_id = ag.id and status = 'queued';
  perform public.write_audit(p_org, ag.site_id, (select auth.uid()), 'agent.revoke', 'agent', ag.id::text);
end $$;

-- Template publishing (immutable versions) ---------------------------------------------------------------
create function public.save_template_draft(p_org uuid, p_id uuid, p_name text, p_scope public.template_scope,
  p_site uuid, p_printer uuid, p_layout jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.receipt_templates;
begin
  perform public.assert_can(p_org, 'template.manage');
  if p_id is null then
    insert into public.receipt_templates (organization_id, scope, site_id, printer_id, name, draft_layout, updated_by)
    values (p_org, p_scope, p_site, p_printer, p_name, p_layout, (select auth.uid())) returning * into t;
  else
    update public.receipt_templates set name = p_name, draft_layout = p_layout, updated_by = (select auth.uid())
    where id = p_id and organization_id = p_org returning * into t;
    if not found then raise exception 'template_not_found' using errcode = 'P0002'; end if;
  end if;
  return to_jsonb(t);
end $$;

create function public.publish_template(p_org uuid, p_template uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.receipt_templates; n int; v public.receipt_template_versions;
begin
  perform public.assert_can(p_org, 'template.manage');
  select * into t from public.receipt_templates where id = p_template and organization_id = p_org for update;
  if not found then raise exception 'template_not_found' using errcode = 'P0002'; end if;
  select coalesce(max(version_no), 0) + 1 into n from public.receipt_template_versions where template_id = t.id;
  insert into public.receipt_template_versions (organization_id, template_id, version_no, layout, checksum, published_by)
  values (p_org, t.id, n, t.draft_layout, encode(extensions.digest(t.draft_layout::text, 'sha256'), 'hex'), (select auth.uid()))
  returning * into v;
  update public.receipt_templates set published_version_id = v.id where id = t.id;
  perform public.write_audit(p_org, null, (select auth.uid()), 'template.publish', 'template', t.id::text, null, jsonb_build_object('version', n));
  return to_jsonb(v);
end $$;

create function public.revert_template(p_org uuid, p_template uuid, p_version int) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.receipt_template_versions;
begin
  perform public.assert_can(p_org, 'template.manage');
  select * into v from public.receipt_template_versions where template_id = p_template and organization_id = p_org and version_no = p_version;
  if not found then raise exception 'version_not_found' using errcode = 'P0002'; end if;
  update public.receipt_templates set published_version_id = v.id, draft_layout = v.layout where id = p_template and organization_id = p_org;
  perform public.write_audit(p_org, null, (select auth.uid()), 'template.revert', 'template', p_template::text, null, jsonb_build_object('version', p_version));
end $$;

-- AGENT-ONLY RPCs (service_role): identity is the agent row resolved from a hashed device token. ------------
create function public.agent_pair(p_code text, p_label text, p_os text, out o_agent uuid, out o_token text, out o_org uuid, out o_site uuid)
language plpgsql security definer set search_path = '' as $$
declare pc public.pairing_codes; tok text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  select * into pc from public.pairing_codes
   where code_hash = encode(extensions.digest(upper(btrim(p_code)), 'sha256'), 'hex') and used_at is null and expires_at > now() for update;
  if not found then raise exception 'invalid_or_expired_code' using errcode = '28000'; end if;
  update public.pairing_codes set used_at = now() where id = pc.id;
  insert into public.print_agents (organization_id, site_id, label, os, credential_hash, created_by)
  values (pc.organization_id, pc.site_id, left(p_label, 80), left(p_os, 80), encode(extensions.digest(tok, 'sha256'), 'hex'), pc.created_by)
  returning id into o_agent;
  o_token := tok; o_org := pc.organization_id; o_site := pc.site_id;
  perform public.write_audit(pc.organization_id, pc.site_id, pc.created_by, 'agent.paired', 'agent', o_agent::text);
end $$;

create function public.agent_authenticate(p_token text) returns uuid
language sql stable security definer set search_path = '' as $$
  select a.id from public.print_agents a
  where a.credential_hash = encode(extensions.digest(p_token, 'sha256'), 'hex') and a.status = 'active'
    and exists (select 1 from public.organizations o where o.id = a.organization_id and o.status <> 'archived')
$$;

create function public.agent_heartbeat(p_agent uuid, p_version text, p_os text, p_printers jsonb) returns void
language sql security definer set search_path = '' as $$
  update public.print_agents set last_heartbeat_at = now(), app_version = left(p_version, 40), os = left(p_os, 80),
    printers_seen = coalesce(p_printers, '[]'::jsonb) where id = p_agent and status = 'active';
$$;

-- Atomic claim with lease; an agent can only ever see jobs addressed to itself.
create function public.agent_claim_job(p_agent uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j public.print_jobs; pr public.printer_devices; tok uuid := gen_random_uuid();
begin
  -- lost acknowledgement after submission => UNKNOWN (never auto-retried: could duplicate a physical print)
  update public.print_jobs set status = 'unknown', last_error_code = 'lease_expired_after_submit'
   where agent_id = p_agent and status = 'submitting' and lease_expires_at < now();
  -- failed before submission => retry up to 3 attempts
  update public.print_jobs set status = 'failed', last_error_code = 'max_attempts'
   where agent_id = p_agent and status in ('claimed', 'rendering') and lease_expires_at < now() and attempt_count >= 3;

  select * into j from public.print_jobs
   where agent_id = p_agent and (status = 'queued' or (status in ('claimed', 'rendering') and lease_expires_at < now() and attempt_count < 3))
   order by queued_at limit 1 for update skip locked;
  if not found then return null; end if;

  select * into pr from public.printer_devices where id = j.printer_id and organization_id = j.organization_id and active;
  if not found then
    update public.print_jobs set status = 'routing_error', last_error_code = 'printer_inactive' where id = j.id;
    return null;
  end if;
  update public.print_jobs set status = 'claimed', lease_token = tok, lease_expires_at = now() + interval '120 seconds',
    attempt_count = attempt_count + 1, claimed_at = now() where id = j.id returning * into j;
  insert into public.print_job_events (organization_id, job_id, status, actor_agent_id, attempt) values (j.organization_id, j.id, 'claimed', p_agent, j.attempt_count);
  return jsonb_build_object('id', j.id, 'lease_token', tok, 'attempt', j.attempt_count, 'job_type', j.job_type,
    'payload', j.payload, 'template', j.template_snapshot,
    'printer', jsonb_build_object('os_name', pr.os_printer_name, 'paper_w_mm', pr.paper_w_mm, 'paper_h_mm', pr.paper_h_mm,
                                  'offset_x_mm', pr.offset_x_mm, 'offset_y_mm', pr.offset_y_mm));
end $$;

create function public.agent_record_event(p_agent uuid, p_job uuid, p_lease uuid, p_status public.print_status, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare j public.print_jobs;
begin
  select * into j from public.print_jobs where id = p_job and agent_id = p_agent for update;
  if not found or j.lease_token is distinct from p_lease then raise exception 'lease_invalid' using errcode = '42501'; end if;
  if not ((j.status = 'claimed' and p_status in ('rendering', 'submitting', 'failed'))
       or (j.status = 'rendering' and p_status in ('submitting', 'failed'))
       or (j.status = 'submitting' and p_status in ('submitted_to_spooler', 'failed'))) then
    raise exception 'invalid_transition' using errcode = '23514';
  end if;
  update public.print_jobs set status = p_status, last_error_code = left(p_error, 80),
    lease_expires_at = case when p_status in ('rendering', 'submitting') then now() + interval '120 seconds' else lease_expires_at end,
    submitted_at = case when p_status = 'submitted_to_spooler' then now() else submitted_at end,
    reported_at = case when p_status in ('submitted_to_spooler', 'failed') then now() else reported_at end
  where id = j.id;
  insert into public.print_job_events (organization_id, job_id, status, actor_agent_id, error_code, attempt)
  values (j.organization_id, j.id, p_status, p_agent, left(p_error, 80), j.attempt_count);
end $$;

-- grants: user RPCs to authenticated; agent RPCs to service_role ONLY
do $$ declare f text; begin
  foreach f in array array['reprint_invoice(uuid, uuid, text)', 'create_pairing_code(uuid, uuid)',
    'bind_printer(uuid, uuid, text, text, numeric, numeric, boolean)', 'set_printer_calibration(uuid, uuid, numeric, numeric)',
    'revoke_agent(uuid, uuid)', 'save_template_draft(uuid, uuid, text, public.template_scope, uuid, uuid, jsonb)',
    'publish_template(uuid, uuid)', 'revert_template(uuid, uuid, int)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['agent_pair(text, text, text)', 'agent_authenticate(text)', 'agent_heartbeat(uuid, text, text, jsonb)',
    'agent_claim_job(uuid)', 'agent_record_event(uuid, uuid, uuid, public.print_status, text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
