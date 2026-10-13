import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/** Uptime / keep-alive check: touches the database so a free-tier project never goes idle, and reports how fast it answered. No data is returned. */
export async function GET() {
  const t0 = performance.now();
  const { error } = await serviceClient().from("organizations").select("id", { head: true, count: "exact" }).limit(1);
  const ms = Math.round(performance.now() - t0);
  return NextResponse.json({ ok: !error, db_ms: ms }, { status: error ? 503 : 200, headers: { "cache-control": "no-store" } });
}
