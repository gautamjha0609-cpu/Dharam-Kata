"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ADMIN_PATH } from "@/lib/admin-path";
import { checkGstin, checkMobile, checkPan, daysLeft } from "@dk/domain";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { fmtDateTime } from "@/lib/format";
import { Select } from "@/components/ios";
import { Alert, Modal, PageHead } from "@/components/ui";

interface Org {
  id: string; display_name: string; legal_name: string; slug: string; status: string; created_at: string; suspension_reason: string | null;
  contact_mobile: string | null; contact_email: string | null; referral: string | null; gstin: string | null; pan: string | null; activation_date: string; service_until: string; extension_count: number; last_extended_at: string | null;
}
const COLS = "id,display_name,legal_name,slug,status,created_at,suspension_reason,contact_mobile,contact_email,referral,gstin,pan,activation_date,service_until,extension_count,last_extended_at";
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const blank = { legal_name: "", display_name: "", slug: "", contact_mobile: "", contact_email: "", referral: "", gstin: "", pan: "", activation_date: "", owner_login_id: "", owner_name: "", owner_temp_password: "", site_name: "Main", site_code: "MAIN" };
const dmy = (d: string) => new Date(`${d}T00:00:00+05:30`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

type Msg = { k: "ok" | "error"; t: string };

/** GSTIN / PAN are filled in only when the owner has them: empty is fine, anything typed must be in the correct format (and agree with each other). */
function taxProblem(gstin: string, pan: string): string | null {
  const g = gstin.trim() ? checkGstin(gstin) : null, p = pan.trim() ? checkPan(pan) : null;
  if (g && !g.ok) return g.message;
  if (p && !p.ok) return p.message;
  if (g?.ok && p?.ok && g.value.slice(2, 12) !== p.value) return "This PAN does not match the GSTIN (a GSTIN contains the PAN).";
  return null;
}
/** The clean values to store. A valid GSTIN fills an empty PAN by itself. */
function taxValues(gstin: string, pan: string): { gstin: string; pan: string } {
  const g = gstin.trim() ? checkGstin(gstin) : null, p = pan.trim() ? checkPan(pan) : null;
  return { gstin: g?.ok ? g.value : "", pan: p?.ok ? p.value : g?.ok ? g.value.slice(2, 12) : "" };
}
type Kind = "active" | "due_soon" | "expired" | "suspended" | "other";
/** One word for the firm's situation. "expired" = the service term ended and nobody has extended it yet. */
function kindOf(o: Org): Kind {
  if (o.status === "suspended") return "suspended";
  if (daysLeft(o.service_until) <= 0) return "expired";
  if (!["active", "trial", "grace"].includes(o.status)) return "other";
  return daysLeft(o.service_until) <= 10 ? "due_soon" : "active";
}

export default function PlatformAdminPage() {
  const { me } = useApp();
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [f, setF] = useState(blank);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState<Org | null>(null);
  const [filter, setFilter] = useState({ status: "all", column: "referral", value: "" });

  const load = useCallback(async () => {
    const { data } = await supabase().from("organizations").select(COLS).order("created_at", { ascending: false });
    setOrgs((data ?? []) as unknown as Org[]);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => orgs.filter((o) => {
    const k = kindOf(o);
    if (filter.status !== "all" && k !== filter.status) return false;
    const v = filter.value.trim().toLowerCase();
    if (!v) return true;
    const cell: Record<string, string | null> = { referral: o.referral, name: o.display_name, legal: o.legal_name, slug: o.slug, mobile: o.contact_mobile, email: o.contact_email, gstin: o.gstin, pan: o.pan };
    return (cell[filter.column] ?? "").toLowerCase().includes(v);
  }), [orgs, filter]);

  if (!me.is_platform_admin) return <Alert kind="warn">Platform administrators only.</Alert>;

  async function post(url: string, body: unknown) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok, message: j?.error?.message as string | undefined };
  }
  async function create() {
    if (f.contact_mobile.trim() && !checkMobile(f.contact_mobile).ok) return setMsg({ k: "error", t: "Mobile number has 10 digits and starts with 6, 7, 8 or 9." });
    if (f.contact_email.trim() && !EMAIL.test(f.contact_email.trim())) return setMsg({ k: "error", t: "Enter a valid email address or leave it empty." });
    const gp = taxProblem(f.gstin, f.pan);
    if (gp) return setMsg({ k: "error", t: gp });
    setBusy(true); setMsg(null);
    const m = f.contact_mobile.trim() ? checkMobile(f.contact_mobile) : null;
    const r = await post("/api/v1/admin/organizations", { ...f, ...taxValues(f.gstin, f.pan), contact_mobile: m && m.ok ? m.value : "", activation_date: f.activation_date || undefined });
    setBusy(false);
    if (!r.ok) return setMsg({ k: "error", t: r.message ?? "Could not create the firm." });
    setMsg({ k: "ok", t: `Created "${f.display_name}". The service runs for one year from the activation date. Give the owner their login ID and password.` });
    setF(blank); void load();
  }
  async function setStatus(o: Org, status: string) {
    let reason: string | undefined;
    if (status === "suspended") { reason = prompt(`Reason for suspending ${o.display_name}:`) ?? ""; if (!reason) return; }
    const r = await post("/api/v1/admin/organizations/status", { organization_id: o.id, status, reason });
    setMsg(r.ok ? { k: "ok", t: `${o.display_name} is now ${status}.` } : { k: "error", t: r.message ?? "Failed." });
    void load();
  }
  async function extend(o: Org) {
    const { data, error } = await supabase().rpc("platform_extend_org", { p_org: o.id });
    if (error) return setMsg({ k: "error", t: "Could not extend." });
    setOrgs((list) => list.map((x) => (x.id === o.id ? { ...x, service_until: data as unknown as string, extension_count: x.extension_count + 1 } : x))); // shown at once
    setMsg({ k: "ok", t: `${o.display_name} extended by one year. Valid till ${dmy(data as unknown as string)}.` });
  }
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const exportUrl = `/api/v1/admin/organizations/export?${new URLSearchParams({ status: filter.status, column: filter.column, value: filter.value.trim() })}`;

  return (
    <div className="space-y-5">
      <PageHead title="Platform admin" sub="Client firms (tenants). Each firm's data is fully separate. Each firm's service runs one year at a time." actions={<Link href={ADMIN_PATH + "/communication"} className="btn-navy">📣 Communication</Link>} />
      {msg && <Alert kind={msg.k}>{msg.t}</Alert>}

      <section className="card space-y-3">
        <h2 className="font-bold text-navy">Create a client firm</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label" htmlFor="a1">Legal name</label><input id="a1" className="field" value={f.legal_name} onChange={set("legal_name")} /></div>
          <div><label className="label" htmlFor="a2">Display name</label><input id="a2" className="field" value={f.display_name} onChange={set("display_name")} /></div>
          <div><label className="label" htmlFor="a3">Short ID (slug)</label><input id="a3" className="field" autoCapitalize="none" value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase() })} placeholder="acme-traders" /></div>
          <div><label className="label" htmlFor="a9">Activation date</label><input id="a9" type="date" className="field" value={f.activation_date} onChange={set("activation_date")} />
            <p className="mt-1 text-xs text-slate-600">The service starts on this day and stops exactly one year later until you extend it. Empty = today.</p></div>
          <div><label className="label" htmlFor="b1">Mobile number (optional)</label><input id="b1" className="field" inputMode="tel" maxLength={14} value={f.contact_mobile} onChange={(e) => setF({ ...f, contact_mobile: e.target.value.replace(/[^0-9+\s-]/g, "") })} placeholder="98765 43210" /></div>
          <div><label className="label" htmlFor="b2">Email (optional)</label><input id="b2" type="email" className="field" autoCapitalize="none" value={f.contact_email} onChange={set("contact_email")} placeholder="owner@firm.com" /></div>
          <div className="sm:col-span-2"><label className="label" htmlFor="b3">Referral (optional)</label><input id="b3" className="field" maxLength={120} value={f.referral} onChange={set("referral")} placeholder="Who referred this firm" /></div>
          <div><label className="label" htmlFor="b4">GSTIN</label><input id="b4" className={`field uppercase ${f.gstin && !checkGstin(f.gstin).ok ? "!border-red-500" : ""}`} maxLength={15} autoCapitalize="characters" placeholder="27ABCDE1234F1Z5" value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.replace(/\s/g, "").toUpperCase() })} /></div>
          <div><label className="label" htmlFor="b5">PAN</label><input id="b5" className={`field uppercase ${f.pan && !checkPan(f.pan).ok ? "!border-red-500" : ""}`} maxLength={10} autoCapitalize="characters" placeholder="ABCDE1234F" value={f.pan} onChange={(e) => setF({ ...f, pan: e.target.value.replace(/\s/g, "").toUpperCase() })} /></div>
          <div><label className="label" htmlFor="a4">First site name</label><input id="a4" className="field" value={f.site_name} onChange={set("site_name")} /></div>
          <div><label className="label" htmlFor="a5">First site code</label><input id="a5" className="field uppercase" value={f.site_code} onChange={set("site_code")} /></div>
          <div><label className="label" htmlFor="a6">Owner login ID</label><input id="a6" className="field" autoCapitalize="none" value={f.owner_login_id} onChange={(e) => setF({ ...f, owner_login_id: e.target.value.toLowerCase() })} /></div>
          <div><label className="label" htmlFor="a7">Owner name</label><input id="a7" className="field" value={f.owner_name} onChange={set("owner_name")} /></div>
          <div className="sm:col-span-2"><label className="label" htmlFor="a8">Owner password</label><input id="a8" className="field" autoComplete="off" value={f.owner_temp_password} onChange={set("owner_temp_password")} /></div>
        </div>
        <p className="text-xs text-slate-600">You set the owner's password; the owner cannot change it. Passwords are never shown again.</p>
        <button className="btn-primary" disabled={busy || !f.display_name || !f.slug || !f.owner_login_id || f.owner_temp_password.length < 10} onClick={create}>{busy ? "Creating…" : "Create firm"}</button>
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
          <h2 className="font-bold text-navy">Client firms ({shown.length}{shown.length !== orgs.length ? ` of ${orgs.length}` : ""})</h2>
          <a className="btn-navy !min-h-[40px]" href={exportUrl}>⬇ Export to Excel</a>
        </div>
        <div className="card mb-3 grid gap-2 sm:grid-cols-[1fr_1fr_1.4fr]">
          <div><label className="label text-xs" htmlFor="fs">Show</label>
            <Select id="fs" className="field !min-h-[40px]" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
              <option value="all">All firms (full dump)</option><option value="active">Active</option><option value="due_soon">Renewal due in 10 days</option><option value="expired">Expired (not extended)</option><option value="suspended">Suspended by admin</option>
            </Select></div>
          <div><label className="label text-xs" htmlFor="fc">Filter by column</label>
            <Select id="fc" className="field !min-h-[40px]" value={filter.column} onChange={(e) => setFilter({ ...filter, column: e.target.value })}>
              <option value="referral">Referral</option><option value="name">Display name</option><option value="legal">Legal name</option><option value="slug">Short ID</option><option value="mobile">Mobile</option><option value="email">Email</option><option value="gstin">GSTIN</option><option value="pan">PAN</option>
            </Select></div>
          <div><label className="label text-xs" htmlFor="fv">Contains</label><input id="fv" className="field !min-h-[40px]" type="search" value={filter.value} onChange={(e) => setFilter({ ...filter, value: e.target.value })} placeholder="Type to filter the list and the Excel" /></div>
        </div>
        <ul className="space-y-2">
          {shown.map((o) => {
            const k = kindOf(o), days = daysLeft(o.service_until), red = k === "expired" || k === "suspended";
            return (
              <li key={o.id} className={`card ${red ? "!border-red-400 !bg-red-50" : k === "due_soon" ? "!border-amber-300 !bg-amber-50" : ""}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className={`font-semibold ${red ? "text-red-700" : "text-navy"}`}>{o.display_name} <span className={`text-sm font-normal ${red ? "text-red-600" : "text-slate-600"}`}>· {o.slug}</span></p>
                    <p className={`text-xs ${red ? "text-red-700" : "text-slate-600"}`}>
                      {o.legal_name}{o.referral ? ` · referral: ${o.referral}` : ""}{o.contact_mobile ? ` · ${o.contact_mobile}` : ""}{o.contact_email ? ` · ${o.contact_email}` : ""}{o.gstin ? ` · GSTIN ${o.gstin}` : ""}{o.pan ? ` · PAN ${o.pan}` : ""}
                    </p>
                    <p className={`text-xs ${red ? "font-semibold text-red-700" : "text-slate-600"}`}>
                      Activated {dmy(o.activation_date)} · valid till {dmy(o.service_until)}
                      {k === "expired" ? ` · EXPIRED ${Math.abs(days) === 0 ? "today" : `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`}: the firm is suspended until you extend it` : k === "due_soon" ? ` · ${days} day${days === 1 ? "" : "s"} left` : ""}
                      {o.suspension_reason ? ` · suspended: ${o.suspension_reason}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`badge ${k === "active" ? "bg-green-100 text-green-800" : k === "due_soon" ? "bg-amber-100 text-amber-900" : k === "other" ? "bg-slate-100 text-slate-700" : "bg-red-100 text-red-800"}`}>
                      {k === "expired" ? "expired" : k === "due_soon" ? "renew soon" : o.status}
                    </span>
                    <button className="btn-primary !min-h-[36px]" onClick={() => void extend(o)} title="Adds one year to the valid-till date">+1 year</button>
                    <button className="btn-ghost !min-h-[36px]" onClick={() => setEdit(o)}>Edit</button>
                    <button className="btn-ghost !min-h-[36px]" onClick={() => setOpen(open === o.id ? null : o.id)}>Users</button>
                    {o.status === "suspended" ? <button className="btn-ghost !min-h-[36px]" onClick={() => setStatus(o, "active")}>Reactivate</button> : <button className="btn-danger !min-h-[36px]" onClick={() => setStatus(o, "suspended")}>Suspend</button>}
                  </div>
                </div>
                {open === o.id && <FirmUsers orgId={o.id} onMsg={setMsg} />}
              </li>
            );
          })}
          {shown.length === 0 && <li className="card text-slate-600">No firm matches.</li>}
        </ul>
      </section>

      <EditFirm org={edit} onClose={() => setEdit(null)} onSaved={(o) => { setEdit(null); setOrgs((l) => l.map((x) => (x.id === o.id ? { ...x, ...o } : x))); setMsg({ k: "ok", t: `${o.display_name} updated.` }); }} />
    </div>
  );
}

/** Change a firm's details (the legal and display name, contact, referral and the service dates). */
function EditFirm({ org, onClose, onSaved }: { org: Org | null; onClose: () => void; onSaved: (o: Org) => void }) {
  const [v, setV] = useState({ legal: "", display: "", mobile: "", email: "", referral: "", gstin: "", pan: "", activation: "", until: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!org) return;
    setErr(null);
    setV({ legal: org.legal_name, display: org.display_name, mobile: org.contact_mobile ?? "", email: org.contact_email ?? "", referral: org.referral ?? "", gstin: org.gstin ?? "", pan: org.pan ?? "", activation: org.activation_date, until: org.service_until });
  }, [org]);
  if (!org) return null;
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value });

  async function save() {
    if (!org) return;
    const m = v.mobile.trim() ? checkMobile(v.mobile) : null;
    if (m && !m.ok) return setErr(m.message);
    if (v.email.trim() && !EMAIL.test(v.email.trim())) return setErr("Enter a valid email address or leave it empty.");
    const gp = taxProblem(v.gstin, v.pan);
    if (gp) return setErr(gp);
    if (v.until <= v.activation) return setErr("The valid-till date must be after the activation date.");
    setBusy(true); setErr(null);
    const { data, error } = await supabase().rpc("platform_update_org", {
      p_org: org.id, p_legal: v.legal, p_display: v.display, p_mobile: (m && m.ok ? m.value : "") as string, p_email: v.email, p_referral: v.referral, p_gstin: taxValues(v.gstin, v.pan).gstin, p_pan: taxValues(v.gstin, v.pan).pan,
      p_activation: v.activation as unknown as string, p_until: v.until as unknown as string,
    });
    setBusy(false);
    if (error) return setErr("Could not save. Check the dates and the details.");
    onSaved({ ...org, ...(data as unknown as Partial<Org>) });
  }
  return (
    <Modal open={!!org} onClose={onClose} title={`Edit ${org.display_name}`}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <div><label className="label" htmlFor="e1">Legal name</label><input id="e1" className="field" value={v.legal} onChange={set("legal")} /></div>
        <div><label className="label" htmlFor="e2">Display name</label><input id="e2" className="field" value={v.display} onChange={set("display")} /></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label" htmlFor="e3">Mobile (optional)</label><input id="e3" className="field" inputMode="tel" maxLength={14} value={v.mobile} onChange={(e) => setV({ ...v, mobile: e.target.value.replace(/[^0-9+\s-]/g, "") })} /></div>
          <div><label className="label" htmlFor="e4">Email (optional)</label><input id="e4" type="email" className="field" autoCapitalize="none" value={v.email} onChange={set("email")} /></div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label" htmlFor="e8">GSTIN</label><input id="e8" className={`field uppercase ${v.gstin && !checkGstin(v.gstin).ok ? "!border-red-500" : ""}`} maxLength={15} autoCapitalize="characters" value={v.gstin} onChange={(e) => setV({ ...v, gstin: e.target.value.replace(/\s/g, "").toUpperCase() })} /></div>
          <div><label className="label" htmlFor="e9">PAN</label><input id="e9" className={`field uppercase ${v.pan && !checkPan(v.pan).ok ? "!border-red-500" : ""}`} maxLength={10} autoCapitalize="characters" value={v.pan} onChange={(e) => setV({ ...v, pan: e.target.value.replace(/\s/g, "").toUpperCase() })} /></div>
        </div>
        <div><label className="label" htmlFor="e5">Referral</label><input id="e5" className="field" maxLength={120} value={v.referral} onChange={set("referral")} /></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label" htmlFor="e6">Activation date</label><input id="e6" type="date" className="field" value={v.activation} onChange={set("activation")} /></div>
          <div><label className="label" htmlFor="e7">Valid till (service stops this day)</label><input id="e7" type="date" className="field" value={v.until} onChange={set("until")} /></div>
        </div>
        <p className="text-xs text-slate-600">To renew, use the “+1 year” button on the firm instead: it keeps the same anniversary date.</p>
        <button className="btn-primary w-full" disabled={busy || !v.display.trim()} onClick={() => void save()}>{busy ? "Saving…" : "Save changes"}</button>
      </div>
    </Modal>
  );
}

interface Member { user_id: string; login_id: string; full_name: string; role: string; status: string }

/** Platform admin: set any user's password / login ID (the only way credentials change). The list comes straight from the database: one fast call. */
function FirmUsers({ orgId, onMsg }: { orgId: string; onMsg: (m: Msg) => void }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const load = useCallback(async () => {
    const { data } = await supabase().rpc("platform_list_members", { p_org: orgId });
    setMembers((data ?? []) as unknown as Member[]);
  }, [orgId]);
  useEffect(() => { void load(); }, [load]);

  async function act(user_id: string, kind: "set_password" | "set_login") {
    const body: Record<string, unknown> = { organization_id: orgId, user_id, kind };
    if (kind === "set_password") { const p = prompt("New password (min 10 characters, letters and numbers):"); if (!p) return; body.password = p; }
    else { const l = prompt("New login ID (lowercase letters, digits, . _ -):"); if (!l) return; body.login_id = l.trim().toLowerCase(); }
    const res = await fetch("/api/v1/users/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    onMsg(res.ok ? { k: "ok", t: kind === "set_password" ? "Password set." : "Login ID changed." } : { k: "error", t: j?.error?.message ?? "Failed." });
    void load();
  }
  if (!members) return <div className="mt-3 space-y-2 border-t border-slate-100 pt-3" aria-busy="true"><div className="skeleton h-5 w-2/3" /><div className="skeleton h-5 w-1/2" /></div>;
  return (
    <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-100 text-sm">
      {members.map((m) => (
        <li key={m.user_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span><b>{m.full_name || m.login_id}</b> <span className="text-slate-600">({m.login_id}) · {m.role}{m.status === "disabled" ? " · disabled" : ""}</span></span>
          <span className="flex gap-2">
            <button className="btn-ghost !min-h-[36px]" onClick={() => void act(m.user_id, "set_login")}>Change login ID</button>
            <button className="btn-ghost !min-h-[36px]" onClick={() => void act(m.user_id, "set_password")}>Set password</button>
          </span>
        </li>
      ))}
    </ul>
  );
}
