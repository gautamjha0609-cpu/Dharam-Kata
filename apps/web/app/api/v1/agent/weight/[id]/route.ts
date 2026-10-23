import { z } from "zod";
import { serviceClient } from "@/lib/supabase-server";
import { authenticateAgent, fail, ok } from "@/lib/api";

const Body = z.object({
  ok: z.boolean(),
  weight_kg: z.number().positive().lt(1_000_000).nullable(),
  raw: z.string().max(200).nullable(),
  frames: z.number().int().min(0).max(1000).nullable(),
  error_code: z.string().regex(/^[a-z_]{2,40}$/).nullable(),
});

/** The printer PC's answer to a "Detect weight" request: the steady weight in kg, or why there is none. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const agent = await authenticateAgent(req);
  if (!agent) return fail(401, "unauthenticated", "Invalid or revoked device credential.");
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return fail(400, "invalid_request", "Invalid request id");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success || (parsed.data.ok && parsed.data.weight_kg === null)) return fail(400, "invalid_request", "Invalid weight answer");
  const d = parsed.data;
  const { error } = await serviceClient().rpc("agent_finish_weight_read", {
    p_agent: agent, p_id: id, p_ok: d.ok, p_weight: d.weight_kg, p_frames: d.frames, p_raw: d.raw, p_error: d.error_code,
  });
  if (error) {
    if (/weight_read_closed/.test(error.message)) return fail(409, "weight_read_closed", "This request has expired.");
    if (/weight_read_not_found/.test(error.message)) return fail(404, "not_found", "Unknown request.");
    return fail(400, "weight_rejected", "The weight was not accepted.");
  }
  return ok({ saved: true });
}
