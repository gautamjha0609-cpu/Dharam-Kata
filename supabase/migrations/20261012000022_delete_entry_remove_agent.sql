-- Operators can delete a wrong entry and remove a paired printer PC.
--  * "Delete" never erases rows: the invoice is marked cancelled (its number is retired, never reused), any payment is reversed,
--    and the weighment is voided, so the vehicle is no longer "open" and the entry drops out of dues, totals and reports.
--    Who / when / why is kept in the audit log.
--  * "Remove printer PC" = revoke the agent: it stops receiving jobs at once and has to be paired again to print.

-- 1. new permissions for owner, admin and operator
do $$
declare d text;
begin
  select pg_get_functiondef('public.role_permissions(public.org_role)'::regprocedure) into d;
  d := replace(d, '''invoice.cancel'',', '''invoice.cancel'',''entry.delete'',''agent.remove'',');
  d := replace(d, '''invoice.finalize'',''invoice.read'',''party.read''', '''invoice.finalize'',''entry.delete'',''agent.remove'',''invoice.read'',''party.read''');
  if (length(d) - length(replace(d, 'entry.delete', ''))) / length('entry.delete') <> 3 then raise exception 'role_permissions patch did not apply'; end if;
  execute d;
end $$;

-- 2. delete a wrong entry (open or closed)
create function public.delete_entry(p_org uuid, p_invoice uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare inv public.invoices; paid numeric; uid uuid := (select auth.uid());
begin
  select * into inv from public.invoices where id = p_invoice and organization_id = p_org for update;
  if not found then raise exception 'invoice_not_found' using errcode = 'P0002'; end if;
  if public.has_permission(p_org, 'invoice.cancel') then perform public.assert_can(p_org, 'invoice.cancel', inv.site_id);
  else perform public.assert_can(p_org, 'entry.delete', inv.site_id); end if;
  if char_length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required' using errcode = '22023'; end if;
  if inv.status <> 'issued' then raise exception 'invoice_not_issued' using errcode = '23514'; end if;
  select coalesce(sum(amount), 0) into paid from public.invoice_payments where invoice_id = inv.id;
  if paid <> 0 then
    insert into public.invoice_payments (organization_id, site_id, invoice_id, party_id, kind, amount, method, reason, recorded_by)
    values (p_org, inv.site_id, inv.id, inv.party_id, 'reversal', -paid, 'reversal', p_reason, uid);
  end if;
  update public.invoices set status = 'cancelled', cancel_reason = p_reason, cancelled_at = now(), cancelled_by = uid where id = inv.id returning * into inv;
  if inv.weighment_id is not null then
    update public.weighments set status = 'voided', version = version + 1, updated_at = now() where id = inv.weighment_id and status <> 'voided';
  end if;
  perform public.write_audit(p_org, inv.site_id, uid, 'entry.delete', 'invoice', inv.id::text, p_reason,
    jsonb_build_object('number', inv.invoice_number, 'vehicle', inv.vehicle_display, 'stage', inv.stage, 'reversed', paid));
  return to_jsonb(inv);
end $$;

-- 3. remove a paired printer PC
create function public.remove_agent(p_org uuid, p_agent uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare ag public.print_agents;
begin
  select * into ag from public.print_agents where id = p_agent and organization_id = p_org for update;
  if not found then raise exception 'agent_not_found' using errcode = 'P0002'; end if;
  if public.has_permission(p_org, 'print.route.manage') then perform public.assert_can(p_org, 'print.route.manage', ag.site_id);
  else perform public.assert_can(p_org, 'agent.remove', ag.site_id); end if;
  if ag.status = 'revoked' then return; end if;
  update public.print_agents set status = 'revoked', revoked_at = now() where id = ag.id;
  update public.print_jobs set status = 'cancelled' where agent_id = ag.id and status = 'queued';
  perform public.write_audit(p_org, ag.site_id, (select auth.uid()), 'agent.remove', 'agent', ag.id::text);
end $$;

revoke all on function public.delete_entry(uuid, uuid, text) from public, anon;
revoke all on function public.remove_agent(uuid, uuid) from public, anon;
grant execute on function public.delete_entry(uuid, uuid, text) to authenticated;
grant execute on function public.remove_agent(uuid, uuid) to authenticated;
