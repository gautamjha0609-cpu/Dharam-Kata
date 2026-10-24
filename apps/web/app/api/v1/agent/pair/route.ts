import { z } from "zod";
import { serviceClient } from "@/lib/supabase-server";
import { clientIp, fail, ok, rateLimit } from "@/lib/api";

const Body = z.object({
  code: z.string().trim().min(6).max(20), label: z.string().trim().min(1).max(80), os: z.string().max(80).default(""),
  // agent 0.1.5+: stable id of this PC (sha-256 hex) and the printer chosen in the agent
  machine_id: z.string().regex(/^[0-9a-f]{64}$/).optional(), printer: z.string().trim().min(1).max(200).optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
});

/** The agent's version: every agent version sends "DharamKataPrintAgent/<version>" in its user agent (Electron adds it). */
function agentVersion(req: Request, fromBody?: string): string | null {
  if (fromBody) return fromBody;
  const m = /DharamKataPrintAgent[^/\s]*\/(\d+\.\d+\.\d+)/.exec(req.headers.get("user-agent") ?? "");
  return m ? m[1]! : null;
}

/** Consumes a one-time pairing code and returns a device-scoped credential (shown once; only its hash is stored). */
export async function POST(req: Request) {
  if (!rateLimit(`pair:${clientIp(req)}`, 8, 10 * 60_000)) return fail(429, "rate_limited", "Too many attempts. Wait a few minutes.");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "invalid_request", "Enter the pairing code and a name for this PC.");
  const { data, error } = await serviceClient().rpc("agent_pair", {
    p_code: parsed.data.code, p_label: parsed.data.label, p_os: parsed.data.os,
    p_machine: parsed.data.machine_id ?? null, p_printer: parsed.data.printer ?? null, p_version: agentVersion(req, parsed.data.version),
  });
  // this firm already uses a newer Print Agent: an older version is never paired again (the code stays usable for the newer one)
  const old = /agent_version_too_old:([\d.]+)/.exec(error?.message ?? "");
  if (old) return fail(409, "agent_version_too_old", `This firm uses Print Agent ${old[1]} or newer. This PC has an older version: install the latest setup file (version ${old[1]} or newer), then pair again with the same code.`);
  if (error || !data) return fail(401, "invalid_or_expired_code", "That code is invalid or has expired.");
  const r = (Array.isArray(data) ? data[0] : data) as { o_agent: string; o_token: string; o_site: string; o_approval: string };
  // approval "pending": another PC prints for this site; an owner / administrator must approve this PC on the website first
  return ok({ agent_id: r.o_agent, token: r.o_token, approval: r.o_approval });
}
