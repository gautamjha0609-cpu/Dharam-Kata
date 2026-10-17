import ExcelJS from "exceljs";
import { currentUser, fail, rateLimit } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const IST = "Asia/Kolkata";
const dt = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-GB", { timeZone: IST, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)).replace(",", "") : "");
const dmy = (d: string | null) => (d ? d.split("-").reverse().join("-") : "");
const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Row = Record<string, unknown>;

/**
 * Platform admin only. One workbook: (1) Debtors, one row per debtor per firm, (2) Daily summary per firm, (3) every entry day-wise.
 * Same filters as the Reports screen: ?org=<firm id or empty for all>&from=YYYY-MM-DD&to=YYYY-MM-DD (empty = all time).
 * All totals come from the database (aggregated there); entries are read in pages.
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return fail(401, "unauthenticated", "Please sign in.");
  const { data: isAdmin } = await user.sb.rpc("is_platform_admin", { roles: ["super_admin"] });
  if (!isAdmin) return fail(403, "forbidden", "Platform administrators only.");
  if (!rateLimit(`repexp:${user.id}`, 6, 60_000)) return fail(429, "rate_limited", "Too many exports. Try again shortly.");
  const q = new URL(req.url).searchParams;
  const org = q.get("org") ?? "", from = q.get("from") ?? "", to = q.get("to") ?? "";
  if (org && !/^[0-9a-f-]{36}$/i.test(org)) return fail(400, "invalid_request", "Invalid firm.");
  if ((from && !DAY.test(from)) || (to && !DAY.test(to))) return fail(400, "invalid_request", "Invalid date.");
  const args = { p_org: (org || null) as unknown as string, p_from: (from || null) as unknown as string, p_to: (to || null) as unknown as string };

  const [deb, day] = await Promise.all([user.sb.rpc("admin_debtor_report", args), user.sb.rpc("admin_daily_report", args)]);
  if (deb.error || day.error) return fail(500, "query_failed", "Could not read the report.");
  const entries: Row[] = [];
  for (let off = 0; off < 200_000; off += 5000) {
    const { data, error } = await user.sb.rpc("admin_entries_report", { ...args, p_limit: 5000, p_offset: off });
    if (error) return fail(500, "query_failed", "Could not read the entries.");
    const page = (data as { rows: Row[]; total: number }).rows;
    entries.push(...page);
    if (page.length < 5000) break;
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "Dharam Kata";
  const head = (ws: ExcelJS.Worksheet) => {
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B2D4C" } };
    ws.autoFilter = { from: "A1", to: { row: 1, column: ws.columnCount } };
  };
  const money = "#,##0.00";

  const d1 = wb.addWorksheet("Debtors", { views: [{ state: "frozen", ySplit: 1 }] });
  d1.columns = [
    { header: "Firm ID", key: "org_id", width: 38 }, { header: "Firm short ID", key: "slug", width: 18 }, { header: "Firm", key: "firm", width: 26 },
    { header: "Debtor", key: "debtor", width: 28 }, { header: "Mobile", key: "mobile", width: 14 }, { header: "GSTIN", key: "gstin", width: 18 }, { header: "PAN", key: "pan", width: 12 },
    { header: "Email", key: "email", width: 24 }, { header: "Contact person", key: "contact", width: 18 }, { header: "Address", key: "address", width: 32 },
    { header: "Amount billed (₹)", key: "billed", width: 16, style: { numFmt: money } }, { header: "Opening slips", key: "opening_slips", width: 13 }, { header: "Closing slips", key: "closing_slips", width: 13 },
    { header: "Paid (₹)", key: "paid", width: 14, style: { numFmt: money } }, { header: "Due (₹)", key: "due", width: 14, style: { numFmt: money } },
    { header: "First bill", key: "first_bill", width: 17 }, { header: "Last bill", key: "last_bill", width: 17 }, { header: "Active", key: "active", width: 8 }, { header: "Debtor ID", key: "debtor_id", width: 38 },
  ];
  for (const r of (deb.data ?? []) as Row[]) d1.addRow({ ...r, billed: n(r.billed), paid: n(r.paid), due: n(r.due), opening_slips: n(r.opening_slips), closing_slips: n(r.closing_slips), first_bill: dt(r.first_bill as string), last_bill: dt(r.last_bill as string), active: r.active ? "Yes" : "No" });
  head(d1);

  const d2 = wb.addWorksheet("Daily summary", { views: [{ state: "frozen", ySplit: 1 }] });
  d2.columns = [
    { header: "Date", key: "day", width: 12 }, { header: "Firm ID", key: "org_id", width: 38 }, { header: "Firm short ID", key: "slug", width: 18 }, { header: "Firm", key: "firm", width: 26 },
    { header: "Opening slips", key: "opening_slips", width: 13 }, { header: "Closing slips", key: "closing_slips", width: 13 }, { header: "Still open", key: "still_open", width: 10 },
    { header: "Billed (₹, by entry date)", key: "billed", width: 20, style: { numFmt: money } }, { header: "Cash (₹)", key: "cash", width: 14, style: { numFmt: money } }, { header: "Credit (₹)", key: "credit", width: 14, style: { numFmt: money } },
  ];
  for (const r of (day.data ?? []) as Row[]) d2.addRow({ ...r, day: dmy(r.day as string), billed: n(r.billed), cash: n(r.cash), credit: n(r.credit), opening_slips: n(r.opening_slips), closing_slips: n(r.closing_slips), still_open: n(r.still_open) });
  head(d2);

  const d3 = wb.addWorksheet("Entries (day-wise)", { views: [{ state: "frozen", ySplit: 1 }] });
  d3.columns = [
    { header: "Date", key: "day", width: 12 }, { header: "Firm ID", key: "org_id", width: 38 }, { header: "Firm short ID", key: "slug", width: 18 }, { header: "Firm", key: "firm", width: 24 }, { header: "Site", key: "site", width: 12 },
    { header: "Invoice no.", key: "invoice_no", width: 20 }, { header: "Vehicle", key: "vehicle", width: 15 }, { header: "Stage", key: "stage", width: 9 },
    { header: "Opened", key: "opened_at", width: 17 }, { header: "Closed", key: "closed_at", width: 17 }, { header: "First weight (kg)", key: "first_weight", width: 15 },
    { header: "Gross (kg)", key: "gross", width: 12 }, { header: "Tare (kg)", key: "tare", width: 12 }, { header: "Net (kg)", key: "net", width: 12 },
    { header: "Amount (₹)", key: "amount", width: 13, style: { numFmt: money } }, { header: "Payment", key: "payment", width: 9 }, { header: "Party", key: "party", width: 24 }, { header: "Material", key: "material", width: 18 },
  ];
  for (const r of entries) d3.addRow({ ...r, day: dmy(r.day as string), stage: r.stage === "closed" ? "Closed" : "Open", opened_at: dt(r.opened_at as string), closed_at: dt(r.closed_at as string), first_weight: n(r.first_weight), gross: n(r.gross), tare: n(r.tare), net: n(r.net), amount: n(r.amount) });
  head(d3);

  const buf = await wb.xlsx.writeBuffer();
  const name = `dharam-kata-report_${org ? (((deb.data ?? []) as Row[])[0]?.slug as string) ?? "firm" : "all-firms"}_${from || "start"}_to_${to || "today"}.xlsx`;
  return new Response(buf, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, "_")}"` } });
}
