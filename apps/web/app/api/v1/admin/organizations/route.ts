import { z } from "zod";
import { loginIdToEmail } from "@/lib/supabase";
import { serviceClient } from "@/lib/supabase-server";
import { currentUser, fail, ok, LOGIN_ID, PASSWORD_POLICY, rateLimit, rpcErrorMessage } from "@/lib/api";

const Body = z.object({
  legal_name: z.string().trim().min(2).max(200),
  display_name: z.string().trim().min(2).max(120),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "Slug: lowercase letters, digits and hyphens"),
  owner_login_id: LOGIN_ID,
  owner_name: z.string().trim().min(1).max(120),
  owner_temp_password: PASSWORD_POLICY,
  site_name: z.string().trim().min(1).max(80),
  site_code: z.string().regex(/^[A-Za-z0-9-]{1,12}$/, "Site code: up to 12 letters/digits"),
});

/** Platform admin only: creates a client firm, its owner login and first site. Tenant creation is never open to tenant users. */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return fail(401, "unauthenticated", "Please sign in.");
  const { data: isAdmin } = await user.sb.rpc("is_platform_admin", { roles: ["super_admin"] });
  if (!isAdmin) return fail(403, "forbidden", "Platform administrators only.");
  if (!rateLimit(`org:${user.id}`, 10, 60_000)) return fail(429, "rate_limited", "Too many requests.");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request");
  const b = parsed.data;

  const svc = serviceClient();
  const created = await svc.auth.admin.createUser({ email: loginIdToEmail(b.owner_login_id), password: b.owner_temp_password, email_confirm: true, user_metadata: { login_id: b.owner_login_id } });
  if (created.error || !created.data.user) return fail(409, "login_exists", "That owner login ID is already in use.");
  const uid = created.data.user.id;
  const { data, error } = await svc.rpc("admin_create_organization", {
    p_actor: user.id, p_legal: b.legal_name, p_display: b.display_name, p_slug: b.slug,
    p_owner: uid, p_owner_login: b.owner_login_id, p_owner_name: b.owner_name, p_site_name: b.site_name, p_site_code: b.site_code,
  });
  if (error) {
    await svc.auth.admin.deleteUser(uid);
    return fail(409, "create_failed", /organizations_slug_key|duplicate/.test(error.message) ? "That slug is already used." : rpcErrorMessage(error));
  }
  return ok({ organization_id: data }, 201);
}
