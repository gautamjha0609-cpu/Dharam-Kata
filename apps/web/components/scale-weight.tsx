"use client";
// "Detect weight": reads the weight from the weighbridge indicator connected to this site's printer PC.
// Nothing is read until the operator taps the button; then the server asks that PC, the PC answers with the STEADY weight,
// and the reading is shown here. Saving the entry with it lets the server check that exactly this weight is saved.
import { useCallback, useEffect, useRef, useState } from "react";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { friendlyError } from "@/lib/errors";

const SCALE_ERRORS: Record<string, string> = {
  unstable: "The weight is not steady. Wait until the vehicle stops moving, then tap Detect weight again.",
  no_data: "No weight is coming from the scale. Check that the indicator is on and its cable is connected to the printer PC.",
  connecting: "The printer PC is still connecting to the scale. Tap Detect weight again in a few seconds.",
  overload: "The scale shows overload or an error.",
  bad_unit: "The scale sends a unit that is not kg or tonne. Set the indicator to kg.",
  zero_weight: "The scale shows 0. Is the vehicle on the weighbridge?",
  negative_weight: "The scale shows a negative weight. Zero the indicator with the bridge empty.",
  port_busy: "The printer PC cannot open the scale's COM port (another weighing program may be using it).",
  port_lost: "The scale's cable or USB adapter is disconnected from the printer PC.",
  not_configured: "No weighing scale is set up in the Print Agent.",
  timeout: "The printer PC did not answer in time. Check that it is on and online, then try again.",
  scale_error: "The scale could not be read. Try again or type the weight.",
};

export interface ScaleReading { id: string; kg: number; at: string }
interface SiteScale { available: boolean; online: boolean; pc: string | null }

/** Is there a weighing scale for this site (and is its PC online)? Refreshed every 30 s. */
export function useSiteScale(siteId: string): SiteScale | null {
  const { org } = useApp();
  const [s, setS] = useState<SiteScale | null>(null);
  const load = useCallback(async () => {
    if (!org || !siteId) return;
    const { data } = await supabase().from("print_agents").select("label,status,approval,scale,last_heartbeat_at")
      .eq("organization_id", org.organization_id).eq("site_id", siteId).eq("status", "active");
    const rows = (data ?? []) as { label: string; approval: string | null; scale: { enabled?: boolean } | null; last_heartbeat_at: string | null }[];
    const a = rows.find((r) => (r.approval ?? "approved") === "approved" && r.scale?.enabled);
    setS(a ? { available: true, online: !!a.last_heartbeat_at && Date.now() - Date.parse(a.last_heartbeat_at) < 120_000, pc: a.label } : { available: false, online: false, pc: null });
  }, [org, siteId]);
  useEffect(() => { void load(); }, [load]);
  useVisibleInterval(load, 30_000);
  return s;
}

/**
 * The button and its result line. `onWeight` receives the steady weight; the caller puts it in the weight field and passes
 * `reading.id` when saving (only while the field still holds exactly that weight).
 */
export function DetectWeight({ siteId, onWeight, disabled }: { siteId: string; onWeight: (r: ScaleReading) => void; disabled?: boolean }) {
  const { org } = useApp();
  const scale = useSiteScale(siteId);
  const [state, setState] = useState<{ k: "idle" } | { k: "reading" } | { k: "error"; msg: string }>({ k: "idle" });
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  async function detect() {
    if (!org || state.k === "reading") return;
    setState({ k: "reading" });
    const sb = supabase();
    const { data, error } = await sb.rpc("request_scale_weight", { p_org: org.organization_id, p_site: siteId });
    if (error) { setState({ k: "error", msg: friendlyError(error) }); return; }
    const id = (data as { id: string }).id;
    // the answer arrives in about a second: realtime nudges, polling (every 400 ms, up to 15 s) is the source of truth
    let nudge: (() => void) | null = null;
    const ch = sb.channel(`wr-${id}`).on("postgres_changes", { event: "UPDATE", schema: "public", table: "weight_reads", filter: `id=eq.${id}` }, () => nudge?.()).subscribe();
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && alive.current) {
        const { data: r } = await sb.from("weight_reads").select("status,weight_kg,error_code,completed_at").eq("id", id).maybeSingle();
        const row = r as { status: string; weight_kg: string | null; error_code: string | null; completed_at: string | null } | null;
        if (row?.status === "done" && row.weight_kg !== null) {
          setState({ k: "idle" });
          onWeight({ id, kg: Number(row.weight_kg), at: row.completed_at ?? new Date().toISOString() });
          return;
        }
        if (row && (row.status === "failed" || row.status === "expired")) {
          setState({ k: "error", msg: SCALE_ERRORS[row.error_code ?? ""] ?? SCALE_ERRORS.scale_error! });
          return;
        }
        await new Promise<void>((res) => { const t = setTimeout(res, 400); nudge = () => { clearTimeout(t); res(); }; });
      }
      if (alive.current) setState({ k: "error", msg: SCALE_ERRORS.timeout! });
    } finally {
      void sb.removeChannel(ch);
    }
  }

  if (!scale?.available) return null;
  return (
    <>
      <button type="button" className="btn-navy shrink-0 whitespace-nowrap" disabled={disabled || state.k === "reading" || !scale.online} onClick={detect}
        title={scale.online ? `Reads the steady weight from the scale on ${scale.pc}` : `${scale.pc} is offline`} aria-live="polite">
        {state.k === "reading" ? "Reading…" : "⚖ Detect weight"}
      </button>
      {(state.k === "error" || !scale.online) && (
        <p className="basis-full text-sm text-red-700" role="alert">{state.k === "error" ? state.msg : `The printer PC with the scale (${scale.pc}) is offline. Type the weight, or start the PC / Print Agent.`}</p>
      )}
    </>
  );
}
