-- Enforce "only an administrator can set/change passwords and login IDs" in the DATABASE.
-- Supabase Auth lets any signed-in user change their own password/email through its public API, so hiding the UI is
-- not enough. A trigger on auth.users rejects any password/email change unless a short-lived, single-use grant exists.
-- Grants are created only by the service-role admin RPCs below (after they verify the caller is an admin).

create table public.credential_change_grants (
  user_id uuid not null,
  kind text not null check (kind in ('password', 'email')),
  expires_at timestamptz not null,
  primary key (user_id, kind)
);
alter table public.credential_change_grants enable row level security;
revoke all on public.credential_change_grants from public, anon, authenticated;

create function public.guard_credential_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  if new.encrypted_password is distinct from old.encrypted_password then
    k := 'password';
  elsif new.email is distinct from old.email then
    k := 'email';
  else
    return new;
  end if;
  delete from public.credential_change_grants where user_id = new.id and kind = k and expires_at > now();
  if not found then
    raise exception 'credential_change_not_allowed: only an administrator can change this' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.guard_credential_change() from public, anon, authenticated;

create trigger guard_credential_change before update of encrypted_password, email on auth.users
  for each row execute function public.guard_credential_change();

-- admin RPCs now issue the grant (30 s, single use) right before the Auth admin API call
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
  insert into public.credential_change_grants (user_id, kind, expires_at) values (p_user, 'password', now() + interval '30 seconds')
  on conflict (user_id, kind) do update set expires_at = excluded.expires_at;
  perform public.write_audit(p_org, null, p_actor, 'user.password_set_by_admin', 'user', p_user::text);
end $$;

create or replace function public.admin_set_login_id(p_actor uuid, p_org uuid, p_user uuid, p_login text) returns void
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
  insert into public.credential_change_grants (user_id, kind, expires_at) values (p_user, 'email', now() + interval '30 seconds')
  on conflict (user_id, kind) do update set expires_at = excluded.expires_at;
  perform public.write_audit(p_org, null, p_actor, 'user.login_id_changed', 'user', p_user::text, null, jsonb_build_object('login', lower(p_login)));
exception when unique_violation then raise exception 'login_exists' using errcode = '23505';
end $$;
