-- Each client firm can have its own logo (still image or a short animated GIF, stored as WebP). Set only by the platform admin.
alter table public.tenant_assets drop constraint tenant_assets_kind_check;
alter table public.tenant_assets add constraint tenant_assets_kind_check check (kind in ('ticket_preview', 'logo'));

-- the signed-in user's context now also says whether (and how big) the firm's logo is, so the app can show it without an extra request
create or replace function public.me() returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'user_id', p.user_id, 'login_id', p.login_id, 'full_name', p.full_name,
    'must_change_password', p.must_change_password,
    'is_platform_admin', public.is_platform_admin(),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'organization_id', o.id, 'display_name', o.display_name, 'status', o.status, 'role', m.role,
        'permissions', (select coalesce(jsonb_agg(distinct x), '[]') from unnest(public.role_permissions(m.role) || m.permissions) x),
        'site_ids', (select coalesce(jsonb_agg(s.id), '[]') from public.sites s
                      where s.organization_id = o.id and public.has_site_access(o.id, s.id)),
        'logo_version', lg.version, 'logo_w', lg.width, 'logo_h', lg.height))
      from public.organization_memberships m join public.organizations o on o.id = m.organization_id
      left join public.tenant_assets lg on lg.organization_id = o.id and lg.kind = 'logo'
      where m.user_id = p.user_id and m.status = 'active'), '[]'))
  from public.profiles p where p.user_id = (select auth.uid()) and p.active
$$;
