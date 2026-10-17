import { NextResponse } from "next/server";
import { authClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * Finishes the platform admin's "Open as this firm": the one-time token (created by /api/v1/admin/open-as for a super admin)
 * signs this browser in as that firm user. No device check: the admin is never blocked and uses none of the user's 2 slots.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("t") ?? "";
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) return NextResponse.redirect(new URL("/login", url.origin));
  const sb = await authClient();
  await sb.auth.signOut({ scope: "local" }).catch(() => {}); // leave the admin's own session in this browser
  const { error } = await sb.auth.verifyOtp({ type: "magiclink", token_hash: token });
  if (error) return NextResponse.redirect(new URL("/login?expired=1", url.origin));
  return NextResponse.redirect(new URL("/", url.origin));
}
