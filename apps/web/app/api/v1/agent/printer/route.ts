import { z } from "zod";
import { serviceClient } from "@/lib/supabase-server";
import { authenticateAgent, fail, ok } from "@/lib/api";

const Body = z.object({ printer: z.string().trim().min(1).max(200) });

/** "Change printer" in the agent: creates a request that an owner / administrator approves on the website. */
export async function POST(req: Request) {
  const agent = await authenticateAgent(req);
  if (!agent) return fail(401, "unauthenticated", "Invalid or revoked device credential.");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "invalid_request", "Choose a printer.");
  const { data, error } = await serviceClient().rpc("agent_request_printer", { p_agent: agent, p_printer: parsed.data.printer });
  if (error) return fail(409, "request_failed", "The printer change could not be requested.");
  return ok({ state: data });
}
