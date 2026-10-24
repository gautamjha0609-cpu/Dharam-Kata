-- Once a firm runs a newer Print Agent, an OLDER version can never be paired for that firm again (owner decision, 2026-10-24).
-- Each firm has its own minimum (organizations.min_agent_version): it rises to the newest version that pairs or runs (approved PC)
-- and never goes down by itself. Other firms are not affected. The approval rules (a new desktop needs approval) are unchanged:
-- the version check comes first, then the usual pairing / takeover logic.
-- The agent's version comes from its request (every agent version sends "DharamKataPrintAgent/<version>" in its user agent).

alter table public.organizations add column if not exists min_agent_version text;

-- "0.1.10" -> {0,1,10} so versions compare as numbers, not as text; null when there is no version number
create function public.version_num(v text) returns int[]
language sql immutable set search_path = '' as $$
  select case when v ~ '\d+(\.\d+)*' then string_to_array(substring(v from '\d+(?:\.\d+)*'), '.')::int[] end
$$;

create function public.raise_agent_version_floor(p_org uuid, p_version text) returns void
language sql security definer set search_path = '' as $$
  update public.organizations set min_agent_version = substring(p_version from '\d+(?:\.\d+)*')
   where id = p_org and public.version_num(p_version) is not null
     and (min_agent_version is null or public.version_num(p_version) > public.version_num(min_agent_version));
$$;
revoke all on function public.raise_agent_version_floor(uuid, text) from public, anon, authenticated;

-- heartbeat: an approved, active PC running version V raises its firm's minimum to V
create function public.agent_version_seen(p_agent uuid, p_version text) returns void
language sql security definer set search_path = '' as $$
  select public.raise_agent_version_floor(a.organization_id, p_version) from public.print_agents a
   where a.id = p_agent and a.status = 'active' and coalesce(a.approval, 'approved') = 'approved';
$$;
revoke all on function public.agent_version_seen(uuid, text) from public, anon, authenticated;
grant execute on function public.agent_version_seen(uuid, text) to service_role;

-- start: each firm's minimum = the newest version among its approved, active PCs today
update public.organizations o set min_agent_version = v.ver
  from (select a.organization_id, (array_agg(a.app_version order by public.version_num(a.app_version) desc))[1] as ver
          from public.print_agents a
         where a.status = 'active' and coalesce(a.approval, 'approved') = 'approved' and public.version_num(a.app_version) is not null
         group by a.organization_id) v
 where v.organization_id = o.id;

-- pairing: refuse a version older than the firm's minimum (the code is not used up, so the newer version can pair with it);
-- a successful pairing raises the minimum
do $$
declare d text; sig text := 'public.agent_pair(text,text,text,text,text)';
begin
  select pg_get_functiondef(sig::regprocedure) into d;
  d := replace(d, 'p_printer text DEFAULT NULL::text, OUT o_agent uuid', 'p_printer text DEFAULT NULL::text, p_version text DEFAULT NULL::text, OUT o_agent uuid');
  d := replace(d, 'declare pc public.pairing_codes;', 'declare floor_v text; pc public.pairing_codes;');
  d := replace(d, E'  o_org := pc.organization_id; o_site := pc.site_id;\n',
    E'  o_org := pc.organization_id; o_site := pc.site_id;\n'
    || E'  select min_agent_version into floor_v from public.organizations where id = pc.organization_id;\n'
    || E'  if floor_v is not null and (public.version_num(p_version) is null or public.version_num(p_version) < public.version_num(floor_v)) then\n'
    || E'    raise exception ''agent_version_too_old:%'', floor_v using errcode = ''22023'';\n'
    || E'  end if;\n');
  d := replace(d, E'  perform public.write_audit(pc.organization_id, pc.site_id, pc.created_by, ''agent.paired''',
    E'  perform public.raise_agent_version_floor(pc.organization_id, p_version);\n  perform public.write_audit(pc.organization_id, pc.site_id, pc.created_by, ''agent.paired''');
  d := replace(d, E'jsonb_build_object(''approval'', o_approval, ''repaired''', E'jsonb_build_object(''version'', p_version, ''approval'', o_approval, ''repaired''');
  if position('agent_version_too_old' in d) = 0 or position('raise_agent_version_floor' in d) = 0 or position('p_version text DEFAULT' in d) = 0
     or position('declare floor_v text;' in d) = 0 or position('''version'', p_version' in d) = 0 then
    raise exception 'agent_pair patch did not apply';
  end if;
  execute 'drop function ' || sig;
  execute d;
  execute 'revoke all on function public.agent_pair(text,text,text,text,text,text) from public, anon, authenticated';
  execute 'grant execute on function public.agent_pair(text,text,text,text,text,text) to service_role';

  -- the pairing code answer tells the website which version is needed, so Settings can say it next to the code
  select pg_get_functiondef('public.create_pairing_code(uuid,uuid)'::regprocedure) into d;
  d := replace(d, E'return jsonb_build_object(''code'', code, ''expires_at'', exp);',
    E'return jsonb_build_object(''code'', code, ''expires_at'', exp, ''min_version'', (select min_agent_version from public.organizations where id = p_org));');
  if position('min_version' in d) = 0 then raise exception 'create_pairing_code patch did not apply'; end if;
  execute d;
end $$;
