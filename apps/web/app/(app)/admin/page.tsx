"use client";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { fmtDateTime } from "@/lib/format";
import { Alert, PageHead } from "@/components/ui";

interface Org { id: string; display_name: string; legal_name: string; slug: string; status: string; created_at: string; suspension_reason: string | null }

const blank = { legal_name: "", display_name: "", slug: "", owner_login_id: "", owner_name: "", owner_temp_password: "", site_name: "Main", site_code: "MAIN" };

export default function AdminPage() {
  const { me } = useApp();
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [f, setF] = useState(blank);
  const [msg, setMsg] = useState<{ k: "ok" | "error"; t: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase().from("organizations").select("id,display_name,legal_name,slug,status,created_at,suspension_reason").order("created_at", { ascending: false });
    setOrgs((data ?? []) as Org[]);
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!me.is_platform_admin) return <Alert kind="warn">Platform administrators only.</Alert>;

  async function post(url: string, body: unknown) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok, message: j?.error?.message as string | undefined };
  }
  async function create() {
    setBusy(true); setMsg(null);
    const r = await post("/api/v1/admin/organizations", f);
    setBusy(false);
    if (!r.ok) return setMsg({ k: "error", t: r.message ?? "Could not create the firm." });
    setMsg({ k: "ok", t: `Created "${f.display_name}". Give the owner their login ID and password. Only the platform administrator can change the owner's credentials.` });
    setF(blank); void load();
  }
  async function setStatus(o: Org, status: string) {
    let reason: string | undefined;
    if (status === "suspended") { reason = prompt(`Reason for suspending ${o.display_name}:`) ?? ""; if (!reason) return; }
    const r = await post("/api/v1/admin/organizations/status", { organization_id: o.id, status, reason });
    setMsg(r.ok ? { k: "ok", t: `${o.display_name} is now ${status}.` } : { k: "error", t: r.message ?? "Failed." });
    void load();
  }
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <div className="space-y-5">
      <PageHead title="Platform admin" sub="Client firms (tenants). Each firm's data is fully separate." />
      {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
      <section className="card space-y-3">
        <h2 className="font-bold text-navy">Create a client firm</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label" htmlFor="a1">Legal name</label><input id="a1" className="field" value={f.legal_name} onChange={set("legal_name")} /></div>
          <div><label className="label" htmlFor="a2">Display name</label><input id="a2" className="field" value={f.display_name} onChange={set("display_name")} /></div>
          <div><label className="label" htmlFor="a3">Short ID (slug)</label><input id="a3" className="field" autoCapitalize="none" value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase() })} placeholder="acme-traders" /></div>
          <div><label className="label" htmlFor="a4">First site name</label><input id="a4" className="field" value={f.site_name} onChange={set("site_name")} /></div>
          <div><label className="label" htmlFor="a5">First site code</label><input id="a5" className="field uppercase" value={f.site_code} onChange={set("site_code")} /></div>
          <div className="hidden sm:block" />
          <div><label className="label" htmlFor="a6">Owner login ID</label><input id="a6" className="field" autoCapitalize="none" value={f.owner_login_id} onChange={(e) => setF({ ...f, owner_login_id: e.target.value.toLowerCase() })} /></div>
          <div><label className="label" htmlFor="a7">Owner name</label><input id="a7" className="field" value={f.owner_name} onChange={set("owner_name")} /></div>
          <div><label className="label" htmlFor="a8">Owner password</label><input id="a8" className="field" autoComplete="off" value={f.owner_temp_password} onChange={set("owner_temp_password")} /></div>
        </div>
        <p className="text-xs text-slate-600">You set the owner's password; the owner cannot change it. Passwords are never shown again.</p>
        <button className="btn-primary" disabled={busy || !f.display_name || !f.slug || !f.owner_login_id || f.owner_temp_password.length < 10} onClick={create}>{busy ? "Creating…" : "Create firm"}</button>
      </section>

      <section>
        <h2 className="mb-2 font-bold text-navy">Client firms ({orgs.length})</h2>
        <ul className="space-y-2">
          {orgs.map((o) => (
            <li key={o.id} className="card"><div className="flex flex-wrap items-center justify-between gap-2">
              <div><p className="font-semibold text-navy">{o.display_name} <span className="text-sm font-normal text-slate-600">· {o.slug}</span></p>
                <p className="text-xs text-slate-600">{o.legal_name} · created {fmtDateTime(o.created_at)}{o.suspension_reason ? ` · suspended: ${o.suspension_reason}` : ""}</p></div>
              <div className="flex items-center gap-2">
                <span className={`badge ${o.status === "active" ? "bg-green-100 text-green-800" : o.status === "suspended" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-900"}`}>{o.status}</span>
                <button className="btn-ghost !min-h-[36px]" onClick={() => setOpen(open === o.id ? null : o.id)}>Users</button>
                {o.status === "suspended" ? <button className="btn-ghost !min-h-[36px]" onClick={() => setStatus(o, "active")}>Reactivate</button> : <button className="btn-danger !min-h-[36px]" onClick={() => setStatus(o, "suspended")}>Suspend</button>}
              </div></div>
              {open === o.id && <FirmUsers orgId={o.id} onMsg={setMsg} />}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

interface Member { user_id: string; login_id: string; full_name: string; role: string; status: string }

/** Platform admin: set any user's password / login ID (the only way credentials change). */
function FirmUsers({ orgId, onMsg }: { orgId: string; onMsg: (m: { k: "ok" | "error"; t: string }) => void }) {
  const [members, setMembers] = useState<Member[]>([]);
  const load = useCallback(async () => {
    const res = await fetch(`/api/v1/admin/organizations/members?organization_id=${orgId}`);
    const j = await res.json().catch(() => null);
    setMembers(res.ok ? (j.data as Member[]) : []);
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
  return (
    <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-100 text-sm">
      {members.map((m) => (
        <li key={m.user_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span><b>{m.full_name || m.login_id}</b> <span className="text-slate-600">({m.login_id}) · {m.role}{m.status === "disabled" ? " · disabled" : ""}</span></span>
          <span className="flex gap-2">
            <button className="btn-ghost !min-h-[36px]" onClick={() => act(m.user_id, "set_login")}>Change login ID</button>
            <button className="btn-ghost !min-h-[36px]" onClick={() => act(m.user_id, "set_password")}>Set password</button>
          </span>
        </li>
      ))}
    </ul>
  );
}
