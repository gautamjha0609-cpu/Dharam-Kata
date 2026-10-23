import { serviceClient } from "@/lib/supabase-server";
import { authenticateAgent, fail, ok } from "@/lib/api";

/** The oldest "Detect weight" request addressed to THIS printer PC (or null). A guessed id grants nothing. */
export async function POST(req: Request) {
  const agent = await authenticateAgent(req);
  if (!agent) return fail(401, "unauthenticated", "Invalid or revoked device credential.");
  const { data, error } = await serviceClient().rpc("agent_next_weight_read", { p_agent: agent });
  if (error) return fail(500, "weight_next_failed", "Could not check for weight requests.");
  return ok(data ?? null);
}
