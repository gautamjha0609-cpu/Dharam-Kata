// DEV ONLY: creates a throwaway platform admin with a random password -> apps/web/.test-creds.json (git-ignored).
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const login = "tstadmin" + randomBytes(2).toString("hex");
const password = randomBytes(12).toString("base64url") + "a1";
const { data, error } = await sb.auth.admin.createUser({ email: `${login}@users.dharamkata.app`, password, email_confirm: true });
if (error) throw error;
await sb.rpc("bootstrap_platform_admin", { p_user: data.user.id, p_login: login, p_name: "Test Platform Admin" }).throwOnError();
await sb.from("profiles").update({ must_change_password: false }).eq("user_id", data.user.id);
writeFileSync(new URL("../.test-creds.json", import.meta.url), JSON.stringify({ admin: { login, password, id: data.user.id } }, null, 2));
console.log("platform admin created:", login);
