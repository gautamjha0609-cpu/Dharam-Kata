import { getServerContext } from "@/lib/server-data";
import { fetchDashboard } from "@/lib/dashboard-data";
import { DashboardView } from "@/components/dashboard-view";

/** The dashboard numbers are fetched here, on the server, so they are in the first page the browser receives. */
export default async function DashboardPage() {
  const { sb, me } = await getServerContext();
  const first = me?.memberships[0];
  const initial = first?.permissions.includes("invoice.read") ? await fetchDashboard(sb, first.organization_id) : null;
  return <DashboardView initial={initial} />;
}
