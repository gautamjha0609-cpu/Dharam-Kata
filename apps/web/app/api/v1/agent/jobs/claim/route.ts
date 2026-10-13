import { serviceClient } from "@/lib/supabase-server";
import { authenticateAgent, fail, ok } from "@/lib/api";

/** Atomic claim with lease. Returns only a job addressed to THIS agent; a guessed job id grants nothing. */
export async function POST(req: Request) {
  const agent = await authenticateAgent(req);
  if (!agent) return fail(401, "unauthenticated", "Invalid or revoked device credential.");
  const { data, error } = await serviceClient().rpc("agent_claim_job", { p_agent: agent });
  if (error) return fail(500, "claim_failed", "Could not claim a job.");
  return ok(data ?? null);
}
