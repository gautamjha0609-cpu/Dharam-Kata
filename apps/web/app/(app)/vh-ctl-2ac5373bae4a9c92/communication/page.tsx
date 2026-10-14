"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { ADMIN_PATH } from "@/lib/admin-path";
import { fmtDateTime } from "@/lib/format";
import { Alert, PageHead } from "@/components/ui";

interface Firm { id: string; display_name: string; slug: string }
interface Msg { id: string; message: string; created_at: string; starts_at: string; expires_at: string; show_count: number; target_all: boolean; stopped_at: string | null }
type Status = "scheduled" | "live" | "ended" | "stopped";

const statusOf = (m: Msg, now = Date.now()): Status => (m.stopped_at ? "stopped" : now < new Date(m.starts_at).getTime() ? "scheduled" : now >= new Date(m.expires_at).getTime() ? "ended" : "live");
/** <input type="datetime-local"> value for an instant, in India time. */
const local = (d: Date) => new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 16);
const toIso = (v: string) => new Date(`${v}:00+05:30`).toISOString();

export default function CommunicationPage() {
  const { me } = useApp();
  const [firms, setFirms] = useState<Firm[]>([]);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [targets, setTargets] = useState<Record<string, string[]>>({});
  const [note, setNote] = useState<{ k: "ok" | "error"; t: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState(() => ({ text: "", start: local(new Date()), end: local(new Date(Date.now() + 7 * 86_400_000)), count: "2", all: true, picked: new Set<string>(), q: "" }));

  const load = useCallback(async () => {
    const sb = supabase();
    const [o, b, t] = await Promise.all([
      sb.from("organizations").select("id,display_name,slug").order("display_name"),
      sb.from("broadcasts").select("id,message,created_at,starts_at,expires_at,show_count,target_all,stopped_at").order("created_at", { ascending: false }).limit(200),
      sb.from("broadcast_targets").select("broadcast_id,organization_id"),
    ]);
    setFirms((o.data ?? []) as Firm[]);
    setMsgs((b.data ?? []) as Msg[]);
    const map: Record<string, string[]> = {};
    for (const r of (t.data ?? []) as { broadcast_id: string; organization_id: string }[]) (map[r.broadcast_id] ??= []).push(r.organization_id);
    setTargets(map);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const name = useMemo(() => new Map(firms.map((x) => [x.id, x.display_name])), [firms]);
  const now = Date.now();
  const active = msgs.filter((m) => ["live", "scheduled"].includes(statusOf(m, now)));
  const history = msgs.filter((m) => ["ended", "stopped"].includes(statusOf(m, now)));
  const shownFirms = firms.filter((x) => !f.q.trim() || `${x.display_name} ${x.slug}`.toLowerCase().includes(f.q.trim().toLowerCase()));

  if (!me.is_platform_admin) return <Alert kind="warn">Platform administrators only.</Alert>;

  const toggle = (id: string) => setF((s) => { const p = new Set(s.picked); if (p.has(id)) p.delete(id); else p.add(id); return { ...s, picked: p }; });
  const bad = !f.text.trim() ? "Write the message." : !f.start || !f.end || toIso(f.end) <= toIso(f.start) ? "The end must be after the start." : !f.all && f.picked.size === 0 ? "Choose at least one firm, or select “All firms”." : null;

  async function send() {
    if (bad) return setNote({ k: "error", t: bad });
    setBusy(true); setNote(null);
    const { error } = await supabase().rpc("platform_send_broadcast", {
      p_message: f.text, p_starts: toIso(f.start), p_ends: toIso(f.end), p_show_count: Number(f.count),
      p_org_ids: (f.all ? [] : [...f.picked]) as unknown as string[],
    });
    setBusy(false);
    if (error) return setNote({ k: "error", t: "Could not save the message. Check the dates and the firms." });
    setNote({ k: "ok", t: toIso(f.start) > new Date().toISOString() ? "Scheduled. It will appear to the users from the start time." : "Sent. Users see it the next time they open the app." });
    setF((s) => ({ ...s, text: "", picked: new Set(), all: true }));
    void load();
  }
  async function stop(m: Msg) {
    if (!confirm("Stop this message now? Users will not see it any more.")) return;
    await supabase().rpc("platform_stop_broadcast", { p_id: m.id });
    setNote({ k: "ok", t: "Stopped. It moved to the history." });
    void load();
  }
  const to = (m: Msg) => (m.target_all ? "All firms" : (targets[m.id] ?? []).map((id) => name.get(id) ?? "—").join(", ") || "—");

  const Row = ({ m }: { m: Msg }) => {
    const s = statusOf(m, now);
    return (
      <li className="py-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="min-w-0 flex-1 text-sm text-navy">{m.message}</p>
          <span className="flex items-center gap-2">
            <span className={`badge ${s === "live" ? "bg-green-100 text-green-800" : s === "scheduled" ? "bg-sky-100 text-sky-800" : s === "stopped" ? "bg-red-100 text-red-800" : "bg-slate-100 text-slate-600"}`}>
              {s === "live" ? "● Live" : s === "scheduled" ? "Scheduled" : s === "stopped" ? "Stopped" : "Ended"}
            </span>
            {(s === "live" || s === "scheduled") && <button className="btn-danger !min-h-[32px]" onClick={() => void stop(m)}>Stop</button>}
          </span>
        </div>
        <p className="mt-1 text-xs text-slate-600">
          To: <b>{to(m)}</b> · {fmtDateTime(m.starts_at)} → {fmtDateTime(m.expires_at)} · shown up to {m.show_count} time{m.show_count === 1 ? "" : "s"} per user
          {m.stopped_at ? ` · stopped ${fmtDateTime(m.stopped_at)}` : ""}
        </p>
      </li>
    );
  };

  return (
    <div className="space-y-5">
      <PageHead title="Communication" sub="Messages that pop up for the users of your client firms."
        actions={<Link href={ADMIN_PATH} className="btn-ghost">← Firms</Link>} />
      {note && <Alert kind={note.k}>{note.t}</Alert>}

      <section className="card space-y-4">
        <h2 className="font-bold text-navy">New message</h2>
        <div>
          <label className="label" htmlFor="cm">Message</label>
          <textarea id="cm" className="field !min-h-[96px] py-2" rows={3} maxLength={500} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} placeholder="e.g. Server maintenance on Sunday 11 PM to 11:30 PM. Please finish your entries before that." />
          <p className="mt-1 text-right text-xs text-slate-500">{f.text.length}/500</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div><label className="label" htmlFor="cs">Start (India time)</label><input id="cs" type="datetime-local" className="field" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></div>
          <div><label className="label" htmlFor="ce">End (India time)</label><input id="ce" type="datetime-local" className="field" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></div>
          <div><label className="label" htmlFor="cc">Pop-ups per user</label>
            <input id="cc" type="number" min={1} max={20} className="field" value={f.count} onChange={(e) => setF({ ...f, count: String(Math.max(1, Math.min(20, Number(e.target.value) || 1))) })} />
            <p className="mt-1 text-xs text-slate-500">Each user sees it this many times (10 seconds each).</p></div>
        </div>

        <fieldset>
          <legend className="label">Who gets it</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {([[true, "All firms", "Every firm, now and the ones added later while the message is live."], [false, "Selected firms", "Only the firms you tick below (one or many)."]] as [boolean, string, string][]).map(([v, t, d]) => (
              <button key={t} type="button" role="radio" aria-checked={f.all === v} onClick={() => setF({ ...f, all: v })}
                className={`rounded-lg border p-3 text-left ${f.all === v ? "border-brand bg-brand-50" : "border-slate-300 bg-white hover:bg-slate-50"}`}>
                <span className="font-semibold text-navy">{t}</span><span className="block text-sm text-slate-600">{d}</span>
              </button>
            ))}
          </div>
          {!f.all && (
            <div className="mt-3 rounded-lg border border-slate-200 p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <input className="field !min-h-[40px] flex-1" type="search" placeholder="Search firms…" aria-label="Search firms" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
                <button type="button" className="btn-ghost !min-h-[40px]" onClick={() => setF((s) => ({ ...s, picked: new Set([...s.picked, ...shownFirms.map((x) => x.id)]) }))}>Tick all shown</button>
                <button type="button" className="btn-ghost !min-h-[40px]" onClick={() => setF((s) => ({ ...s, picked: new Set() }))}>Clear</button>
              </div>
              <ul className="grid max-h-64 gap-1 overflow-auto sm:grid-cols-2">
                {shownFirms.map((x) => (
                  <li key={x.id}>
                    <label className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm ${f.picked.has(x.id) ? "border-brand bg-brand-50" : "border-slate-200"}`}>
                      <input type="checkbox" className="h-5 w-5" checked={f.picked.has(x.id)} onChange={() => toggle(x.id)} />
                      <span className="truncate"><b className="text-navy">{x.display_name}</b> <span className="text-slate-500">· {x.slug}</span></span>
                    </label>
                  </li>
                ))}
                {shownFirms.length === 0 && <li className="text-sm text-slate-600">No firm matches.</li>}
              </ul>
              <p className="mt-2 text-xs text-slate-600">{f.picked.size} firm{f.picked.size === 1 ? "" : "s"} selected</p>
            </div>
          )}
        </fieldset>
        <button className="btn-primary" disabled={busy || !!bad} onClick={() => void send()}>{busy ? "Saving…" : "Send / schedule"}</button>
      </section>

      <section className="card">
        <h2 className="font-bold text-navy">Live and scheduled ({active.length})</h2>
        {active.length === 0 ? <p className="mt-1 text-sm text-slate-600">Nothing is live right now.</p> : <ul className="divide-y divide-slate-100">{active.map((m) => <Row key={m.id} m={m} />)}</ul>}
      </section>

      <section className="card">
        <h2 className="font-bold text-navy">History ({history.length})</h2>
        <p className="text-sm text-slate-600">Messages move here when their end time passes or when you stop them.</p>
        {history.length === 0 ? <p className="mt-1 text-sm text-slate-600">No past messages yet.</p> : <ul className="divide-y divide-slate-100">{history.map((m) => <Row key={m.id} m={m} />)}</ul>}
      </section>
    </div>
  );
}
