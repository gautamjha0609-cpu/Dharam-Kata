import { z } from "zod";
import { serviceClient } from "@/lib/supabase-server";
import { authenticateAgent, fail, ok } from "@/lib/api";

const Body = z.object({
  lease_token: z.string().uuid(),
  status: z.enum(["rendering", "submitting", "submitted_to_spooler", "failed"]),
  error_code: z.string().max(80).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const agent = await authenticateAgent(req);
  if (!agent) return fail(401, "unauthenticated", "Invalid or revoked device credential.");
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return fail(400, "invalid_request", "Invalid job id");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "invalid_request", "Invalid event");
  const { error } = await serviceClient().rpc("agent_record_event", {
    p_agent: agent, p_job: id, p_lease: parsed.data.lease_token, p_status: parsed.data.status, p_error: parsed.data.error_code ?? (null as unknown as string),
  });
  if (error) return fail(/lease_invalid/.test(error.message) ? 403 : 409, "event_rejected", "The job lease is not valid for this agent.");
  return ok({ accepted: true });
}
