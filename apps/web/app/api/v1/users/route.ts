import { z } from "zod";
import { loginIdToEmail } from "@/lib/supabase";
import { serviceClient } from "@/lib/supabase-server";
import { currentUser, fail, ok, LOGIN_ID, PASSWORD_POLICY, rateLimit, rpcErrorMessage } from "@/lib/api";

const Body = z.object({
  organization_id: z.string().uuid(),
  login_id: LOGIN_ID,
  full_name: z.string().trim().min(1).max(120),
  role: z.enum(["admin", "operator", "accounts", "remote_site"]),
  temp_password: PASSWORD_POLICY,
  site_ids: z.array(z.string().uuid()).max(50).default([]),
});

/** Admin-provisioned login (SRS A5): the browser never holds a service-role key; the caller's permission is re-checked here. */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return fail(401, "unauthenticated", "Please sign in.");
  if (!rateLimit(`users:${user.id}`, 20, 60_000)) return fail(429, "rate_limited", "Too many requests. Try again shortly.");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request");
  const b = parsed.data;

  // Only the central administrator creates users; a firm's owner/admin/operator cannot, whatever the browser sends.
  const { data: isPlatform } = await user.sb.rpc("is_platform_admin", { roles: ["super_admin"] });
  if (!isPlatform) return fail(403, "forbidden", "Only the platform administrator can add users.");

  const svc = serviceClient();
  // every assigned site must belong to this organisation (never trust ids from the browser)
  if (b.site_ids.length) {
    const { data: sites } = await svc.from("sites").select("id").eq("organization_id", b.organization_id).in("id", b.site_ids);
    if ((sites?.length ?? 0) !== new Set(b.site_ids).size) return fail(422, "invalid_site", "One or more sites do not belong to this organisation.");
  }
  const created = await svc.auth.admin.createUser({ email: loginIdToEmail(b.login_id), password: b.temp_password, email_confirm: true, user_metadata: { login_id: b.login_id } });
  if (created.error || !created.data.user) return fail(409, "login_exists", "That login ID is already in use.");
  const uid = created.data.user.id;
  const { error } = await svc.rpc("admin_create_member", {
    p_actor: user.id, p_org: b.organization_id, p_user: uid, p_login: b.login_id, p_name: b.full_name, p_role: b.role, p_site_ids: b.site_ids,
  });
  if (error) {
    await svc.auth.admin.deleteUser(uid); // roll back the auth identity
    return fail(error.message.includes("forbidden") ? 403 : 409, "create_failed", rpcErrorMessage(error));
  }
  return ok({ user_id: uid }, 201);
}
