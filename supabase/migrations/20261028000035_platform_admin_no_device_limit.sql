-- The 2-device login limit is for firm users. The platform administrator (The Valuation House) runs the service for every firm and
-- signs in from many places (and from every new web address): never refused, never takes a slot.
create or replace function public.device_login(p_user uuid, p_device text, p_name text, p_ip text, p_limit int default 2) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n int; others jsonb;
begin
  if exists (select 1 from public.platform_admins where user_id = p_user) then
    return jsonb_build_object('allowed', true);
  end if;
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
-- the administrator's old slots are no longer used
delete from public.user_devices where user_id in (select user_id from public.platform_admins);
