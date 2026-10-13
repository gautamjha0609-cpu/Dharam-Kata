import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** The id of the build that is running. No database, no data: the app compares it with the one it was loaded from. */
export function GET() {
  return NextResponse.json({ v: process.env.NEXT_PUBLIC_BUILD_ID ?? "dev" }, { headers: { "cache-control": "no-store" } });
}
