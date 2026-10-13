// DEV ONLY: creates a throwaway test firm with owner + operator logins using random passwords.
// Credentials are written to apps/web/.test-creds.json (git-ignored). Never run against real client data.
// Usage: node --env-file=.env.local scripts/dev-seed.mjs
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const pw = () => randomBytes(9).toString("base64url") + "a1";
const email = (l) => `${l}@users.dharamkata.app`;
const tag = randomBytes(2).toString("hex");
const creds = { org: null, site: null, users: {} };

async function user(login, name, role, orgId, siteId) {
  const password = pw();
  const { data, error } = await sb.auth.admin.createUser({ email: email(login), password, email_confirm: true });
  if (error) throw error;
  const id = data.user.id;
  await sb.from("profiles").insert({ user_id: id, login_id: login, full_name: name, must_change_password: false }).throwOnError();
  await sb.from("organization_memberships").insert({ organization_id: orgId, user_id: id, role }).throwOnError();
  if (siteId) await sb.from("site_memberships").insert({ organization_id: orgId, site_id: siteId, user_id: id }).throwOnError();
  creds.users[role] = { login, password, id };
}

const { data: org } = await sb.from("organizations").insert({ legal_name: "TEST Vinayak Dharam Kanta", display_name: "TEST Vinayak", slug: `test-vinayak-${tag}`, status: "active" }).select().single().throwOnError();
const orgId = org.id;
const { data: site } = await sb.from("sites").insert({ organization_id: orgId, name: "Main", code: "MAIN" }).select().single().throwOnError();
await sb.from("pricing_settings").insert({ organization_id: orgId, weight_unit: "tonne" }).throwOnError();
await sb.from("invoice_series").insert({ organization_id: orgId, site_id: null, prefix: "VNK/{FY}/", start_number: 125, next_number: 125, padding_width: 6, reset_policy: "fiscal_year" }).throwOnError();
await user(`tstowner${tag}`, "Test Owner", "owner", orgId, site.id);
await user(`tstop${tag}`, "Test Operator", "operator", orgId, site.id);
creds.org = orgId; creds.site = site.id;
writeFileSync(new URL("../.test-creds.json", import.meta.url), JSON.stringify(creds, null, 2));
console.log("Seeded test firm", org.slug, "- logins saved to apps/web/.test-creds.json");
