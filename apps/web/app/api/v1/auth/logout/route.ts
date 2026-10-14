import { authClient } from "@/lib/supabase-server";
import { ok } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Ends the session on the server and clears the cookies. */
export async function POST() {
  const sb = await authClient();
  await sb.auth.signOut();
  return ok({ signed_out: true });
}
