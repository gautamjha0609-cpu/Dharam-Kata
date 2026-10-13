"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  LayoutSchema, PT_TO_MM, fieldText, approxMeasure, fitText, ticketPreset,
  isCustomKey, type FieldKey, type Layout, type Measure, type PrintValues,
} from "@dk/print-template";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { isFresh, peek, put } from "@/lib/swr-cache";

function canvasMeasure(): Measure {
  if (typeof document === "undefined") return approxMeasure;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return approxMeasure;
  return (text, family, pt, bold) => {
    ctx.font = `${bold ? "bold " : ""}${pt}pt "${family}", monospace`;
    return (ctx.measureText(text).width * 25.4) / 96;
  };
}

export interface ReceiptConfig {
  layout: Layout;
  /** true once an admin has published a layout; false = built-in standard preset (provisional positions) */
  published: boolean;
  imageUrl: string | null;
  /** does the Weighment form ask for this field? (layout: "Ask on form", default = printed) */
  has: (key: FieldKey) => boolean;
  /** does the operator have to fill this field in? */
  required: (key: FieldKey) => boolean;
  reload: () => void;
  /** the layout and image have been fetched (until then a placeholder holds the space) */
  ready: boolean;
}

interface Resolved { layout: Layout; published: boolean; imageVersion: number | null; floor: number | null }

/**
 * Resolves the layout for a site: printer -> site -> tenant -> built-in preset, plus the firm's ticket image and the printer's smallest readable size.
 * ONE database request (receipt_context). The last answer for this firm/site is shown immediately and re-checked in the background.
 */
export function useReceipt(siteId?: string): ReceiptConfig {
  const { org } = useApp();
  const key = org ? `receipt:${org.organization_id}:${siteId ?? ""}` : "";
  const standard = useMemo(() => ticketPreset(), []);
  const [res, setRes] = useState<Resolved | null>(() => (key ? peek<Resolved>(key) ?? null : null));
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!org) return;
    const cached = peek<Resolved>(key);
    if (cached) setRes(cached);
    if (cached && tick === 0 && isFresh(key, 15_000)) return; // looked at a moment ago: no request at all
    let alive = true;
    void supabase().rpc("receipt_context", { p_org: org.organization_id, p_site: (siteId ?? null) as unknown as string }).then(({ data, error }: { data: unknown; error: unknown }) => {
      if (!alive) return;
      if (error || !data) { setRes((r) => r ?? { layout: standard, published: false, imageVersion: null, floor: null }); return; }
      const d = data as { layout: unknown; image_version: number | null; printer_floor: string | number | null };
      const parsed = d.layout ? LayoutSchema.safeParse(d.layout) : null;
      setRes(put(key, {
        layout: parsed?.success ? parsed.data : standard, published: !!parsed?.success,
        imageVersion: d.image_version ?? null, floor: d.printer_floor != null ? Number(d.printer_floor) : null,
      }));
    });
    return () => { alive = false; };
  }, [org, siteId, tick, key, standard]);

  const layout = res?.layout ?? standard, published = res?.published ?? false, imageVersion = res?.imageVersion ?? null, printerFloor = res?.floor ?? null, ready = res !== null;

  return useMemo(() => ({
    layout: printerFloor && printerFloor > layout.legibilityFloorPt ? { ...layout, legibilityFloorPt: printerFloor } : layout, published,
    imageUrl: org && imageVersion ? `/api/v1/templates/preview-image?organization_id=${org.organization_id}&v=${imageVersion}` : null,
    // the Weighment form asks for a field only if the layout says so ("Ask on form"; by default: if it is printed)
    has: (key) => layout.fields.some((f) => f.key === key && (f.ask ?? f.visible)),
    required: (key) => layout.fields.some((f) => f.key === key && (f.ask ?? f.visible) && f.required === true),
    reload: () => setTick((n) => n + 1),
    ready,
  }), [layout, published, imageVersion, org, printerFloor, ready]);
}

const IST = "Asia/Kolkata";
export const fmtDate = (iso?: string | null) => (iso ? new Intl.DateTimeFormat("en-GB", { timeZone: IST, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso)) : "");
export const fmtTime = (iso?: string | null) => (iso ? new Intl.DateTimeFormat("en-GB", { timeZone: IST, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)) : "");
const kg = (v?: string | number | null) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? "" : String(Number(v)));

export interface PreviewInput {
  serial?: string; vehicle?: string; material?: string; party?: string; notes?: string; paymentMode?: string;
  gross?: string | number | null; grossAt?: string | null; tare?: string | number | null; tareAt?: string | null;
  net?: string | number | null; charge?: string | number | null;
  /** the firm's extra fields (x1..x8) */
  extra?: Record<string, string> | null;
  /** opening slip: only the first weight is known; it prints under the Loaded heading, relabelled "First weight" */
  stage?: "open" | "closed";
}
/** Same formatting the server uses for the real print payload (build_print_values), so preview == print. */
export function previewValues(i: PreviewInput): PrintValues {
  const v: PrintValues = {};
  const set = (k: FieldKey, s: string | undefined | null) => { if (s) v[k] = s; };
  set("serial", i.serial); set("vehicle", i.vehicle?.toUpperCase()); set("material", i.material); set("party", i.party); set("notes", i.notes);
  set("payment_mode", i.paymentMode);
  set("gross_weight", kg(i.gross)); set("gross_date", fmtDate(i.grossAt)); set("gross_time", fmtTime(i.grossAt));
  set("tare_weight", kg(i.tare)); set("tare_date", fmtDate(i.tareAt)); set("tare_time", fmtTime(i.tareAt));
  set("net_weight", kg(i.net)); set("charge", kg(i.charge));
  for (const [k, s] of Object.entries(i.extra ?? {})) if (isCustomKey(k)) set(k, s);
  if (i.stage === "open") v.stage = "open";
  return v;
}

/** Read-only, to-scale view of the ticket with the live values placed exactly where the printer will place them. */
export function TicketPreview({ config, values, caption }: { config: ReceiptConfig; values: PrintValues; caption?: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(320);
  const measure = useMemo(canvasMeasure, []);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el); setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const { layout, imageUrl } = config;
  const s = w / layout.paper.w;
  const tooSmall = useMemo(() => layout.fields.filter((f) => f.visible && values[f.key]).filter((f) => { const r = fitText(fieldText(layout, f, values[f.key]!, values.stage), f, layout.legibilityFloorPt, measure); return !r.overflow && r.belowFloor; }).map((f) => f.label?.replace(/[ :]+$/, "") || f.key.replace("_", " ")), [layout, values, measure]);
  const tooLong = useMemo(() => layout.fields.filter((f) => f.visible && values[f.key]).filter((f) => fitText(fieldText(layout, f, values[f.key]!, values.stage), f, layout.legibilityFloorPt, measure).overflow).map((f) => f.label?.replace(/[ :]+$/, "") || f.key.replace("_", " ")), [layout, values, measure]);
  const ox = layout.printArea.x + layout.offset.x;
  const oy = layout.printArea.y + layout.offset.y;
  return (
    <div ref={wrap} className="w-full">
      {!config.ready && <div className="skeleton w-full" style={{ height: Math.round(w * 0.56) }} aria-busy="true" aria-label="Loading the ticket preview" />}
      <div hidden={!config.ready} className="relative overflow-hidden rounded border border-slate-300 bg-white" style={{ width: "100%", height: layout.paper.h * s }} aria-label="Ticket preview">
        {imageUrl && /* eslint-disable-next-line @next/next/no-img-element */ <img src={imageUrl} alt="" className="absolute inset-0 h-full w-full object-contain" draggable={false} fetchPriority="high" decoding="async" />}
        {layout.mode === "blank" && layout.decor.map((d) => {
          const px = (layout.offset.x + d.x) * s, py = (layout.offset.y + d.y) * s;
          if (d.type === "text") return <div key={d.id} className="absolute overflow-hidden whitespace-pre text-black" style={{ left: px, top: py, width: d.w * s, height: d.h * s, fontFamily: `'${d.font.family}','Nirmala UI',monospace`, fontSize: d.font.pt * PT_TO_MM * s, fontWeight: d.font.bold ? 700 : 400, fontStyle: d.font.italic ? "italic" : "normal", textDecoration: d.font.underline ? "underline" : "none", textAlign: d.align, lineHeight: 1.1 }}>{d.text}</div>;
          if (d.type === "line") { const horiz = d.h <= d.w; return <div key={d.id} className="absolute" style={{ left: px, top: py, width: horiz ? d.w * s : 0, height: horiz ? 0 : d.h * s, [horiz ? "borderTop" : "borderLeft"]: `${Math.max(1, d.weight * s)}px solid #000` }} />; }
          return <div key={d.id} className="absolute box-border" style={{ left: px, top: py, width: d.w * s, height: d.h * s, border: `${Math.max(1, d.weight * s)}px solid #000` }} />;
        })}
        {layout.fields.filter((f) => f.visible).map((f) => {
          const raw = values[f.key];
          if (!raw) return null;
          const fit = fitText(fieldText(layout, f, raw, values.stage), f, layout.legibilityFloorPt, measure);
          return (
            <div key={f.id} className="absolute overflow-hidden" style={{ left: (ox + f.x) * s, top: (oy + f.y) * s, width: f.w * s, height: f.h * s }}>
              <div style={{
                fontFamily: `'${f.font.family}','Nirmala UI',monospace`, fontSize: fit.pt * PT_TO_MM * s, lineHeight: `${fit.pt * PT_TO_MM * f.lineHeight * s}px`,
                fontWeight: f.font.bold ? 700 : 400, fontStyle: f.font.italic ? "italic" : "normal", textDecoration: f.font.underline ? "underline" : "none", textAlign: f.align, whiteSpace: "pre", color: fit.overflow ? "#b42318" : "#0b1f66",
              }}>{fit.lines.join("\n")}</div>
            </div>
          );
        })}
      </div>
      {tooLong.length > 0 && (
        <p role="alert" className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-sm text-red-800">
          ⚠ Too long to print on the ticket: <b>{tooLong.join(", ")}</b>. Shorten it, or the printer PC will refuse to print this ticket (it never prints cut-off text).
        </p>
      )}
      {tooSmall.length > 0 && (
        <p role="status" className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-sm text-amber-900">
          ⚠ Will print small (below {layout.legibilityFloorPt} pt, the readable size for this printer): <b>{tooSmall.join(", ")}</b>. It still prints; shorten it for a clearer slip.
        </p>
      )}
      <p className="mt-1 text-xs text-slate-600">
        {caption ?? "Live preview of the printed ticket."}{!imageUrl && " (No ticket image uploaded yet — showing text positions only.)"}
        {" "}Only the typed values are printed; the ticket’s header and footer are already on your pre-printed paper.
      </p>
    </div>
  );
}
