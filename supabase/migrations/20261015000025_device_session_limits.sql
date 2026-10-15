-- Login on at most 2 devices per user (owner decision, 2026-10-15).
-- * A 3rd device is REFUSED at login. Devices already signed in are never locked or signed out by this.
-- * A device frees its slot when the user logs out on it.
-- * Theft / emergency: an owner or administrator uses "Sign out of all devices": every session of that user ends and both slots
--   are free, so the user can sign in on a new device.
-- * The Print Agent is not a user login and is not counted.

create table if not exists public.user_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id text not null check (char_length(device_id) between 8 and 100),  -- random id in an http-only cookie of that browser
  device_name text not null default 'Web browser' check (char_length(device_name) <= 80),
  ip_address text check (ip_address is null or char_length(ip_address) <= 64),
  created_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  unique (user_id, device_id)
);
create index if not exists user_devices_user_idx on public.user_devices (user_id);
alter table public.user_devices enable row level security;   -- no direct access; read through list_user_devices
revoke all on public.user_devices from anon, authenticated;

-- Login (called by the website's login route with the service key, after the password was accepted).
create or replace function public.device_login(p_user uuid, p_device text, p_name text, p_ip text, p_limit int default 2) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n int; others jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('user_devices:' || p_user::text));   -- two logins at the same moment cannot both take the last slot
  update public.user_devices set last_active_at = now(), ip_address = left(p_ip, 64), device_name = left(coalesce(p_name, 'Web browser'), 80)
   where user_id = p_user and device_id = p_device;
  if found then return jsonb_build_object('allowed', true); end if;
  select count(*), coalesce(jsonb_agg(jsonb_build_object('name', device_name, 'since', created_at, 'last_active', last_active_at) order by created_at), '[]'::jsonb)
    into n, others from public.user_devices where user_id = p_user;
  if n >= greatest(p_limit, 1) then
    return jsonb_build_object('allowed', false, 'devices', others);
  end if;
  insert into public.user_devices (user_id, device_id, device_name, ip_address) values (p_user, p_device, left(coalesce(p_name, 'Web browser'), 80), left(p_ip, 64));
  return jsonb_build_object('allowed', true);
end $$;
revoke all on function public.device_login(uuid, text, text, text, int) from public, anon, authenticated;

-- Logout on this device frees its slot.
create or replace function public.device_logout(p_user uuid, p_device text) returns void
language sql security definer set search_path = '' as $$
  delete from public.user_devices where user_id = p_user and device_id = p_device;
$$;
revoke all on function public.device_logout(uuid, text) from public, anon, authenticated;

-- Owner / administrator: the firm's users with the devices they are signed in on.
create or replace function public.list_user_devices(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_permission(p_org, 'user.manage') then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role, 'login_id', p.login_id, 'full_name', p.full_name,
      'devices', (select coalesce(jsonb_agg(jsonb_build_object('name', d.device_name, 'since', d.created_at, 'last_active', d.last_active_at) order by d.created_at), '[]'::jsonb)
                  from public.user_devices d where d.user_id = m.user_id))
      order by m.role, p.login_id)
    from public.organization_memberships m left join public.profiles p on p.user_id = m.user_id
    where m.organization_id = p_org and m.status = 'active'), '[]'::jsonb);
end $$;
revoke all on function public.list_user_devices(uuid) from public, anon;
grant execute on function public.list_user_devices(uuid) to authenticated;

-- Owner / administrator: theft or emergency. Ends every session of the user (all devices) and frees both slots.
create or replace function public.sign_out_all_devices(p_org uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n int; s int;
begin
  perform public.assert_can(p_org, 'user.manage');
  if not exists (select 1 from public.organization_memberships where organization_id = p_org and user_id = p_user) then
    raise exception 'user_not_in_firm' using errcode = 'P0002';
  end if;
  delete from public.user_devices where user_id = p_user;
  get diagnostics n = row_count;
  delete from auth.sessions where user_id = p_user;   -- refresh tokens die with their session: every device is signed out
  get diagnostics s = row_count;
  perform public.write_audit(p_org, null, (select auth.uid()), 'user.signed_out_all_devices', 'user', p_user::text, null,
    jsonb_build_object('devices', n, 'sessions', s));
  return jsonb_build_object('devices', n, 'sessions', s);
end $$;
revoke all on function public.sign_out_all_devices(uuid, uuid) from public, anon;
grant execute on function public.sign_out_all_devices(uuid, uuid) to authenticated;
