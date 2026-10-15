import { z } from "zod";
import { cookies } from "next/headers";
import { loginIdToEmail } from "@/lib/login-id";
import { authClient } from "@/lib/supabase-server";
import { clientIp, fail, ok, rateLimit } from "@/lib/api";
import { DEVICE_COOKIE, checkDeviceLogin } from "@/lib/device-limits";

export const dynamic = "force-dynamic";

const Body = z.object({ login_id: z.string().trim().min(1).max(64), password: z.string().min(1).max(200) });

/**
 * Sign-in happens HERE, on the server. The browser sends the credentials once, over HTTPS, in the body of a POST to this site;
 * it never calls the auth server itself, so the password cannot appear in the browser's console or in a URL.
 * At most 2 devices per user: a 3rd device is refused (the devices already signed in keep working).
 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "invalid_request", "Enter your login ID and password.");
  const { login_id, password } = parsed.data;
  if (!rateLimit(`login:ip:${ip}`, 20, 60_000) || !rateLimit(`login:id:${login_id.toLowerCase()}`, 8, 5 * 60_000))
    return fail(429, "rate_limited", "Too many attempts. Please wait a few minutes and try again.");

  const sb = await authClient();
  const { data: authData, error } = await sb.auth.signInWithPassword({ email: loginIdToEmail(login_id), password });
  // a wrong password is an ordinary answer (200), not an error response: nothing red appears in the browser console
  if (error || !authData?.user) return ok({ signed_in: false, message: "Login ID or password is incorrect." });

  // at most 2 devices: this browser is identified by a random id in an http-only cookie
  const store = await cookies();
  let deviceId = store.get(DEVICE_COOKIE)?.value;
  if (!deviceId || !/^[0-9a-f-]{36}$/.test(deviceId)) {
    deviceId = crypto.randomUUID();
    store.set(DEVICE_COOKIE, deviceId, { maxAge: 60 * 60 * 24 * 365 * 5, sameSite: "lax", path: "/", httpOnly: true, secure: process.env.NODE_ENV === "production" });
  }
  const dev = await checkDeviceLogin(authData.user.id, deviceId, req.headers.get("user-agent") ?? "", ip);
  if (!dev.allowed) {
    // end ONLY the session just created on this browser ("local"): the user's other devices must stay signed in
    await sb.auth.signOut({ scope: "local" });
    return ok({ signed_in: false, message: dev.message });
  }

  return ok({ signed_in: true });
}
