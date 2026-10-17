import { z } from "zod";
import { serviceClient } from "@/lib/supabase-server";
import { currentUser, fail, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({ organization_id: z.string().uuid(), user_id: z.string().uuid() });

/**
 * Platform admin "Open as this firm": a ONE-TIME sign-in for a user of a firm, without that user's password.
 * Never blocked by the 2-device limit and never takes one of the user's 2 slots. Passwords are never read or shown.
 * The one-time token goes back only to the signed-in super admin, expires quickly, and every use is written to the audit log.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return fail(401, "unauthenticated", "Please sign in.");
  const { data: isAdmin } = await user.sb.rpc("is_platform_admin", { roles: ["super_admin"] });
  if (!isAdmin) return fail(403, "forbidden", "Platform administrators only.");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "invalid_request", "Invalid request.");
  const { organization_id: org, user_id } = parsed.data;
  if (user_id === user.id) return fail(422, "self_action", "That is your own account.");

  const svc = serviceClient();
  const { data: member } = await svc.from("organization_memberships").select("role,status").eq("organization_id", org).eq("user_id", user_id).maybeSingle();
  if (!member) return fail(404, "not_found", "This user is not part of that firm.");
  if ((member as { status: string }).status !== "active") return fail(422, "disabled", "This user is disabled. Enable the user first.");
  const { data: other } = await svc.from("platform_admins").select("user_id").eq("user_id", user_id).maybeSingle();
  if (other) return fail(422, "not_allowed", "Platform administrator accounts cannot be opened this way.");

  const { data: u, error: uErr } = await svc.auth.admin.getUserById(user_id);
  if (uErr || !u.user?.email) return fail(404, "not_found", "User not found.");
  const { data: link, error } = await svc.auth.admin.generateLink({ type: "magiclink", email: u.user.email });
  const token = link?.properties?.hashed_token;
  if (error || !token) return fail(500, "link_failed", "Could not open the firm. Try again.");

  await svc.rpc("write_audit", { p_org: org, p_site: null as unknown as string, p_actor: user.id, p_action: "admin.open_as_user", p_entity_type: "user", p_entity_id: user_id, p_reason: null as unknown as string, p_meta: { role: (member as { role: string }).role } });
  return ok({ url: `/api/v1/auth/admin-open?t=${encodeURIComponent(token)}` });
}
