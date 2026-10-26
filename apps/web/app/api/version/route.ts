import { NextResponse } from "next/server";

// built once per deployment and served from the CDN: the "new version?" check (every open tab, every 15 min) costs no server time
export const dynamic = "force-static";

/** The id of the build that is running. No database, no data: the app compares it with the one it was loaded from. */
export function GET() {
  return NextResponse.json({ v: process.env.NEXT_PUBLIC_BUILD_ID ?? "dev" });
}
