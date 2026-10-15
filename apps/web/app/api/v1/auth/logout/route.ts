import { cookies } from "next/headers";
import { authClient } from "@/lib/supabase-server";
import { ok } from "@/lib/api";
import { DEVICE_COOKIE, releaseDevice } from "@/lib/device-limits";

export const dynamic = "force-dynamic";

/** Ends the session on the server, clears the cookies and frees this device's slot (at most 2 devices per user). */
export async function POST() {
  const sb = await authClient();
  const { data } = await sb.auth.getUser();
  const deviceId = (await cookies()).get(DEVICE_COOKIE)?.value;
  if (data.user && deviceId) await releaseDevice(data.user.id, deviceId).catch(() => {});
  await sb.auth.signOut({ scope: "local" });
  return ok({ signed_out: true });
}
