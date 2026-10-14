-- Annual service term, firm contact details, referral, broadcasts, and fast platform-admin calls.

-- 1. firm details + the service term ---------------------------------------------------------------------------------
alter table public.organizations
  add column contact_mobile text, add column contact_email text, add column referral text,
  add column activation_date date, add column service_until date,
  add column last_extended_at timestamptz, add column extension_count int not null default 0;

-- existing firms: the term starts the day they were created and runs one year
update public.organizations set activation_date = (created_at at time zone 'Asia/Kolkata')::date where activation_date is null;
update public.organizations set service_until = (activation_date + interval '1 year')::date where service_until is null;
alter table public.organizations alter column activation_date set not null, alter column service_until set not null;

alter table public.organizations
  add constraint org_mobile_format check (contact_mobile is null or contact_mobile ~ '^[6-9][0-9]{9}$'),
  add constraint org_email_format check (contact_email is null or (char_length(contact_email) <= 200 and contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  add constraint org_referral_len check (referral is null or char_length(referral) <= 120),
  add constraint org_term_order check (service_until > activation_date);

-- a new firm: activation = today (IST) unless given, valid for exactly one year
create function public.organizations_term_defaults() returns trigger language plpgsql set search_path = '' as $$
begin
  new.activation_date := coalesce(new.activation_date, (now() at time zone 'Asia/Kolkata')::date);
  new.service_until := coalesce(new.service_until, (new.activation_date + interval '1 year')::date);
  return new;
end $$;
create trigger organizations_term before insert on public.organizations for each row execute function public.organizations_term_defaults();

-- 2. the service stops ON the end date, until the platform admin extends it ----------------------------------------------
create function public.org_service_active(org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select (now() at time zone 'Asia/Kolkata')::date < o.service_until from public.organizations o where o.id = org), false)
$$;
create or replace function public.org_is_writable(org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.organizations where id = org and status in ('trial','active','grace')
                 and (service_until is null or (now() at time zone 'Asia/Kolkata')::date < service_until))
$$;

-- the app learns each firm's end date with the rest of "me"
do $$
declare d text;
begin
  select pg_get_functiondef('public.me()'::regprocedure) into d;
  d := replace(d, '''status'', o.status, ''role'', m.role,', '''status'', o.status, ''service_until'', o.service_until, ''role'', m.role,');
  if position('service_until' in d) = 0 then raise exception 'me() patch did not apply'; end if;
  execute d;
end $$;

-- 3. platform-admin operations: ONE database call each, straight from the admin's browser (no extra server hop) ---------
create function public.platform_update_org(p_org uuid, p_legal text, p_display text, p_mobile text, p_email text, p_referral text, p_activation date, p_until date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.organizations;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.organizations set
    legal_name = coalesce(nullif(btrim(p_legal), ''), legal_name), display_name = coalesce(nullif(btrim(p_display), ''), display_name),
    contact_mobile = nullif(btrim(p_mobile), ''), contact_email = nullif(lower(btrim(p_email)), ''), referral = nullif(btrim(p_referral), ''),
    activation_date = coalesce(p_activation, activation_date), service_until = coalesce(p_until, service_until)
  where id = p_org returning * into r;
  if not found then raise exception 'organization_not_found' using errcode = 'P0002'; end if;
  perform public.write_audit(p_org, null, (select auth.uid()), 'org.update', 'organization', p_org::text, null,
    jsonb_build_object('service_until', r.service_until, 'referral', r.referral));
  return to_jsonb(r);
end $$;

-- one click: +1 year counted from the CURRENT end date, so the anniversary never moves
create function public.platform_extend_org(p_org uuid) returns date
language plpgsql security definer set search_path = '' as $$
declare v date;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.organizations set service_until = (service_until + interval '1 year')::date, last_extended_at = now(), extension_count = extension_count + 1
  where id = p_org returning service_until into v;
  if v is null then raise exception 'organization_not_found' using errcode = 'P0002'; end if;
  perform public.write_audit(p_org, null, (select auth.uid()), 'org.extend', 'organization', p_org::text, null, jsonb_build_object('service_until', v));
  return v;
end $$;

create function public.platform_list_members(p_org uuid)
returns table (user_id uuid, login_id text, full_name text, role public.org_role, status public.member_status)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query select m.user_id, p.login_id, p.full_name, m.role, m.status from public.organization_memberships m
    join public.profiles p on p.user_id = m.user_id where m.organization_id = p_org order by m.joined_at;
end $$;

-- 4. broadcasts: one message to every firm, shown to users when they open the app ----------------------------------------
create table public.broadcasts (
  id uuid primary key default gen_random_uuid(),
  message text not null check (char_length(btrim(message)) between 1 and 500),
  created_by uuid, created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days'
);
alter table public.broadcasts enable row level security;
create policy broadcasts_read on public.broadcasts for select to authenticated using (expires_at > now());
grant select on public.broadcasts to authenticated;
revoke insert, update, delete, truncate on public.broadcasts from anon, authenticated;
create function public.platform_send_broadcast(p_message text, p_days int default 30) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  insert into public.broadcasts (message, created_by, expires_at) values (btrim(p_message), (select auth.uid()), now() + make_interval(days => greatest(1, least(coalesce(p_days, 30), 365))))
  returning id into v;
  return v;
end $$;
create function public.platform_end_broadcast(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.broadcasts set expires_at = now() where id = p_id;
end $$;

revoke all on function public.platform_update_org(uuid, text, text, text, text, text, date, date) from public, anon;
revoke all on function public.platform_extend_org(uuid) from public, anon;
revoke all on function public.platform_list_members(uuid) from public, anon;
revoke all on function public.platform_send_broadcast(text, int) from public, anon;
revoke all on function public.platform_end_broadcast(uuid) from public, anon;
grant execute on function public.platform_update_org(uuid, text, text, text, text, text, date, date) to authenticated;
grant execute on function public.platform_extend_org(uuid) to authenticated;
grant execute on function public.platform_list_members(uuid) to authenticated;
grant execute on function public.platform_send_broadcast(text, int) to authenticated;
grant execute on function public.platform_end_broadcast(uuid) to authenticated;
