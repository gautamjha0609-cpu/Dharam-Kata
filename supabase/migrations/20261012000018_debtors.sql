-- Debtors (the "parties" table): firm-scoped, unique, fast to search, and only valid Indian formats can be stored.
-- Every query is scoped by organization_id and protected by RLS, so one firm never sees another firm's debtors.

-- 1. operators (and every role that can add debtors) get 'party.create'; editing / deactivating stays with 'party.manage'
do $$
declare d text;
begin
  select pg_get_functiondef('public.role_permissions(public.org_role)'::regprocedure) into d;
  d := replace(d, '''party.manage''', '''party.manage'',''party.create''');
  d := replace(d, '''invoice.read'',''party.read'',''print.view''', '''invoice.read'',''party.read'',''party.create'',''print.view''');
  if position('party.create' in d) = 0 then raise exception 'role_permissions patch did not apply'; end if;
  execute d;

  -- 2. upsert_party: creating needs party.create (or manage), editing needs manage; a duplicate GSTIN is reported as such
  select pg_get_functiondef('public.upsert_party(uuid, uuid, text, public.party_type, text, text, text, text, text, text, text, text, text)'::regprocedure) into d;
  d := replace(d, E'  perform public.assert_can(p_org, ''party.manage'');',
    E'  if p_id is null and public.has_permission(p_org, ''party.create'') then null; else perform public.assert_can(p_org, ''party.manage''); end if;');
  d := replace(d, 'exception when unique_violation then raise exception ''party_name_exists'' using errcode = ''23505'';',
    'exception when unique_violation then if sqlerrm like ''%gstin%'' then raise exception ''party_gstin_exists'' using errcode = ''23505''; end if; raise exception ''party_name_exists'' using errcode = ''23505'';');
  if position('party.create' in d) = 0 or position('party_gstin_exists' in d) = 0 then raise exception 'upsert_party patch did not apply'; end if;
  execute d;
end $$;

-- 3. one GSTIN = one active debtor per firm (a second entry is almost always a typing mistake)
create unique index parties_org_gstin on public.parties (organization_id, gstin) where gstin is not null and active;

-- 4. type-ahead: "contains" search on the name without scanning the table
create extension if not exists pg_trgm with schema extensions;
create index parties_name_trgm on public.parties using gin (normalized_name extensions.gin_trgm_ops);
create index parties_org_active_name on public.parties (organization_id, normalized_name) where active;

-- 5. formats (new and edited rows; old rows are left alone): mobile = 10 digits from 6-9, PIN = 6 digits, address a sensible length
alter table public.parties
  add constraint parties_phone_format check (phone is null or phone ~ '^[6-9][0-9]{9}$') not valid,
  add constraint parties_pin_format check (pin is null or pin ~ '^[1-9][0-9]{5}$') not valid,
  add constraint parties_address_len check (address is null or char_length(address) <= 300) not valid;
