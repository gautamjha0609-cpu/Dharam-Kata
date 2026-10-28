-- Platform admin panel: see on which devices each firm user is signed in, and "Sign out of all devices": every session of that user
-- ends and both device slots are free, so the user can log in on 2 new devices (e.g. after moving to a new website address).

create or replace function public.admin_user_devices(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.platform_admins where user_id = (select auth.uid())) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'devices',
      coalesce((select jsonb_agg(jsonb_build_object('name', d.device_name, 'last_active', d.last_active_at) order by d.created_at)
                from public.user_devices d where d.user_id = m.user_id), '[]'::jsonb)))
    from public.organization_memberships m where m.organization_id = p_org), '[]'::jsonb);
end $$;
revoke all on function public.admin_user_devices(uuid) from public, anon;
grant execute on function public.admin_user_devices(uuid) to authenticated;

create or replace function public.admin_sign_out_all_devices(p_org uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n int; s int;
begin
  if not exists (select 1 from public.platform_admins where user_id = (select auth.uid())) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.organization_memberships where organization_id = p_org and user_id = p_user) then
    raise exception 'user_not_in_firm' using errcode = 'P0002';
  end if;
  delete from public.user_devices where user_id = p_user;
  get diagnostics n = row_count;
  delete from auth.sessions where user_id = p_user;   -- refresh tokens end with their session: every device is signed out
  get diagnostics s = row_count;
  perform public.write_audit(p_org, null, (select auth.uid()), 'user.signed_out_all_devices', 'user', p_user::text, 'platform admin',
    jsonb_build_object('devices', n, 'sessions', s));
  return jsonb_build_object('devices', n, 'sessions', s);
end $$;
revoke all on function public.admin_sign_out_all_devices(uuid, uuid) from public, anon;
grant execute on function public.admin_sign_out_all_devices(uuid, uuid) to authenticated;
