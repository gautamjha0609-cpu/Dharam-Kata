-- print_agents is readable column by column (credential_hash and machine_id are never selectable by clients).
-- Migration 024 added "approval", which the Settings page reads ("Waiting for approval" badge): without this grant the owner's
-- list of printer PCs came back empty ("permission denied for table print_agents").
grant select (approval) on public.print_agents to authenticated;
