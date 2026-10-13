-- Everything a screen needs to draw the receipt, in ONE round trip (it was 4-5 requests in 3 serial steps). SECURITY INVOKER: the caller's own RLS applies.
create function public.receipt_context(p_org uuid, p_site uuid default null) returns jsonb
language sql stable security invoker set search_path = '' as $$
  with dest as (
    select pd.printer_id from public.print_destinations pd
    where pd.organization_id = p_org and pd.origin_site_id = p_site and pd.is_default and pd.active limit 1
  ), pick as (
    select v.layout from public.receipt_templates t
    join public.receipt_template_versions v on v.id = t.published_version_id
    where t.organization_id = p_org and t.published_version_id is not null
      and ((t.scope = 'printer' and t.printer_id = (select printer_id from dest)) or (t.scope = 'site' and t.site_id = p_site) or t.scope = 'tenant')
    order by case t.scope when 'printer' then 1 when 'site' then 2 else 3 end limit 1
  )
  select jsonb_build_object(
    'layout', (select layout from pick),
    'image_version', (select a.version from public.tenant_assets a where a.organization_id = p_org and a.kind = 'ticket_preview' limit 1),
    'printer_floor', (select d.legibility_floor_pt from public.printer_devices d where d.id = (select printer_id from dest))
  )
$$;
revoke all on function public.receipt_context(uuid, uuid) from public, anon;
grant execute on function public.receipt_context(uuid, uuid) to authenticated;
