-- Communications: a start and an end time, chosen firms (one, several or all), how many times each user sees it, and a stop button.
alter table public.broadcasts
  add column starts_at timestamptz,
  add column show_count int not null default 2 check (show_count between 1 and 20),
  add column target_all boolean not null default true,
  add column stopped_at timestamptz;
update public.broadcasts set starts_at = created_at where starts_at is null;
alter table public.broadcasts alter column starts_at set not null, alter column starts_at set default now();
alter table public.broadcasts add constraint broadcasts_window check (expires_at > starts_at);

create table public.broadcast_targets (
  broadcast_id uuid not null references public.broadcasts (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  primary key (broadcast_id, organization_id)
);
create index broadcast_targets_org on public.broadcast_targets (organization_id);
alter table public.broadcast_targets enable row level security;
create policy broadcast_targets_read on public.broadcast_targets for select to authenticated
  using (public.is_platform_admin() or public.is_org_member(organization_id));
grant select on public.broadcast_targets to authenticated;
revoke insert, update, delete, truncate on public.broadcast_targets from anon, authenticated;

-- a user sees a message only while it is live (started, not ended, not stopped) AND addressed to all firms or to one of their firms; the platform admin sees everything (history)
drop policy broadcasts_read on public.broadcasts;
create policy broadcasts_read on public.broadcasts for select to authenticated using (
  public.is_platform_admin()
  or (stopped_at is null and starts_at <= now() and expires_at > now()
      and (target_all or exists (select 1 from public.broadcast_targets t where t.broadcast_id = broadcasts.id and public.is_org_member(t.organization_id)))));

drop function public.platform_send_broadcast(text, int);
drop function public.platform_end_broadcast(uuid);

create function public.platform_send_broadcast(p_message text, p_starts timestamptz, p_ends timestamptz, p_show_count int, p_org_ids uuid[])
returns uuid language plpgsql security definer set search_path = '' as $$
declare v uuid; n int := 0; all_firms boolean := (p_org_ids is null or cardinality(p_org_ids) = 0);
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_ends is null or p_starts is null or p_ends <= p_starts then raise exception 'invalid_period' using errcode = '22023'; end if;
  if p_show_count is null or p_show_count < 1 or p_show_count > 20 then raise exception 'invalid_show_count' using errcode = '22023'; end if;
  insert into public.broadcasts (message, created_by, starts_at, expires_at, show_count, target_all)
  values (btrim(p_message), (select auth.uid()), p_starts, p_ends, p_show_count, all_firms) returning id into v;
  if not all_firms then
    insert into public.broadcast_targets (broadcast_id, organization_id) select v, o.id from public.organizations o where o.id = any(p_org_ids);
    get diagnostics n = row_count;
    if n = 0 then raise exception 'no_target' using errcode = '22023'; end if;
  end if;
  return v;
end $$;

create function public.platform_stop_broadcast(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.broadcasts set stopped_at = now() where id = p_id and stopped_at is null;
end $$;

revoke all on function public.platform_send_broadcast(text, timestamptz, timestamptz, int, uuid[]) from public, anon;
revoke all on function public.platform_stop_broadcast(uuid) from public, anon;
grant execute on function public.platform_send_broadcast(text, timestamptz, timestamptz, int, uuid[]) to authenticated;
grant execute on function public.platform_stop_broadcast(uuid) to authenticated;
