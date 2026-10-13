-- Admin-provisioned identities (SRS A5). Auth users are created by the web server (service role);
-- these RPCs write the tenant rows atomically. service_role only; the server verifies the actor first.

create function public.bootstrap_platform_admin(p_user uuid, p_login text, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (user_id, login_id, full_name, must_change_password) values (p_user, lower(p_login), p_name, true)
  on conflict (user_id) do nothing;
  insert into public.platform_admins (user_id, platform_role) values (p_user, 'super_admin')
  on conflict (user_id) do update set active = true, platform_role = 'super_admin', revoked_at = null;
  perform public.write_audit(null, null, p_user, 'platform.bootstrap_admin', 'user', p_user::text);
end $$;

create function public.admin_create_organization(p_actor uuid, p_legal text, p_display text, p_slug text,
  p_owner uuid, p_owner_login text, p_owner_name text, p_site_name text, p_site_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_site uuid;
begin
  if not exists (select 1 from public.platform_admins where user_id = p_actor and active and platform_role = 'super_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.organizations (legal_name, display_name, slug, status) values (p_legal, p_display, lower(p_slug), 'active') returning id into v_org;
  insert into public.profiles (user_id, login_id, full_name) values (p_owner, lower(p_owner_login), p_owner_name);
  insert into public.organization_memberships (organization_id, user_id, role, invited_by) values (v_org, p_owner, 'owner', p_actor);
  insert into public.sites (organization_id, name, code) values (v_org, p_site_name, upper(p_site_code)) returning id into v_site;
  insert into public.pricing_settings (organization_id) values (v_org);
  perform public.write_audit(v_org, null, p_actor, 'org.create', 'organization', v_org::text, null, jsonb_build_object('slug', p_slug));
  return v_org;
end $$;

-- Adds a user to an org. Tenant owners/admins may add users to their own org only; platform super admin may add to any.
create function public.admin_create_member(p_actor uuid, p_org uuid, p_user uuid, p_login text, p_name text,
  p_role public.org_role, p_site_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare s uuid; actor_role public.org_role;
begin
  select role into actor_role from public.organization_memberships where organization_id = p_org and user_id = p_actor and status = 'active';
  if not (exists (select 1 from public.platform_admins where user_id = p_actor and active and platform_role = 'super_admin')
          or (actor_role in ('owner', 'admin') and (p_role <> 'owner'))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if actor_role = 'admin' and p_role = 'admin' then raise exception 'forbidden' using errcode = '42501'; end if;
  insert into public.profiles (user_id, login_id, full_name) values (p_user, lower(p_login), p_name);
  insert into public.organization_memberships (organization_id, user_id, role, invited_by) values (p_org, p_user, p_role, p_actor);
  foreach s in array coalesce(p_site_ids, '{}') loop
    insert into public.site_memberships (organization_id, site_id, user_id) values (p_org, s, p_user);
  end loop;
  perform public.write_audit(p_org, null, p_actor, 'user.create', 'user', p_user::text, null, jsonb_build_object('role', p_role, 'login', lower(p_login)));
end $$;

create function public.admin_set_org_status(p_actor uuid, p_org uuid, p_status public.org_status, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.platform_admins where user_id = p_actor and active and platform_role = 'super_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.organizations set status = p_status, suspended_at = case when p_status = 'suspended' then now() end,
    suspension_reason = case when p_status = 'suspended' then p_reason end where id = p_org;
  perform public.write_audit(p_org, null, p_actor, 'org.status', 'organization', p_org::text, p_reason, jsonb_build_object('status', p_status));
end $$;

create function public.admin_set_member_status(p_actor uuid, p_org uuid, p_user uuid, p_status public.member_status) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (exists (select 1 from public.platform_admins where user_id = p_actor and active and platform_role = 'super_admin')
          or exists (select 1 from public.organization_memberships where organization_id = p_org and user_id = p_actor and status = 'active' and role in ('owner', 'admin'))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.organization_memberships set status = p_status where organization_id = p_org and user_id = p_user and role <> 'owner';
  perform public.write_audit(p_org, null, p_actor, 'user.status', 'user', p_user::text, null, jsonb_build_object('status', p_status));
end $$;

create function public.admin_flag_password_reset(p_actor uuid, p_org uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (exists (select 1 from public.platform_admins where user_id = p_actor and active and platform_role = 'super_admin')
          or exists (select 1 from public.organization_memberships where organization_id = p_org and user_id = p_actor and status = 'active' and role in ('owner', 'admin'))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.organization_memberships where organization_id = p_org and user_id = p_user) then
    raise exception 'user_not_in_org' using errcode = 'P0002';
  end if;
  update public.profiles set must_change_password = true where user_id = p_user;
  perform public.write_audit(p_org, null, p_actor, 'user.password_reset', 'user', p_user::text);
end $$;

do $$ declare f text; begin
  foreach f in array array[
    'bootstrap_platform_admin(uuid, text, text)',
    'admin_create_organization(uuid, text, text, text, uuid, text, text, text, text)',
    'admin_create_member(uuid, uuid, uuid, text, text, public.org_role, uuid[])',
    'admin_set_org_status(uuid, uuid, public.org_status, text)',
    'admin_set_member_status(uuid, uuid, uuid, public.member_status)',
    'admin_flag_password_reset(uuid, uuid, uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
