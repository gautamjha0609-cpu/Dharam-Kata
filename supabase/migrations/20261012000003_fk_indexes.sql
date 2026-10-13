-- Covering indexes for composite FKs (advisor: unindexed_foreign_keys).
create index if not exists invoice_payments_inv_fk_idx on public.invoice_payments (invoice_id, organization_id);
create index if not exists invoice_series_site_fk_idx on public.invoice_series (site_id, organization_id);
create index if not exists invoices_party_fk_idx on public.invoices (party_id, organization_id);
create index if not exists invoices_series_fk_idx on public.invoices (series_id, organization_id);
create index if not exists invoices_site_fk_idx on public.invoices (site_id, organization_id);
create index if not exists invoices_weighment_fk_idx on public.invoices (weighment_id, organization_id);
create index if not exists memberships_invited_by_idx on public.organization_memberships (invited_by);
create index if not exists site_memberships_org_user_idx on public.site_memberships (organization_id, user_id);
create index if not exists site_memberships_site_fk_idx on public.site_memberships (site_id, organization_id);
create index if not exists weighments_party_fk_idx on public.weighments (party_id, organization_id);
create index if not exists weighments_site_fk_idx on public.weighments (site_id, organization_id);
