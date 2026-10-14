import { z } from "zod";
import { loginIdToEmail } from "@/lib/login-id";
import { authClient } from "@/lib/supabase-server";
import { clientIp, fail, ok, rateLimit } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({ login_id: z.string().trim().min(1).max(64), password: z.string().min(1).max(200) });

/**
 * Sign-in happens HERE, on the server. The browser sends the credentials once, over HTTPS, in the body of a POST to this site;
 * it never calls the auth server itself, so the password cannot appear in the browser's console or in a URL.
 * Wrong id and wrong password give the same answer, repeated attempts are slowed down, and nothing is logged.
 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "invalid_request", "Enter your login ID and password.");
  const { login_id, password } = parsed.data;
  if (!rateLimit(`login:ip:${ip}`, 20, 60_000) || !rateLimit(`login:id:${login_id.toLowerCase()}`, 8, 5 * 60_000))
    return fail(429, "rate_limited", "Too many attempts. Please wait a few minutes and try again.");

  const sb = await authClient();
  const { error } = await sb.auth.signInWithPassword({ email: loginIdToEmail(login_id), password });
  // a wrong password is an ordinary answer (200), not an error response: nothing red appears in the browser console
  if (error) return ok({ signed_in: false, message: "Login ID or password is incorrect." });
  return ok({ signed_in: true });
}
