-- Database hardening from the Supabase advisors (performance + security).

-- 1. trigger-only functions must not be callable through the API
revoke execute on function public.copy_extra_to_invoice() from public, anon, authenticated;
revoke execute on function public.invoice_enqueue_trigger() from public, anon, authenticated;

-- 2. indexes for foreign keys that had none (joins and cascades stay fast as data grows)
create index if not exists print_agents_org_idx on public.print_agents (organization_id);
create index if not exists print_destinations_site_idx on public.print_destinations (origin_site_id, organization_id);
create index if not exists print_jobs_agent_fk_idx on public.print_jobs (agent_id, organization_id);
create index if not exists receipt_template_versions_tpl_idx on public.receipt_template_versions (template_id, organization_id);
create index if not exists receipt_templates_org_idx on public.receipt_templates (organization_id);

-- 3. one permissive SELECT policy on profiles instead of two (each policy is evaluated for every row)
drop policy profiles_orgmates on public.profiles;
drop policy profiles_self on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (user_id = (select auth.uid())
         or exists (select 1 from public.organization_memberships m
                    where m.user_id = profiles.user_id and public.has_permission(m.organization_id, 'user.manage')));
