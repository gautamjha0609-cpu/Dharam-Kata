import { z } from "zod";
import { serviceClient } from "@/lib/supabase-server";
import { clientIp, fail, ok, rateLimit } from "@/lib/api";

const Body = z.object({
  code: z.string().trim().min(6).max(20), label: z.string().trim().min(1).max(80), os: z.string().max(80).default(""),
  // agent 0.1.5+: stable id of this PC (sha-256 hex) and the printer chosen in the agent
  machine_id: z.string().regex(/^[0-9a-f]{64}$/).optional(), printer: z.string().trim().min(1).max(200).optional(),
});

/** Consumes a one-time pairing code and returns a device-scoped credential (shown once; only its hash is stored). */
export async function POST(req: Request) {
  if (!rateLimit(`pair:${clientIp(req)}`, 8, 10 * 60_000)) return fail(429, "rate_limited", "Too many attempts. Wait a few minutes.");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "invalid_request", "Enter the pairing code and a name for this PC.");
  const { data, error } = await serviceClient().rpc("agent_pair", {
    p_code: parsed.data.code, p_label: parsed.data.label, p_os: parsed.data.os,
    p_machine: parsed.data.machine_id ?? null, p_printer: parsed.data.printer ?? null,
  });
  if (error || !data) return fail(401, "invalid_or_expired_code", "That code is invalid or has expired.");
  const r = (Array.isArray(data) ? data[0] : data) as { o_agent: string; o_token: string; o_site: string; o_approval: string };
  // approval "pending": another PC prints for this site; an owner / administrator must approve this PC on the website first
  return ok({ agent_id: r.o_agent, token: r.o_token, approval: r.o_approval });
}
