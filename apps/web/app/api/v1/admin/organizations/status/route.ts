import { z } from "zod";
import { serviceClient } from "@/lib/supabase-server";
import { currentUser, fail, ok, rpcErrorMessage } from "@/lib/api";

const Body = z.object({
  organization_id: z.string().uuid(),
  status: z.enum(["trial", "active", "grace", "suspended", "archived"]),
  reason: z.string().trim().max(300).optional(),
});

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return fail(401, "unauthenticated", "Please sign in.");
  const { data: isAdmin } = await user.sb.rpc("is_platform_admin", { roles: ["super_admin"] });
  if (!isAdmin) return fail(403, "forbidden", "Platform administrators only.");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "invalid_request", "Invalid request");
  const b = parsed.data;
  if (b.status === "suspended" && !b.reason) return fail(400, "reason_required", "A reason is required to suspend.");
  const { error } = await serviceClient().rpc("admin_set_org_status", { p_actor: user.id, p_org: b.organization_id, p_status: b.status, p_reason: b.reason ?? null as unknown as string });
  if (error) return fail(403, "forbidden", rpcErrorMessage(error));
  return ok({ status: b.status });
}
