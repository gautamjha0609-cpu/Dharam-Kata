import { serviceClient } from "@/lib/supabase-server";
import { currentUser, fail, ok } from "@/lib/api";

/** Platform admin only: members of a firm (login IDs and roles; no business data). */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return fail(401, "unauthenticated", "Please sign in.");
  const { data: isAdmin } = await user.sb.rpc("is_platform_admin", { roles: ["super_admin"] });
  if (!isAdmin) return fail(403, "forbidden", "Platform administrators only.");
  const org = new URL(req.url).searchParams.get("organization_id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(org)) return fail(400, "invalid_request", "Invalid organisation.");
  const { data, error } = await serviceClient().rpc("admin_list_members", { p_actor: user.id, p_org: org });
  if (error) return fail(403, "forbidden", "Not allowed.");
  return ok(data ?? []);
}
