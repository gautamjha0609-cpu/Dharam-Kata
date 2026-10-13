-- Realtime is a refresh hint only (RLS still applies); the durable tables remain the source of truth.
alter publication supabase_realtime add table public.weighments, public.print_jobs, public.invoices;
