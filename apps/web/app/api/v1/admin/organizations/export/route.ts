import ExcelJS from "exceljs";
import { daysLeft } from "@dk/domain";
import { serviceClient } from "@/lib/supabase-server";
import { currentUser, fail, rateLimit } from "@/lib/api";

export const dynamic = "force-dynamic";

const IST = "Asia/Kolkata";
const fmt = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-GB", { timeZone: IST, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)).replace(",", "") : "");
const dmy = (d: string | null) => (d ? d.split("-").reverse().join("-") : "");

interface Org {
  id: string; display_name: string; legal_name: string; slug: string; status: string; created_at: string; suspended_at: string | null; suspension_reason: string | null;
  contact_mobile: string | null; contact_email: string | null; referral: string | null; activation_date: string; service_until: string; extension_count: number; last_extended_at: string | null; plan_code: string;
}
const kindOf = (o: Org) => (o.status === "suspended" ? "suspended" : daysLeft(o.service_until) <= 0 ? "expired" : !["active", "trial", "grace"].includes(o.status) ? "other" : daysLeft(o.service_until) <= 10 ? "due_soon" : "active");

/** Platform admin only. Excel of the firms with all their details; the same status / column filter as the screen. */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return fail(401, "unauthenticated", "Please sign in.");
  const { data: isAdmin } = await user.sb.rpc("is_platform_admin", { roles: ["super_admin"] });
  if (!isAdmin) return fail(403, "forbidden", "Platform administrators only.");
  if (!rateLimit(`orgexp:${user.id}`, 10, 60_000)) return fail(429, "rate_limited", "Too many exports. Try again shortly.");
  const q = new URL(req.url).searchParams;
  const status = q.get("status") ?? "all", column = q.get("column") ?? "", value = (q.get("value") ?? "").trim().toLowerCase();

  const svc = serviceClient();
  const { data, error } = await svc.from("organizations").select("*").order("created_at", { ascending: false });
  if (error) return fail(500, "query_failed", "Could not read the firms.");
  let orgs = (data ?? []) as unknown as Org[];
  if (["active", "due_soon", "expired", "suspended", "other"].includes(status)) orgs = orgs.filter((o) => kindOf(o) === status);
  const cell = (o: Org): Record<string, string | null> => ({ referral: o.referral, name: o.display_name, legal: o.legal_name, slug: o.slug, mobile: o.contact_mobile, email: o.contact_email });
  if (value && column in cell(orgs[0] ?? ({} as Org))) orgs = orgs.filter((o) => (cell(o)[column] ?? "").toLowerCase().includes(value));

  const ids = orgs.map((o) => o.id);
  const [mem, sites] = await Promise.all([
    svc.from("organization_memberships").select("organization_id,user_id,role,status,profiles(login_id,full_name)").in("organization_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]),
    svc.from("sites").select("organization_id").in("organization_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]),
  ]);
  type M = { organization_id: string; role: string; status: string; profiles: { login_id: string; full_name: string } | null };
  const members = (mem.data ?? []) as unknown as M[];
  const siteCount = new Map<string, number>();
  for (const s of (sites.data ?? []) as { organization_id: string }[]) siteCount.set(s.organization_id, (siteCount.get(s.organization_id) ?? 0) + 1);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Dharam Kata";
  const ws = wb.addWorksheet("Firms", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Display name", key: "dn", width: 28 }, { header: "Legal name", key: "ln", width: 30 }, { header: "Short ID", key: "slug", width: 20 }, { header: "Standing", key: "kind", width: 16 }, { header: "Status", key: "st", width: 12 },
    { header: "Referral", key: "ref", width: 22 }, { header: "Mobile", key: "mob", width: 14 }, { header: "Email", key: "em", width: 28 },
    { header: "Activation date", key: "act", width: 15 }, { header: "Valid till", key: "until", width: 13 }, { header: "Days left", key: "left", width: 10 }, { header: "Times extended", key: "ext", width: 14 }, { header: "Last extended", key: "lext", width: 18 },
    { header: "Owner login", key: "ol", width: 20 }, { header: "Owner name", key: "on", width: 22 }, { header: "Users", key: "users", width: 8 }, { header: "Sites", key: "sites", width: 8 },
    { header: "Created", key: "cr", width: 18 }, { header: "Suspended at", key: "sat", width: 18 }, { header: "Suspension reason", key: "sr", width: 28 }, { header: "Plan", key: "plan", width: 10 },
  ];
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B2D4C" } };
  const label: Record<string, string> = { active: "Active", due_soon: "Renew soon", expired: "EXPIRED", suspended: "SUSPENDED", other: "Other" };
  for (const o of orgs) {
    const ms = members.filter((m) => m.organization_id === o.id), owner = ms.find((m) => m.role === "owner");
    const k = kindOf(o);
    const row = ws.addRow({
      dn: o.display_name, ln: o.legal_name, slug: o.slug, kind: label[k], st: o.status, ref: o.referral ?? "", mob: o.contact_mobile ?? "", em: o.contact_email ?? "",
      act: dmy(o.activation_date), until: dmy(o.service_until), left: daysLeft(o.service_until), ext: o.extension_count, lext: fmt(o.last_extended_at),
      ol: owner?.profiles?.login_id ?? "", on: owner?.profiles?.full_name ?? "", users: ms.length, sites: siteCount.get(o.id) ?? 0,
      cr: fmt(o.created_at), sat: fmt(o.suspended_at), sr: o.suspension_reason ?? "", plan: o.plan_code,
    });
    if (k === "expired" || k === "suspended") row.font = { color: { argb: "FFB42318" }, bold: true }; // red, like on screen
  }
  ws.autoFilter = { from: "A1", to: { row: 1, column: ws.columnCount } };
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const day = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10).split("-").reverse().join("-");
  return new Response(buf, { headers: {
    "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "content-disposition": `attachment; filename="firms_${status}_${day}.xlsx"`, "cache-control": "private, no-store",
  } });
}
