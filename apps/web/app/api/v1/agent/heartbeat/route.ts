import { z } from "zod";
import { serviceClient } from "@/lib/supabase-server";
import { authenticateAgent, fail, ok } from "@/lib/api";

const Body = z.object({
  version: z.string().max(40),
  os: z.string().max(80).default(""),
  printers: z.array(z.object({ name: z.string().max(200), status: z.string().max(40).default("ready") })).max(50).default([]),
  machine_id: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

export async function POST(req: Request) {
  const agent = await authenticateAgent(req);
  if (!agent) return fail(401, "unauthenticated", "Invalid or revoked device credential.");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "invalid_request", "Invalid heartbeat");
  const sb = serviceClient();
  await sb.rpc("agent_heartbeat", { p_agent: agent, p_version: parsed.data.version, p_os: parsed.data.os, p_printers: parsed.data.printers });
  // approval + the printer this PC must use (agents before 0.1.5 ignore it)
  const { data: state } = await sb.rpc("agent_state", { p_agent: agent, p_machine: parsed.data.machine_id ?? null });
  return ok({ server_time: new Date().toISOString(), state: state ?? null });
}
