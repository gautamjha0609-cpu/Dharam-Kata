// One-time: create the first Platform Super Admin.
// Usage (PowerShell):
//   $env:NEXT_PUBLIC_SUPABASE_URL="https://<ref>.supabase.co"; $env:SUPABASE_SERVICE_ROLE_KEY="<secret>"
//   $env:ADMIN_LOGIN="valuation"; $env:ADMIN_PASSWORD="<strong password>"; node scripts/bootstrap-platform-admin.mjs
// The password is read from the environment and never stored or printed.
import { createClient } from "@supabase/supabase-js";

const { NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key, ADMIN_LOGIN: login, ADMIN_PASSWORD: password } = process.env;
if (!url || !key || !login || !password) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_LOGIN and ADMIN_PASSWORD.");
  process.exit(1);
}
if (password.length < 12) { console.error("Use a strong password (12+ characters)."); process.exit(1); }

const sb = createClient(url, key, { auth: { persistSession: false } });
const email = `${login.toLowerCase()}@users.dharamkata.app`;
const { data, error } = await sb.auth.admin.createUser({ email, password, email_confirm: true });
if (error || !data.user) { console.error("Could not create the auth user:", error?.message); process.exit(1); }
const r = await sb.rpc("bootstrap_platform_admin", { p_user: data.user.id, p_login: login, p_name: "Platform Admin" });
if (r.error) { await sb.auth.admin.deleteUser(data.user.id); console.error("Could not register the admin:", r.error.message); process.exit(1); }
console.log(`Platform admin "${login}" created.`);
