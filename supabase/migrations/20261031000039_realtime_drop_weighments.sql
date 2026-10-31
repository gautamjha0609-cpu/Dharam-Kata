-- Less database CPU, same behaviour: Realtime's change feed was the largest database cost (about 60% of all database time).
-- Every entry change writes the weighment AND its invoice in one transaction (open, close, replace, delete), and the only screen
-- listening to weighments (the dashboard) also listens to invoices and refreshes the same way, so each change was decoded and
-- permission-checked twice. Weighments leave the live feed; invoices, print jobs and weight reads stay.
do $$
begin
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'weighments') then
    alter publication supabase_realtime drop table public.weighments;
  end if;
end $$;
