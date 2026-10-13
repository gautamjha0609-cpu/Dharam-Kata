-- (1) Safe automatic retry: only failures that happen BEFORE anything is sent to the printer are retried.
--     An ambiguous outcome (lost acknowledgement after submit) stays UNKNOWN and is never resent.
-- (2) Credentials are admin-only: users cannot set/change their own login ID or password.

alter table public.print_jobs add column retry_after timestamptz;

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
    'payload', j.payload, 'template', j.template_snapshot,
    'printer', jsonb_build_object('os_name', pr.os_printer_name, 'paper_w_mm', pr.paper_w_mm, 'paper_h_mm', pr.paper_h_mm,
                                  'offset_x_mm', pr.offset_x_mm, 'offset_y_mm', pr.offset_y_mm));
end $$;

create or replace function public.agent_record_event(p_agent uuid, p_job uuid, p_lease uuid, p_status public.print_status, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare j public.print_jobs; retryable boolean;
begin
  select * into j from public.print_jobs where id = p_job and agent_id = p_agent for update;
  if not found or j.lease_token is distinct from p_lease then raise exception 'lease_invalid' using errcode = '42501'; end if;
  if not ((j.status = 'claimed' and p_status in ('rendering', 'submitting', 'failed'))
       or (j.status = 'rendering' and p_status in ('submitting', 'failed'))
       or (j.status = 'submitting' and p_status in ('submitted_to_spooler', 'failed'))) then
    raise exception 'invalid_transition' using errcode = '23514';
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

-- credentials: admin-set values are final (no forced change), users have no change function
create or replace function public.bootstrap_platform_admin(p_user uuid, p_login text, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (user_id, login_id, full_name, must_change_password) values (p_user, lower(p_login), p_name, false)
  on conflict (user_id) do nothing;
  insert into public.platform_admins (user_id, platform_role) values (p_user, 'super_admin')
  on conflict (user_id) do update set active = true, platform_role = 'super_admin', revoked_at = null;
  perform public.write_audit(null, null, p_user, 'platform.bootstrap_admin', 'user', p_user::text);
end $$;

alter table public.profiles alter column must_change_password set default false;
update public.profiles set must_change_password = false where must_change_password;
revoke execute on function public.complete_password_change() from authenticated;

create or replace function public.admin_flag_password_reset(p_actor uuid, p_org uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (exists (select 1 from public.platform_admins where user_id = p_actor and active and platform_role = 'super_admin')
          or exists (select 1 from public.organization_memberships where organization_id = p_org and user_id = p_actor and status = 'active' and role in ('owner', 'admin'))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.organization_memberships where organization_id = p_org and user_id = p_user) then
    raise exception 'user_not_in_org' using errcode = 'P0002';
  end if;
  perform public.write_audit(p_org, null, p_actor, 'user.password_set_by_admin', 'user', p_user::text);
end $$;

-- Admin changes a user's login ID. Tenant owner/admin: users of their own org (never an owner unless platform admin). Platform super admin: any.
create function public.admin_set_login_id(p_actor uuid, p_org uuid, p_user uuid, p_login text) returns void
language plpgsql security definer set search_path = '' as $$
declare platform boolean := exists (select 1 from public.platform_admins where user_id = p_actor and active and platform_role = 'super_admin');
  target_role public.org_role;
begin
  select role into target_role from public.organization_memberships where organization_id = p_org and user_id = p_user;
  if target_role is null then raise exception 'user_not_in_org' using errcode = 'P0002'; end if;
  if not (platform or (exists (select 1 from public.organization_memberships where organization_id = p_org and user_id = p_actor and status = 'active' and role in ('owner', 'admin'))
                       and target_role <> 'owner')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_login !~ '^[a-z0-9][a-z0-9._-]{2,31}$' then raise exception 'invalid_login_id' using errcode = '22023'; end if;
  update public.profiles set login_id = lower(p_login) where user_id = p_user;
  perform public.write_audit(p_org, null, p_actor, 'user.login_id_changed', 'user', p_user::text, null, jsonb_build_object('login', lower(p_login)));
exception when unique_violation then raise exception 'login_exists' using errcode = '23505';
end $$;
revoke all on function public.admin_set_login_id(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_set_login_id(uuid, uuid, uuid, text) to service_role;

-- platform admin: list members of any org (metadata only)
create function public.admin_list_members(p_actor uuid, p_org uuid)
returns table (user_id uuid, login_id text, full_name text, role public.org_role, status public.member_status)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.platform_admins where user_id = p_actor and active and platform_role = 'super_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query select m.user_id, p.login_id, p.full_name, m.role, m.status from public.organization_memberships m
    join public.profiles p on p.user_id = m.user_id where m.organization_id = p_org order by m.joined_at;
end $$;
revoke all on function public.admin_list_members(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_list_members(uuid, uuid) to service_role;
