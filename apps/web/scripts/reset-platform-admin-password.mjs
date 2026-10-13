// Reset the password of an existing platform admin (the only way, since admins' own passwords are admin-only).
// Usage (PowerShell, from apps/web):
//   $env:ADMIN_LOGIN='valuation'; $env:ADMIN_PASSWORD='<new strong password, 12+ chars>'
//   node --env-file=.env.local scripts/reset-platform-admin-password.mjs
import { createClient } from "@supabase/supabase-js";

const { NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key, ADMIN_LOGIN: login, ADMIN_PASSWORD: password } = process.env;
if (!url || !key || !login || !password) { console.error("Set ADMIN_LOGIN and ADMIN_PASSWORD (and run with --env-file=.env.local)."); process.exit(1); }
if (password.length < 12) { console.error("Use a strong password (12+ characters)."); process.exit(1); }

const sb = createClient(url, key, { auth: { persistSession: false } });
const { data: prof } = await sb.from("profiles").select("user_id").eq("login_id", login.toLowerCase()).maybeSingle();
if (!prof) { console.error("No such login ID."); process.exit(1); }
const { data: pa } = await sb.from("platform_admins").select("user_id").eq("user_id", prof.user_id).eq("active", true).maybeSingle();
if (!pa) { console.error("That user is not a platform admin."); process.exit(1); }

// the database rejects password changes without a short-lived admin grant
await sb.from("credential_change_grants").upsert({ user_id: prof.user_id, kind: "password", expires_at: new Date(Date.now() + 30_000).toISOString() }).throwOnError();
const r = await sb.auth.admin.updateUserById(prof.user_id, { password });
if (r.error) { console.error("Could not set the password:", r.error.message); process.exit(1); }
console.log(`Password updated for "${login}".`);
