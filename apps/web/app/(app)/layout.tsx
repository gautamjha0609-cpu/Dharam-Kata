import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getServerContext } from "@/lib/server-data";
import { AppProvider } from "@/lib/app-context";
import { Shell } from "@/components/shell";

/**
 * The signed-in frame is rendered on the server: who you are, your firm, its sites and billing unit arrive WITH the page,
 * so the sidebar, header and page title are on screen immediately instead of after a "Loading…" and two round trips.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { me, sites, settings } = await getServerContext();
  if (!me) redirect("/login");
  const first = me.memberships[0] ?? null;
  return (
    <AppProvider initial={{ me, orgId: first?.organization_id ?? null, sites, settings }}>
      <Shell>{children}</Shell>
    </AppProvider>
  );
}
