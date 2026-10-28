"use client";
import { Select } from "@/components/ios";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { friendlyError } from "@/lib/errors";
import { fmtDateTime, num } from "@/lib/format";
import { formatInvoiceNumber } from "@dk/domain";
import { Alert, PageHead } from "@/components/ui";
import { TicketPreview, previewValues, useReceipt } from "@/components/receipt";
import { PrinterModelPicker } from "@/components/printer-model";
import { AgentRequests } from "@/components/agent-requests";
import { environmentFor, getModel, isPdfPrinter, isVirtualPrinter, matchPrinterModel } from "@dk/print-template";
import { usePcCheck } from "@/lib/pc-check";

export default function SettingsPage() {
  const { can } = useApp();
  return (
    <div className="space-y-5">
      <PageHead title="Settings" sub="One-time setup for billing, invoice numbers, printers and users." />
      {can("ticket.image") && <TicketImageCard />}
      {can("pricing.manage") && <UnitCard />}
      {can("series.manage") && <SeriesCard />}
      {can("template.manage") && (
        <section className="card">
          <h2 className="font-bold text-navy">Receipt layout</h2>
          <p className="mb-3 text-sm text-slate-600">Decide the invoice print area, field positions and text sizes. Import your Excel ticket template.</p>
          <Link href="/settings/template" className="btn-navy">Open layout designer</Link>
        </section>
      )}
      {can("print.route.manage") ? <PrintingCard /> : (
        <>
          {/* a new printer PC needs a firm user's approval too (plus the platform admin's) */}
          <AgentRequests />
          {can("agent.remove") && <PairedPcsCard />}
        </>
      )}
      {can("user.manage") ? <UsersCard /> : <section className="card"><h2 className="font-bold text-navy">Users</h2><p className="text-sm text-slate-600">Users, logins and passwords are created and managed only by the platform administrator (The Valuation House). Contact them to add an operator or change a password.</p></section>}
    </div>
  );
}

function UnitCard() {
  const { org, settings, refresh } = useApp();
  const [unit, setUnit] = useState<"kg" | "tonne" | "">(settings.weight_unit ?? "");
  const [msg, setMsg] = useState<{ k: "ok" | "error"; t: string } | null>(null);
  useEffect(() => setUnit(settings.weight_unit ?? ""), [settings.weight_unit]);
  async function save() {
    if (!org || !unit) return;
    const { error } = await supabase().rpc("set_weight_unit", { p_org: org.organization_id, p_unit: unit });
    if (error) return setMsg({ k: "error", t: friendlyError(error) });
    setMsg({ k: "ok", t: "Saved." });
    await refresh();
  }
  return (
    <section className="card space-y-3">
      <h2 className="font-bold text-navy">Billing weight unit</h2>
      <p className="text-sm text-slate-600">Choose once. On every invoice the operator then enters the price per {unit || "kg / tonne"} and the total is calculated from the net weight. It cannot change after the first invoice.</p>
      {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
      <div className="grid max-w-sm grid-cols-2 gap-2">
        {(["kg", "tonne"] as const).map((u) => (
          <label key={u} className={`flex min-h-[44px] cursor-pointer items-center justify-center rounded-lg border text-sm font-semibold ${unit === u ? "border-brand bg-brand-50 text-brand-dark" : "border-slate-300"}`}>
            <input type="radio" name="unit" className="sr-only" checked={unit === u} onChange={() => setUnit(u)} />{u === "kg" ? "Kilogram (kg)" : "Tonne (t)"}
          </label>
        ))}
      </div>
      <button className="btn-primary" disabled={!unit || unit === settings.weight_unit} onClick={save}>Save unit</button>
    </section>
  );
}

interface Series { id: string; site_id: string | null; prefix: string; start_number: number; next_number: number; padding_width: number; reset_policy: "none" | "fiscal_year"; period_key: string }

function SeriesCard() {
  const { org, sites } = useApp();
  const [site, setSite] = useState<string>("");
  const [existing, setExisting] = useState<Series[]>([]);
  const [prefix, setPrefix] = useState("");
  const [start, setStart] = useState("1");
  const [padding, setPadding] = useState("0");
  const [reset, setReset] = useState<"none" | "fiscal_year">("none");
  const [msg, setMsg] = useState<{ k: "ok" | "error"; t: string } | null>(null);

  const load = useCallback(async () => {
    if (!org) return;
    const { data } = await supabase().from("invoice_series").select("*").eq("organization_id", org.organization_id).eq("period_key", "");
    setExisting((data ?? []) as Series[]);
  }, [org]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const cur = existing.find((s) => (s.site_id ?? "") === site);
    if (cur) { setPrefix(cur.prefix); setStart(String(cur.start_number)); setPadding(String(cur.padding_width)); setReset(cur.reset_policy); }
  }, [site, existing]);

  const cur = existing.find((s) => (s.site_id ?? "") === site);
  const sample = (() => { try { return formatInvoiceNumber(Number(start) || 0, { prefix: prefix.replace("{FY}", "26-27"), padding: Number(padding) || 0 }); } catch { return "—"; } })();

  async function save() {
    if (!org) return;
    const { error } = await supabase().rpc("initialize_invoice_series", {
      p_org: org.organization_id, p_site: (site || null) as unknown as string, p_prefix: prefix, p_start: Number(start), p_padding: Number(padding), p_reset: reset,
    });
    if (error) return setMsg({ k: "error", t: friendlyError(error) });
    setMsg({ k: "ok", t: "Invoice series saved." });
    void load();
  }

  return (
    <section className="card space-y-3">
      <h2 className="font-bold text-navy">Invoice number series</h2>
      <p className="text-sm text-slate-600">Set the starting number once. The system continues from it automatically; numbers are never reused, even for cancelled invoices. Use <code>{"{FY}"}</code> in the prefix for the financial year (e.g. <code>VNK/{"{FY}"}/</code>).</p>
      {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div><label className="label" htmlFor="ss">Applies to</label><Select id="ss" className="field" value={site} onChange={(e) => setSite(e.target.value)}><option value="">All sites (one series)</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.name} only</option>)}</Select></div>
        <div><label className="label" htmlFor="sp">Prefix (optional)</label><input id="sp" className="field" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="VNK/{FY}/" /></div>
        <div><label className="label" htmlFor="sn">Starting number</label><input id="sn" className="field" inputMode="numeric" value={start} onChange={(e) => setStart(e.target.value.replace(/\D/g, ""))} /></div>
        <div><label className="label" htmlFor="sw">Zero-padding width</label><input id="sw" className="field" inputMode="numeric" value={padding} onChange={(e) => setPadding(e.target.value.replace(/\D/g, ""))} /></div>
        <div><label className="label" htmlFor="sr">Restart numbering</label><Select id="sr" className="field" value={reset} onChange={(e) => setReset(e.target.value as "none" | "fiscal_year")}><option value="none">Never</option><option value="fiscal_year">Every financial year (April)</option></Select></div>
      </div>
      <p className="text-sm">First invoice will look like: <b className="text-navy">{sample}</b>{cur && <span className="text-slate-600"> · next to be issued: {cur.next_number}</span>}</p>
      <button className="btn-primary" onClick={save}>{cur ? "Update series" : "Save series"}</button>
    </section>
  );
}

interface AgentRow { id: string; site_id: string; label: string; status: string; approval?: string; app_version: string | null; os: string | null; printers_seen: { name: string; status?: string }[] | null; last_heartbeat_at: string | null; scale?: AgentScale | null }
interface AgentScale { enabled?: boolean; port?: string | null; protocol?: string | null; link?: string; state?: string; error?: string | null }
interface PrinterRow { id: string; agent_id: string; label: string; os_printer_name: string; paper_w_mm: string; paper_h_mm: string; offset_x_mm: string; offset_y_mm: string; active: boolean; model_key: string | null }
interface DestinationRow { printer_id: string; origin_site_id: string; is_default: boolean; active: boolean }
interface RemovedAgentRow { id: string; label: string; revoked_at: string | null }

function PrintingCard() {
  const { org, sites } = useApp();
  const [site, setSite] = useState("");
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [removedAgents, setRemovedAgents] = useState<RemovedAgentRow[]>([]);
  const [printers, setPrinters] = useState<PrinterRow[]>([]);
  const [destinations, setDestinations] = useState<DestinationRow[]>([]);
  const [code, setCode] = useState<{ code: string; expires_at: string; min_version?: string | null } | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ k: "ok" | "error"; t: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { if (!site && sites[0]) setSite(sites[0].id); }, [sites, site]);

  const load = useCallback(async () => {
    if (!org) return;
    const sb = supabase();
    const [a, r, p, d] = await Promise.all([
      sb.from("print_agents").select("id,site_id,label,status,approval,app_version,os,printers_seen,last_heartbeat_at,scale").eq("organization_id", org.organization_id).eq("status", "active"),
      sb.from("print_agents").select("id,label,revoked_at").eq("organization_id", org.organization_id).eq("status", "revoked").order("revoked_at", { ascending: false }),
      sb.from("printer_devices").select("*").eq("organization_id", org.organization_id).eq("active", true),
      sb.from("print_destinations").select("printer_id,origin_site_id,is_default,active").eq("organization_id", org.organization_id).eq("active", true),
    ]);
    setAgents((a.data ?? []) as unknown as AgentRow[]);
    setRemovedAgents((r.data ?? []) as RemovedAgentRow[]);
    setPrinters((p.data ?? []) as PrinterRow[]);
    setDestinations((d.data ?? []) as DestinationRow[]);
    setLoaded(true);
  }, [org]);
  useEffect(() => { void load(); }, [load]);
  useVisibleInterval(load, 20000);
  usePcCheck(org?.organization_id, null, () => void load());

  async function pair() {
    if (!org || !site) return;
    const { data, error } = await supabase().rpc("create_pairing_code", { p_org: org.organization_id, p_site: site });
    if (error) return setMsg({ k: "error", t: friendlyError(error) });
    setCode(data as { code: string; expires_at: string; min_version?: string | null }); setMsg(null);
  }
  async function applyModel(printerId: string, key: string) {
    if (!org) return null;
    const model = getModel(key);
    const env = environmentFor(model);
    return supabase().rpc("set_printer_model", { p_org: org.organization_id, p_printer: printerId, p_model: key, p_floor: env.preferredMinPt, p_font: env.fontFamily });
  }
  async function bind(agent: AgentRow, name: string) {
    if (!org) return;
    const key = pick[`${agent.id}:${name}`] ?? matchPrinterModel(name)?.key ?? "";
    if (!key) return setMsg({ k: "warn" as "error", t: "Choose the printer make & model first. It sets the right environment for this printer." });
    const paper = environmentFor(getModel(key)).defaultPaper;
    const { data, error } = await supabase().rpc("bind_printer", { p_org: org.organization_id, p_agent: agent.id, p_os_name: name, p_label: name, p_w: paper.w, p_h: paper.h, p_set_default_route: true });
    if (error) return setMsg({ k: "error", t: friendlyError(error) });
    const r = await applyModel((data as { id: string }).id, key);
    setMsg(r?.error ? { k: "error", t: friendlyError(r.error) } : { k: "ok", t: `Printer "${name}" is now the default for ${sites.find((s) => s.id === agent.site_id)?.name ?? "the site"}. Environment for ${getModel(key)?.model} applied.` });
    void load();
  }
  async function calibrate(p: PrinterRow, x: string, y: string) {
    if (!org) return;
    const { error } = await supabase().rpc("set_printer_calibration", { p_org: org.organization_id, p_printer: p.id, p_x: Number(x), p_y: Number(y) });
    setMsg(error ? { k: "error", t: friendlyError(error) } : { k: "ok", t: "Calibration saved. It applies to new print jobs." });
    void load();
  }
  async function revoke(a: AgentRow) {
    if (!org || !confirm(`Remove "${a.label}"? It stops printing immediately and must be paired again to print.`)) return;
    const { error } = await supabase().rpc("remove_agent", { p_org: org.organization_id, p_agent: a.id });
    setMsg(error ? { k: "error", t: friendlyError(error) } : { k: "ok", t: "Printer PC removed." });
    void load();
  }

  return (
    <section className="card space-y-4">
      <h2 className="font-bold text-navy">Printing</h2>
      <p className="text-sm text-slate-600">Install the Dharam Kata Print Agent on the Windows PC that has the dot-matrix printer, then pair it here. Invoices print only to the printer assigned to their site — never to whoever has a page open.</p>
      {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
      <div className="flex flex-wrap items-end gap-3">
        <div><label className="label" htmlFor="ps">Site for the new printer PC</label><Select id="ps" className="field" value={site} onChange={(e) => setSite(e.target.value)}>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></div>
        <button className="btn-navy" onClick={pair}>Generate pairing code</button>
      </div>
      {code && <Alert kind="info">Enter this code in the Print Agent within 10 minutes (single use): <b className="select-all text-xl tracking-widest">{code.code}</b>{code.min_version && <span className="mt-1 block text-sm">This firm uses Print Agent <b>{code.min_version}</b> or newer: an older version on a PC is refused. Use the latest setup file.</span>}</Alert>}
      <p className="text-xs text-slate-600">One PC prints per site. If a site already has a PC, the new PC waits here for your approval (the old PC is then removed). Pairing the same PC again simply replaces its old entry.</p>
      <AgentRequests onChange={() => void load()} />

      {!loaded && <div className="skeleton h-20 w-full" aria-busy="true" aria-label="Loading printers" />}
      {loaded && agents.length === 0 && (
        <div className="rounded-lg border border-slate-200 p-4 text-center text-sm text-slate-600">
          <p className="font-semibold text-navy">No printer PC currently active</p>
          <p className="mt-1">Generate a pairing code above to pair a computer running the Print Agent.</p>
        </div>
      )}
      {agents.map((a) => {
        const assignedPrinters = printers.filter((p) => p.agent_id === a.id);
        return (
          <div key={a.id} className="rounded-lg border border-slate-200 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-semibold text-navy">{a.label} <span className="text-sm font-normal text-slate-600">· {sites.find((s) => s.id === a.site_id)?.name}</span></p>
                <p className="text-xs text-slate-600">v{a.app_version ?? "?"} · {a.os ?? ""} · last seen {a.last_heartbeat_at ? fmtDateTime(a.last_heartbeat_at) : "never"}</p>
                <ScaleLine s={a.scale} />
              </div>
              {a.status === "active" && a.approval === "pending" && <span className="badge bg-amber-100 text-amber-900">⏳ Waiting for approval</span>}
              {a.status === "active" ? <button className="btn-danger !min-h-[36px]" onClick={() => revoke(a)}>Remove</button> : <span className="badge bg-slate-100 text-slate-600">– Removed</span>}
            </div>
            {a.status === "active" && a.approval !== "pending" && (
              <div className="mt-3 space-y-2">
                {assignedPrinters.length === 0 && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                    <p className="font-semibold">⚠ No printer paired</p>
                    <p className="mt-0.5 text-xs text-amber-800">This PC is active, but no printer is set as default yet. Choose one of the detected printers below to set as default.</p>
                  </div>
                )}
                {assignedPrinters.map((p) => (
                  <PrinterEditor
                    key={p.id}
                    p={p}
                    isDefault={destinations.some((d) => d.printer_id === p.id && d.is_default)}
                    onSave={calibrate}
                    onModel={async (k) => {
                      const r = await applyModel(p.id, k);
                      setMsg(r?.error ? { k: "error", t: friendlyError(r.error) } : { k: "ok", t: "Environment saved for this printer." });
                      void load();
                    }}
                    status={(a.printers_seen ?? []).find((s) => s.name === p.os_printer_name)?.status}
                  />
                ))}
                {(a.printers_seen ?? []).filter((s) => !isVirtualPrinter(s.name) && !printers.some((p) => p.agent_id === a.id && p.os_printer_name === s.name)).map((s) => {
                  const k = `${a.id}:${s.name}`;
                  return (
                    <div key={s.name} className="space-y-2 rounded-lg border border-dashed border-slate-300 p-3 text-sm">
                      <PrinterModelPicker id={`m-${a.id}-${s.name}`} value={pick[k] ?? matchPrinterModel(s.name)?.key ?? ""} onChange={(v) => setPick({ ...pick, [k]: v })} />
                      {matchPrinterModel(s.name) && !pick[k] && <p className="text-xs text-green-800">✓ Model detected automatically from the Windows printer name.</p>}
                      {isPdfPrinter(s.name) && <p className="text-xs text-amber-900">⚠ This only saves a PDF file on the PC. No paper comes out.</p>}
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>Found: <b>{s.name}</b> {s.status && s.status !== "ready" && <span className="badge bg-amber-100 text-amber-900">⚠ {s.status.replaceAll("_", " ")}</span>}</span>
                        <button className="btn-ghost !min-h-[36px]" onClick={() => bind(a, s.name)}>Set as default for {sites.find((x) => x.id === a.site_id)?.name}</button>
                      </div>
                    </div>
                  );
                })}
                {(!a.printers_seen || a.printers_seen.length === 0) && (
                  <p className="text-xs text-amber-800">No printers detected from this PC yet. Ensure the Print Agent is running on the PC.</p>
                )}
                {(a.printers_seen ?? []).length > 0 && (a.printers_seen ?? []).every((s) => isVirtualPrinter(s.name) || isPdfPrinter(s.name)) && (
                  <Alert kind="warn">No real printer found on this PC (only OneNote, Fax, XPS or PDF). Connect the printer to this PC and install its Windows driver, or use another PC.</Alert>
                )}
              </div>
            )}
          </div>
        );
      })}
      {removedAgents.length > 0 && (
        <details className="mt-3 text-xs text-slate-500">
          <summary className="cursor-pointer font-medium hover:text-slate-700">Removed PCs history ({removedAgents.length})</summary>
          <ul className="mt-2 space-y-1 pl-3 text-slate-600">
            {removedAgents.map((r) => (
              <li key={r.id}>
                • <span className="font-semibold">{r.label}</span> {r.revoked_at ? `— removed ${fmtDateTime(r.revoked_at)}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** Operators: see the paired printer PCs and remove an old one (pairing a new PC is done by the owner / administrator). */
function PairedPcsCard() {
  const { org, sites } = useApp();
  const [agents, setAgents] = useState<{ id: string; site_id: string; label: string; status: string; app_version: string | null; last_heartbeat_at: string | null }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [msg, setMsg] = useState<{ k: "ok" | "error"; t: string } | null>(null);
  const load = useCallback(async () => {
    if (!org) return;
    const { data } = await supabase().from("print_agents").select("id,site_id,label,status,app_version,last_heartbeat_at").eq("organization_id", org.organization_id).eq("status", "active").order("created_at", { ascending: false });
    setAgents((data ?? []) as never); setLoaded(true);
  }, [org]);
  useEffect(() => { void load(); }, [load]);
  async function remove(id: string, label: string) {
    if (!org || !confirm(`Remove "${label}"? It stops printing immediately and must be paired again to print.`)) return;
    const { error } = await supabase().rpc("remove_agent", { p_org: org.organization_id, p_agent: id });
    setMsg(error ? { k: "error", t: friendlyError(error) } : { k: "ok", t: "Printer PC removed." });
    void load();
  }
  return (
    <section className="card space-y-3">
      <h2 className="font-bold text-navy">Paired printer PCs</h2>
      <p className="text-sm text-slate-600">Remove a PC that is old, replaced or no longer used. To pair a new PC, ask your owner or administrator.</p>
      {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
      {!loaded && <div className="skeleton h-16 w-full" aria-busy="true" aria-label="Loading printer PCs" />}
      {loaded && agents.length === 0 && <p className="text-sm text-slate-600">No printer PC is paired.</p>}
      {agents.map((a) => (
        <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3">
          <div className="min-w-0"><p className="break-words font-semibold text-navy">{a.label} <span className="text-sm font-normal text-slate-600">· {sites.find((s) => s.id === a.site_id)?.name}</span></p>
            <p className="text-xs text-slate-600">v{a.app_version ?? "?"} · last seen {a.last_heartbeat_at ? fmtDateTime(a.last_heartbeat_at) : "never"}</p></div>
          <button className="btn-danger !min-h-[40px]" onClick={() => remove(a.id, a.label)}>Remove</button>
        </div>
      ))}
    </section>
  );
}

/** The weighing scale on a printer PC, as the Print Agent last reported it (set up in the Print Agent, on that PC). */
function ScaleLine({ s }: { s?: AgentScale | null }) {
  if (!s?.enabled) return <p className="text-xs text-slate-500">Weighing scale: not set up (optional; set it up in the Print Agent on this PC).</p>;
  const ok = s.link === "open" && !s.error;
  return (
    <p className={`text-xs ${ok ? "text-green-800" : "text-red-700"}`}>
      Weighing scale: {s.port ?? "?"} · {ok ? (s.state === "stable" || s.state === "moving" ? "connected, data arriving" : "connected, no data yet") : s.error ? `problem (${s.error.replaceAll("_", " ")})` : "not connected"}
    </p>
  );
}

function PrinterEditor({ p, isDefault, onSave, onModel, status }: { p: PrinterRow; isDefault?: boolean; onSave: (p: PrinterRow, x: string, y: string) => void; onModel: (key: string) => void; status?: string }) {
  const [model, setModel] = useState(p.model_key ?? matchPrinterModel(p.os_printer_name)?.key ?? "");
  const [x, setX] = useState(String(Number(p.offset_x_mm)));
  const [y, setY] = useState(String(Number(p.offset_y_mm)));
  return (
    <div className="rounded-lg bg-slate-50 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2 font-semibold">
        <span>🖨 {p.os_printer_name}</span>
        {isDefault ? <span className="badge bg-green-100 text-green-800">✓ Default for this site</span> : null}
        <span className="font-normal text-slate-600">· paper {num(p.paper_w_mm, 1)}×{num(p.paper_h_mm, 1)} mm</span>
        {status && (status === "ready" ? <span className="badge bg-green-100 text-green-800">✓ Ready</span> : <span className="badge bg-amber-100 text-amber-900">⚠ {status.replaceAll("_", " ")}</span>)}
      </div>
      {isVirtualPrinter(p.os_printer_name) && <p className="mt-1 text-sm font-medium text-red-700">✕ “{p.os_printer_name}” is not a physical printer. No paper comes out. Choose a physical printer for this site.</p>}
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <div><label className="label" htmlFor={`x${p.id}`}>X offset (mm)</label><input id={`x${p.id}`} className="field !w-28" inputMode="decimal" value={x} onChange={(e) => setX(e.target.value)} /></div>
        <div><label className="label" htmlFor={`y${p.id}`}>Y offset (mm)</label><input id={`y${p.id}`} className="field !w-28" inputMode="decimal" value={y} onChange={(e) => setY(e.target.value)} /></div>
        <button className="btn-ghost" onClick={() => onSave(p, x, y)}>Save calibration</button>
      </div>
      <p className="mt-1 text-xs text-slate-600">Print the calibration sheet from the Print Agent, lay it over the real ticket, then nudge X/Y here.</p>
      <div className="mt-3 border-t border-slate-200 pt-3"><PrinterModelPicker id={`bm-${p.id}`} value={model} onChange={setModel} />
        <button className="btn-ghost mt-2" disabled={!model || model === p.model_key} onClick={() => onModel(model)}>Apply environment</button></div>
    </div>
  );
}

function TicketImageCard() {
  const { org } = useApp();
  const receipt = useReceipt();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ k: "ok" | "error"; t: string } | null>(null);

  async function upload(file: File) {
    if (!org) return;
    setBusy(true); setMsg(null);
    const fd = new FormData();
    fd.set("file", file); fd.set("organization_id", org.organization_id);
    const res = await fetch("/api/v1/templates/preview-image", { method: "POST", body: fd });
    const j = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) return setMsg({ k: "error", t: j?.error?.message ?? "Upload failed." });
    const d = j.data as { bytes_original: number; bytes_optimized: number; width: number; height: number };
    setMsg({ k: "ok", t: `Ticket image saved (${d.width}×${d.height}px, optimised from ${Math.round(d.bytes_original / 1024)} KB to ${Math.round(d.bytes_optimized / 1024)} KB).` });
    receipt.reload();
  }
  const sample = previewValues({ serial: "22242", vehicle: "RJ14GD9158", material: "MRKU3564630", party: "GANPATI PLAS", gross: 34210, grossAt: "2026-07-29T09:46:00Z", tare: 15105, tareAt: "2026-07-28T06:10:00Z", net: 19105, charge: 350 });
  return (
    <section className="card space-y-3">
      <h2 className="font-bold text-navy">Ticket design (preview)</h2>
      <p className="text-sm text-slate-600">Upload a clear photo or scan of your pre-printed ticket <b>once</b>. It is used only to preview how each invoice will look. The ticket’s header, logo and footer are already on your paper, so <b>only the typed values are sent to the printer</b>. You can replace the image here at any time.</p>
      {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
      <TicketPreview config={receipt} values={sample} caption="Sample values on your ticket." />
      <label className={`btn-navy cursor-pointer ${busy ? "opacity-60" : ""}`}>{busy ? "Uploading…" : receipt.imageUrl ? "Replace ticket image" : "Upload ticket image"}
        <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
      </label>
      <p className="text-xs text-slate-600">PNG, JPEG or WebP, up to 8 MB. Large photos are automatically resized and compressed.</p>
    </section>
  );
}

interface UserDevices { user_id: string; role: string; login_id: string | null; full_name: string | null; devices: { name: string; since: string; last_active: string }[] }

/** Owner / administrator: who is signed in where (at most 2 devices per user) and "Sign out of all devices" for theft or emergency. */
function UsersCard() {
  const { org } = useApp();
  const [users, setUsers] = useState<UserDevices[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ k: "ok" | "error"; t: string } | null>(null);
  const load = useCallback(async () => {
    if (!org) return;
    const { data, error } = await supabase().rpc("list_user_devices", { p_org: org.organization_id });
    if (error) { setMsg({ k: "error", t: friendlyError(error) }); setUsers([]); return; }
    setUsers((data ?? []) as UserDevices[]);
  }, [org]);
  useEffect(() => { void load(); }, [load]);

  async function signOutAll(u: UserDevices) {
    if (!org) return;
    const who = u.full_name || u.login_id || "this user";
    if (!confirm(`Sign out ${who} on ALL devices? Use this if a phone or PC was lost or stolen. ${who} can then log in again on up to 2 devices.`)) return;
    setBusy(u.user_id); setMsg(null);
    const { error } = await supabase().rpc("sign_out_all_devices", { p_org: org.organization_id, p_user: u.user_id });
    setBusy(null);
    setMsg(error ? { k: "error", t: friendlyError(error) } : { k: "ok", t: `${who} is signed out on all devices (within a few minutes on devices that are open now) and can log in again on up to 2 devices.` });
    void load();
  }

  return (
    <section className="card space-y-3">
      <h2 className="font-bold text-navy">Users and devices</h2>
      <p className="text-sm text-slate-600">Each user can be logged in on at most 2 devices. A 3rd device is refused until the user logs out on one of them. If a device is lost or stolen, use <b>Sign out of all devices</b>.</p>
      {msg && <Alert kind={msg.k}>{msg.t}</Alert>}
      {!users && <div className="skeleton h-16 w-full" aria-busy="true" aria-label="Loading users" />}
      {users?.map((u) => (
        <div key={u.user_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 text-sm">
          <div className="min-w-0">
            <p className="break-words font-semibold text-navy">{u.full_name || u.login_id} <span className="font-normal text-slate-600">· {u.login_id} · {u.role}</span></p>
            <p className="text-xs text-slate-600">
              {u.devices.length === 0 ? "Not logged in on any device" : `Logged in on ${u.devices.length} of 2: ${u.devices.map((d) => `${d.name} (since ${fmtDateTime(d.since)})`).join(", ")}`}
            </p>
          </div>
          {u.devices.length > 0 && <button type="button" className="btn-danger !min-h-[40px]" disabled={busy === u.user_id} onClick={() => void signOutAll(u)}>{busy === u.user_id ? "Signing out…" : "Sign out of all devices"}</button>}
        </div>
      ))}
      <p className="text-xs text-slate-600">New users and password changes are handled by the platform administrator (The Valuation House).</p>
    </section>
  );
}
