import { z } from "zod";
import { loginIdToEmail } from "@/lib/supabase";
import { serviceClient } from "@/lib/supabase-server";
import { currentUser, fail, LOGIN_ID, ok, PASSWORD_POLICY, rateLimit, rpcErrorMessage } from "@/lib/api";

const Body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("disable"), organization_id: z.string().uuid(), user_id: z.string().uuid() }),
  z.object({ kind: z.literal("enable"), organization_id: z.string().uuid(), user_id: z.string().uuid() }),
  z.object({ kind: z.literal("set_password"), organization_id: z.string().uuid(), user_id: z.string().uuid(), password: z.string() }),
  z.object({ kind: z.literal("set_login"), organization_id: z.string().uuid(), user_id: z.string().uuid(), login_id: LOGIN_ID }),
]);

/**
 * Admin-only credential management. Users have NO way to change their own login ID or password in the app.
 * Allowed caller: the platform super admin only (firm owners/admins/operators cannot manage users).
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return fail(401, "unauthenticated", "Please sign in.");
  if (!rateLimit(`uact:${user.id}`, 30, 60_000)) return fail(429, "rate_limited", "Too many requests.");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request");
  const b = parsed.data;

  const { data: isPlatform } = await user.sb.rpc("is_platform_admin", { roles: ["super_admin"] });
  if (!isPlatform) return fail(403, "forbidden", "Only the platform administrator can manage users.");
  if (b.user_id === user.id && b.kind !== "set_password") return fail(422, "self_action", "You cannot do this to your own account.");

  const svc = serviceClient();
  // Target must belong to this organisation, and a tenant admin may not touch the owner account (only the platform admin may).
  const { data: target } = await svc.from("organization_memberships").select("role").eq("organization_id", b.organization_id).eq("user_id", b.user_id).maybeSingle();
  if (!target) return fail(404, "not_found", "That user is not in this organisation.");
  if ((target as { role: string }).role === "owner" && !isPlatform) return fail(403, "forbidden", "Only the platform administrator can change the owner's credentials.");

  if (b.kind === "set_password") {
    const pw = PASSWORD_POLICY.safeParse(b.password);
    if (!pw.success) return fail(400, "weak_password", pw.error.issues[0]?.message ?? "Weak password");
    const flag = await svc.rpc("admin_flag_password_reset", { p_actor: user.id, p_org: b.organization_id, p_user: b.user_id });
    if (flag.error) return fail(403, "forbidden", rpcErrorMessage(flag.error));
    const upd = await svc.auth.admin.updateUserById(b.user_id, { password: pw.data });
    if (upd.error) return fail(500, "set_failed", "Could not set the password.");
    return ok({ password_set: true });
  }
  if (b.kind === "set_login") {
    const { error } = await svc.rpc("admin_set_login_id", { p_actor: user.id, p_org: b.organization_id, p_user: b.user_id, p_login: b.login_id });
    if (error) return fail(/login_exists|duplicate/.test(error.message) ? 409 : 403, "login_failed", /login_exists|duplicate/.test(error.message) ? "That login ID is already in use." : rpcErrorMessage(error));
    const upd = await svc.auth.admin.updateUserById(b.user_id, { email: loginIdToEmail(b.login_id), email_confirm: true });
    if (upd.error) return fail(500, "set_failed", "Login ID was recorded but the sign-in identity could not be updated. Try again.");
    return ok({ login_id: b.login_id });
  }
  const { error } = await svc.rpc("admin_set_member_status", { p_actor: user.id, p_org: b.organization_id, p_user: b.user_id, p_status: b.kind === "disable" ? "disabled" : "active" });
  if (error) return fail(403, "forbidden", rpcErrorMessage(error));
  return ok({ status: b.kind });
}
