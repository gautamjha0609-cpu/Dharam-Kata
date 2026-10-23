import { z } from "zod";
import { serviceClient } from "@/lib/supabase-server";
import { authenticateAgent, fail, ok } from "@/lib/api";

const Scale = z.object({
  enabled: z.boolean(),
  source: z.enum(["serial", "tcp", "sim"]).optional(),
  port: z.string().max(120).nullable().optional(),
  protocol: z.string().max(40).nullable().optional(),
  link: z.string().max(20).optional(),
  state: z.string().max(20).optional(),
  error: z.string().max(40).nullable().optional(),
  last_data_at: z.string().max(40).nullable().optional(),
});

const Body = z.object({
  version: z.string().max(40),
  os: z.string().max(80).default(""),
  printers: z.array(z.object({ name: z.string().max(200), status: z.string().max(40).default("ready") })).max(50).default([]),
  machine_id: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  // agents from 0.1.8 report their weighing scale; older agents send nothing and keep whatever was stored
  scale: Scale.nullable().optional(),
});

export async function POST(req: Request) {
  const agent = await authenticateAgent(req);
  if (!agent) return fail(401, "unauthenticated", "Invalid or revoked device credential.");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "invalid_request", "Invalid heartbeat");
  const sb = serviceClient();
  await sb.rpc("agent_heartbeat", { p_agent: agent, p_version: parsed.data.version, p_os: parsed.data.os, p_printers: parsed.data.printers });
  if (parsed.data.scale !== undefined) await sb.rpc("agent_report_scale", { p_agent: agent, p_scale: parsed.data.scale });
  // approval + the printer this PC must use (agents before 0.1.5 ignore it)
  const { data: state } = await sb.rpc("agent_state", { p_agent: agent, p_machine: parsed.data.machine_id ?? null });
  // where the "check now" signal for this PC is broadcast (a secret topic; the signal itself carries no data)
  let signal: { url: string; key: string; topic: string } | null = null;
  if (parsed.data.scale?.enabled) {
    const { data: key } = await sb.rpc("agent_signal_key", { p_agent: agent });
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (key && url && anon) signal = { url, key: anon, topic: `dk-agent-${key as string}` };
  }
  return ok({ server_time: new Date().toISOString(), state: state ?? null, signal });
}
