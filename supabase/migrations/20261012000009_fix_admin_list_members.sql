-- Fix: unqualified column names clashed with the RETURNS TABLE output columns (ambiguous reference).
create or replace function public.admin_list_members(p_actor uuid, p_org uuid)
returns table (user_id uuid, login_id text, full_name text, role public.org_role, status public.member_status)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.platform_admins pa where pa.user_id = p_actor and pa.active and pa.platform_role = 'super_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query select m.user_id, p.login_id, p.full_name, m.role, m.status from public.organization_memberships m
    join public.profiles p on p.user_id = m.user_id where m.organization_id = p_org order by m.joined_at;
end $$;
