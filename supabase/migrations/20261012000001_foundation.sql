-- Dharam Kata foundation: tenants, users, sites, memberships, audit, RLS helpers.
-- SRS v1.1 sections 2, 6.2, 7. Tenant isolation is enforced here, not in the UI.

create type public.org_status as enum ('trial', 'active', 'grace', 'suspended', 'archived');
create type public.org_role as enum ('owner', 'admin', 'operator', 'accounts', 'remote_site');
create type public.platform_role as enum ('super_admin', 'support');
create type public.member_status as enum ('active', 'disabled');

create function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;

-- profiles ---------------------------------------------------------------
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  login_id text not null,
  full_name text not null default '',
  phone text,
  active boolean not null default true,
  must_change_password boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index profiles_login_id_key on public.profiles (lower(login_id));
create trigger profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();

create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  platform_role public.platform_role not null,
  active boolean not null default true,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- organizations ----------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null,
  display_name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  status public.org_status not null default 'trial',
  plan_code text not null default 'pilot',
  timezone text not null default 'Asia/Kolkata',
  currency text not null default 'INR' check (char_length(currency) = 3),
  -- tenant settings; must never hold secrets
  settings jsonb not null default '{}'::jsonb,
  settings_version int not null default 1,
  suspended_at timestamptz,
  suspension_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger organizations_updated before update on public.organizations
  for each row execute function public.set_updated_at();

create table public.sites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  name text not null,
  code text not null,
  address text,
  timezone text not null default 'Asia/Kolkata',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code),
  unique (id, organization_id)  -- target for composite FKs that pin child org = parent org
);
create trigger sites_updated before update on public.sites
  for each row execute function public.set_updated_at();

create table public.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.org_role not null,
  -- extra explicit permissions on top of the role defaults (deny by default)
  permissions text[] not null default '{}',
  status public.member_status not null default 'active',
  invited_by uuid references auth.users (id),
  joined_at timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index memberships_user_idx on public.organization_memberships (user_id) where status = 'active';

create table public.site_memberships (
  organization_id uuid not null,
  site_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (site_id, user_id),
  foreign key (site_id, organization_id) references public.sites (id, organization_id) on delete cascade,
  foreign key (organization_id, user_id) references public.organization_memberships (organization_id, user_id) on delete cascade
);
create index site_memberships_user_idx on public.site_memberships (user_id) where active;

-- audit ------------------------------------------------------------------
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id),
  site_id uuid,
  actor_id uuid,
  actor_role text,
  action text not null,
  entity_type text,
  entity_id text,
  reason text,
  request_id text,
  meta jsonb not null default '{}'::jsonb,  -- sanitized before/after only, never secrets
  created_at timestamptz not null default now()
);
create index audit_logs_org_time_idx on public.audit_logs (organization_id, created_at desc);

-- Append-only: nobody (incl. service role via API) may update/delete audit rows.
create function public.audit_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception 'audit_logs is append-only'; end $$;
create trigger audit_logs_no_change before update or delete on public.audit_logs
  for each row execute function public.audit_immutable();

-- permission model -------------------------------------------------------
create function public.role_permissions(r public.org_role) returns text[]
language sql immutable set search_path = '' as $$
  select case r
    when 'owner' then array['org.manage','site.manage','user.manage','party.manage','pricing.manage','series.manage',
      'template.manage','print.route.manage','weighment.create','weighment.complete','invoice.finalize','invoice.cancel',
      'invoice.read','payment.record','report.view','report.export','print.view','print.test','print.reprint','audit.view']
    when 'admin' then array['site.manage','user.manage','party.manage','pricing.manage','series.manage',
      'template.manage','print.route.manage','weighment.create','weighment.complete','invoice.finalize','invoice.cancel',
      'invoice.read','payment.record','report.view','report.export','print.view','print.test','print.reprint','audit.view']
    when 'operator' then array['weighment.create','weighment.complete','invoice.read','party.read','print.view']
    when 'accounts' then array['invoice.read','party.manage','payment.record','report.view','report.export','print.view']
    when 'remote_site' then array['invoice.read','print.view']
  end
$$;

-- RLS helpers: SECURITY DEFINER, fixed search_path, never trust client-sent ids.
create function public.is_platform_admin(roles public.platform_role[] default array['super_admin','support']::public.platform_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins
    where user_id = (select auth.uid()) and active and platform_role = any (roles))
$$;

create function public.is_org_member(org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_memberships m
    join public.profiles p on p.user_id = m.user_id and p.active
    where m.organization_id = org and m.user_id = (select auth.uid()) and m.status = 'active')
$$;

create function public.has_permission(org uuid, perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_memberships m
    join public.profiles p on p.user_id = m.user_id and p.active
    where m.organization_id = org and m.user_id = (select auth.uid()) and m.status = 'active'
      and (perm = any (public.role_permissions(m.role)) or perm = any (m.permissions)))
$$;

-- Owners/admins see every site of their org; others only assigned active sites.
create function public.has_site_access(org uuid, site uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.sites s
    join public.organization_memberships m on m.organization_id = s.organization_id
      and m.user_id = (select auth.uid()) and m.status = 'active'
    join public.profiles p on p.user_id = m.user_id and p.active
    where s.id = site and s.organization_id = org and s.active
      and (m.role in ('owner','admin')
           or exists (select 1 from public.site_memberships sm
                      where sm.site_id = s.id and sm.user_id = m.user_id and sm.active)))
$$;

-- Mutations are blocked for suspended/archived tenants (reads stay available).
create function public.org_is_writable(org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.organizations where id = org and status in ('trial','active','grace'))
$$;

revoke all on function public.is_platform_admin(public.platform_role[]), public.is_org_member(uuid),
  public.has_permission(uuid, text), public.has_site_access(uuid, uuid), public.org_is_writable(uuid)
  from public, anon;
grant execute on function public.is_platform_admin(public.platform_role[]), public.is_org_member(uuid),
  public.has_permission(uuid, text), public.has_site_access(uuid, uuid), public.org_is_writable(uuid)
  to authenticated;

-- internal audit writer (server/RPC use only)
create function public.write_audit(p_org uuid, p_site uuid, p_actor uuid, p_action text,
  p_entity_type text, p_entity_id text, p_reason text default null, p_meta jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_role text;
begin
  select m.role::text into v_role from public.organization_memberships m
   where m.organization_id = p_org and m.user_id = p_actor;
  if v_role is null and exists (select 1 from public.platform_admins where user_id = p_actor) then
    v_role := 'platform';
  end if;
  insert into public.audit_logs (organization_id, site_id, actor_id, actor_role, action, entity_type, entity_id, reason, meta)
  values (p_org, p_site, p_actor, v_role, p_action, p_entity_type, p_entity_id, p_reason, coalesce(p_meta, '{}'));
end $$;
revoke all on function public.write_audit(uuid, uuid, uuid, text, text, text, text, jsonb) from public, anon, authenticated;

-- RLS ---------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.platform_admins enable row level security;
alter table public.organizations enable row level security;
alter table public.sites enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.site_memberships enable row level security;
alter table public.audit_logs enable row level security;

create policy profiles_self on public.profiles for select to authenticated
  using (user_id = (select auth.uid()));
create policy profiles_orgmates on public.profiles for select to authenticated
  using (exists (select 1 from public.organization_memberships m
                 where m.user_id = profiles.user_id and public.has_permission(m.organization_id, 'user.manage')));

create policy platform_admins_self on public.platform_admins for select to authenticated
  using (user_id = (select auth.uid()));

create policy orgs_read on public.organizations for select to authenticated
  using (public.is_org_member(id) or public.is_platform_admin());

create policy sites_read on public.sites for select to authenticated
  using (public.has_site_access(organization_id, id)
         or public.has_permission(organization_id, 'site.manage')
         or public.is_platform_admin());

create policy memberships_read on public.organization_memberships for select to authenticated
  using (user_id = (select auth.uid())
         or public.has_permission(organization_id, 'user.manage')
         or public.is_platform_admin());

create policy site_memberships_read on public.site_memberships for select to authenticated
  using (user_id = (select auth.uid())
         or public.has_permission(organization_id, 'user.manage'));

create policy audit_read on public.audit_logs for select to authenticated
  using ((organization_id is not null and public.has_permission(organization_id, 'audit.view'))
         or public.is_platform_admin(array['super_admin']::public.platform_role[]));

-- No insert/update/delete policies: all writes go through server-only RPCs/service role.
revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;
revoke all on all tables in schema public from anon;

-- Current-user context for the web app (permissions + sites), one round trip.
create function public.me() returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'user_id', p.user_id, 'login_id', p.login_id, 'full_name', p.full_name,
    'must_change_password', p.must_change_password,
    'is_platform_admin', public.is_platform_admin(),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'organization_id', o.id, 'display_name', o.display_name, 'status', o.status, 'role', m.role,
        'permissions', (select coalesce(jsonb_agg(distinct x), '[]') from unnest(public.role_permissions(m.role) || m.permissions) x),
        'site_ids', (select coalesce(jsonb_agg(s.id), '[]') from public.sites s
                      where s.organization_id = o.id and public.has_site_access(o.id, s.id))))
      from public.organization_memberships m join public.organizations o on o.id = m.organization_id
      where m.user_id = p.user_id and m.status = 'active'), '[]'))
  from public.profiles p where p.user_id = (select auth.uid()) and p.active
$$;
revoke all on function public.me() from public, anon;
grant execute on function public.me() to authenticated;

-- First-login password change flag (the password itself is handled only by Supabase Auth).
create function public.complete_password_change() returns void
language sql security definer set search_path = '' as $$
  update public.profiles set must_change_password = false where user_id = (select auth.uid());
$$;
revoke all on function public.complete_password_change() from public, anon;
grant execute on function public.complete_password_change() to authenticated;
