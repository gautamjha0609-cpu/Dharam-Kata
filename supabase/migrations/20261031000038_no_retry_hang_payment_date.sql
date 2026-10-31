-- Bug fixes found by break-testing (2026-10-31). No behaviour change other than these two fixes.
--
-- 1. "Someone else updated this record" (version_conflict) was raised with SQLSTATE 40001 (serialization_failure). The Supabase API
--    (PostgREST) retries a request automatically on 40001, so the same stale request ran again and again until the 2-minute gateway
--    timeout: closing an entry from an old tab / a second operator hung for ~2 minutes instead of answering at once.
--    Now the same error with code 23514 (like weighment_not_pending); the website matches the message text, which is unchanged.
-- 2. A payment could be dated in the future (it then counted in a future day's collections). Same rule as weighment times:
--    at most 5 minutes ahead of the server clock.

do $$
declare f record; d text; n int := 0;
begin
  for f in
    select p.oid, p.oid::regprocedure as sig from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
      and pg_get_functiondef(p.oid) like '%''version_conflict'' using errcode = ''40001''%'
  loop
    d := replace(pg_get_functiondef(f.oid), '''version_conflict'' using errcode = ''40001''', '''version_conflict'' using errcode = ''23514''');
    execute d;  -- CREATE OR REPLACE with the same signature: grants are kept
    n := n + 1;
    raise notice 'patched %', f.sig;
  end loop;
  if n = 0 then raise exception 'no function with version_conflict 40001 found'; end if;
end $$;

do $$
declare d text; sig text := 'public.post_collection(uuid,uuid,numeric,text,text,timestamp with time zone,text)';
begin
  select pg_get_functiondef(sig::regprocedure) into d;
  if d like '%payment_in_future%' then return; end if;  -- already applied
  d := replace(d,
    E'  if p_amount is null or p_amount <= 0 then raise exception ''invalid_amount'' using errcode = ''22023''; end if;\n',
    E'  if p_amount is null or p_amount <= 0 then raise exception ''invalid_amount'' using errcode = ''22023''; end if;\n'
    || E'  if p_occurred_at > now() + interval ''5 minutes'' then raise exception ''payment_in_future'' using errcode = ''22023''; end if;\n');
  if d not like '%payment_in_future%' then raise exception 'post_collection patch did not apply'; end if;
  execute d;
end $$;
