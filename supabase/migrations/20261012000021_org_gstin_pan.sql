-- A client firm's GSTIN and PAN (both optional; the firm can be created without them).
alter table public.organizations add column gstin text, add column pan text;
alter table public.organizations
  add constraint org_gstin_format check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  add constraint org_pan_format check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$');
create unique index organizations_gstin_key on public.organizations (gstin) where gstin is not null;

drop function public.platform_update_org(uuid, text, text, text, text, text, date, date);
create function public.platform_update_org(p_org uuid, p_legal text, p_display text, p_mobile text, p_email text, p_referral text, p_activation date, p_until date,
  p_gstin text default null, p_pan text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.organizations;
begin
  if not public.is_platform_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.organizations set
    legal_name = coalesce(nullif(btrim(p_legal), ''), legal_name), display_name = coalesce(nullif(btrim(p_display), ''), display_name),
    contact_mobile = nullif(btrim(p_mobile), ''), contact_email = nullif(lower(btrim(p_email)), ''), referral = nullif(btrim(p_referral), ''),
    gstin = nullif(upper(btrim(p_gstin)), ''), pan = nullif(upper(btrim(p_pan)), ''),
    activation_date = coalesce(p_activation, activation_date), service_until = coalesce(p_until, service_until)
  where id = p_org returning * into r;
  if not found then raise exception 'organization_not_found' using errcode = 'P0002'; end if;
  perform public.write_audit(p_org, null, (select auth.uid()), 'org.update', 'organization', p_org::text, null,
    jsonb_build_object('service_until', r.service_until, 'referral', r.referral));
  return to_jsonb(r);
exception when unique_violation then raise exception 'gstin_exists' using errcode = '23505';
end $$;
revoke all on function public.platform_update_org(uuid, text, text, text, text, text, date, date, text, text) from public, anon;
grant execute on function public.platform_update_org(uuid, text, text, text, text, text, date, date, text, text) to authenticated;
