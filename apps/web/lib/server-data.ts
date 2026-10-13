import "server-only";
import { cache } from "react";
import { userClient } from "./supabase-server";
import type { Me, Settings, Site } from "./app-context";

/** One user client + ONE database call (who you are, your firms, the first firm's sites and billing unit) per request, shared by the layout and the page. */
export const getServerContext = cache(async () => {
  const sb = await userClient();
  const { data } = await sb.rpc("app_bootstrap");
  const b = data as unknown as (Me & { sites: Site[] | null; weight_unit: Settings["weight_unit"] }) | null;
  if (!b) return { sb, me: null as Me | null, sites: [] as Site[], settings: { weight_unit: null } as Settings };
  const { sites, weight_unit, ...me } = b;
  return { sb, me: me as Me, sites: sites ?? [], settings: { weight_unit: weight_unit ?? null } as Settings };
});
