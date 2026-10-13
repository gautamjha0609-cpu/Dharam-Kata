"use client";
import { Select } from "@/components/ios";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  DEFAULT_LABELS, DesignError, autoReprintMark, FIELD_KEYS, isCustomKey, FONT_FAMILIES, LayoutSchema, PAPER_SIZES, PT_TO_MM, applyFullDesign, approxMeasure, fieldText, fitText, matchPaperSize,
  ticketPreset,
  type BuiltinKey, type FieldKey, type FontFamily, type Layout, type LayoutField, type Measure, type PrintValues,
} from "@dk/print-template";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { friendlyError } from "@/lib/errors";
import { newIdemKey } from "@/lib/format";
import { Alert, PRINT_ERRORS } from "@/components/ui";
import { useReceipt } from "@/components/receipt";
import { useCustomFields } from "@/components/custom-fields";
import { clearCache } from "@/lib/swr-cache";
import { ModeCard } from "@/components/designer-extras";
import { useShell } from "@/lib/shell-ui";

const SAMPLE: PrintValues = {
  serial: "22242", vehicle: "RJ14GD9158", material: "MRKU3564630", party: "GANPATI PLAS",
  gross_weight: "34210", gross_date: "29/07/2026", gross_time: "15:16",
  tare_weight: "15105", tare_date: "28/07/2026", tare_time: "11:40", net_weight: "19105", charge: "350",
  payment_mode: "cash", notes: "Sample note", operator: "Operator", site: "Main", title: "WEIGHMENT SLIP", company: "Company name", debtor: "Debtor",
};
const KEY_LABEL: Record<BuiltinKey, string> = {
  serial: "Invoice / serial no", party: "Party / seller", material: "Material", vehicle: "Vehicle no", gross_weight: "Loaded weight", gross_date: "Loaded date",
  gross_time: "Loaded time", tare_weight: "Empty weight", tare_date: "Empty date", tare_time: "Empty time", net_weight: "Net weight", charge: "Charge / fee",
  payment_mode: "Payment mode", debtor: "Debtor", notes: "Notes", operator: "Operator", site: "Site", title: "Title", company: "Company name",
};
/** Fields the operator types in on the Weighment form (so "must fill in" makes sense for them). */
const OPERATOR_TYPED: string[] = ["party", "material", "notes", "debtor"];
const snap = (n: number) => Math.round(n * 2) / 2;
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

function makeCanvasMeasure(): Measure {
  if (typeof document === "undefined") return approxMeasure;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return approxMeasure;
  return (text, family, pt, bold) => {
    ctx.font = `${bold ? "bold " : ""}${pt}pt "${family}", monospace`;
    return (ctx.measureText(text).width * 25.4) / 96; // px at 96 dpi -> mm
  };
}

interface Tpl { id: string; name: string; scope: string; site_id: string | null; printer_id: string | null; draft_layout: Layout; published_version_id: string | null }
interface Ver { id: string; version_no: number; published_at: string }
type Tab = "fields" | "paper";

/** A number box that applies its value on Enter or when you leave it, so typing a multi-digit number is not interrupted. */
function AreaNum({ label, value, onCommit }: { label: string; value: number; onCommit: (v: string) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  return (
    <div><label className="label text-xs">{label}</label>
      <input className="field !min-h-[40px]" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)}
        onBlur={() => onCommit(text)} onKeyDown={(e) => { if (e.key === "Enter") { onCommit(text); (e.target as HTMLInputElement).blur(); } }} />
    </div>
  );
}

const HEADER_TEXT: [string, string][] = [["firm", "Firm name"], ["addr", "Address line"], ["govt", "Second line"], ["phone", "Phone / contact line"], ["n1", "Footer note 1"], ["n2", "Footer note 2"], ["sign", "Signature caption"]];
const TEST_STEPS: Record<string, string> = {
  sending: "Sending the test to the printer…", queued: "Waiting for the Print Agent on the printer PC to pick it up…", claimed: "The Print Agent is preparing the page…",
  rendering: "The Print Agent is preparing the page…", submitting: "Sending the page to the printer…",
};
const TEST_DONE = new Set(["submitted_to_spooler", "failed", "unknown", "routing_error", "not_configured", "cancelled"]);

/* small building blocks ------------------------------------------------------------------------------------------- */
const Toggle = ({ on, onClick, label, children, title }: { on: boolean; onClick: () => void; label: string; children: React.ReactNode; title?: string }) => (
  <button type="button" aria-pressed={on} aria-label={label} title={title ?? label} onClick={onClick}
    className={`flex h-10 min-w-[40px] items-center justify-center rounded-lg border px-2 text-sm font-semibold ${on ? "border-navy bg-navy text-white" : "border-slate-300 bg-white text-navy hover:bg-slate-50"}`}>{children}</button>
);
const Seg = <T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) => (
  <div role="radiogroup" aria-label={label} className="inline-flex overflow-hidden rounded-lg border border-slate-300">
    {options.map(([v, text]) => (
      <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}
        className={`min-h-[40px] px-3 text-sm font-medium ${value === v ? "bg-navy text-white" : "bg-white text-navy hover:bg-slate-50"}`}>{text}</button>
    ))}
  </div>
);

export default function TemplateDesigner() {
  const { org, can } = useApp();
  const [layout, setLayout] = useState<Layout>(() => ticketPreset());
  const [tplId, setTplId] = useState<string | null>(null);
  const [name, setName] = useState("Pre-printed ticket 170 x 95 mm");
  const [scopeSel, setScopeSel] = useState("");
  const [templates, setTemplates] = useState<Tpl[]>([]);
  const [printers, setPrinters] = useState<{ id: string; label: string; os_printer_name: string }[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("fields");
  const [values, setValues] = useState<PrintValues>(SAMPLE);
  /** which slip the preview shows: the opening slip only has the first weight (printed as "First weight") */
  const [zoom, setZoom] = useState(1);
  const [slip, setSlip] = useState<"closed" | "open">("closed");
  const view = useMemo<PrintValues>(() => {
    if (slip === "closed") return values;
    const v = { ...values, stage: "open" } as PrintValues;
    delete v.tare_weight; delete v.tare_date; delete v.tare_time; delete v.net_weight;
    return v;
  }, [values, slip]);
  const customsHook = useCustomFields();
  const customs = customsHook.active;
  const kl = (k: string) => KEY_LABEL[k as BuiltinKey] ?? customs.find((c) => c.key === k)?.label_en ?? k;
  const dl = (k: string): { en: string; hi: string } => {
    const c = customs.find((x) => x.key === k);
    return c ? { en: `${c.label_en} :`, hi: `${c.label_hi ?? c.label_en} :` } : DEFAULT_LABELS[k as BuiltinKey] ?? { en: "", hi: "" };
  };
  // sample text for the extra fields so the preview shows them
  useEffect(() => { setValues((v) => { const n = { ...v }; for (const c of customs) if (!n[c.key]) n[c.key] = c.label_en.toUpperCase(); return n; }); }, [customs]);
  const [versions, setVersions] = useState<Ver[]>([]);
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ k: "ok" | "error" | "warn" | "info"; t: string } | null>(null);
  const stored = useReceipt();
  const [underlayLocal, setUnderlayLocal] = useState<string | null>(null);
  const underlay = underlayLocal ?? stored.imageUrl;
  const [box, setBox] = useState({ w: 800, h: 600 });
  const [boxReady, setBoxReady] = useState(false);
  const [grid, setGrid] = useState(false);
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const { openMenu } = useShell();
  const wrap = useRef<HTMLDivElement>(null);
  const measure = useMemo(makeCanvasMeasure, []);

  /** Every change to the layout goes through here so the "unsaved changes" flag is reliable. */
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const past = useRef<Layout[]>([]);
  const future = useRef<Layout[]>([]);
  const lastPush = useRef(0);
  const [, bumpHistory] = useState(0);
  // edits made within half a second of each other (a drag, typing) count as one undo step
  const edit = useCallback((fn: (l: Layout) => Layout) => {
    const now = Date.now();
    if (now - lastPush.current > 500) { past.current.push(layoutRef.current); if (past.current.length > 60) past.current.shift(); }
    lastPush.current = now; future.current = [];
    setLayout(fn); setDirty(true); bumpHistory((n) => n + 1);
  }, []);
  const undo = () => { const p = past.current.pop(); if (!p) return; future.current.push(layoutRef.current); lastPush.current = 0; setLayout(p); setDirty(true); bumpHistory((n) => n + 1); };
  const redo = () => { const n = future.current.pop(); if (!n) return; past.current.push(layoutRef.current); lastPush.current = 0; setLayout(n); setDirty(true); bumpHistory((x) => x + 1); };
  const resetHistory = () => { past.current = []; future.current = []; bumpHistory((n) => n + 1); };

  const loadTemplates = useCallback(async () => {
    if (!org) return;
    const sb = supabase();
    const [{ data }, pr] = await Promise.all([
      sb.from("receipt_templates").select("id,name,scope,site_id,printer_id,draft_layout,published_version_id").eq("organization_id", org.organization_id).order("created_at"),
      sb.from("printer_devices").select("id,label,os_printer_name").eq("organization_id", org.organization_id).eq("active", true),
    ]);
    const list = (data ?? []) as unknown as Tpl[];
    setTemplates(list); setPrinters((pr.data ?? []) as { id: string; label: string; os_printer_name: string }[]);
    const t = list.find((x) => x.id === tplId) ?? list.find((x) => x.scope === "tenant") ?? list[0];
    if (t) await openTemplate(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, tplId]);

  async function openTemplate(t: Tpl) {
    resetHistory();
    const parsed = LayoutSchema.safeParse(t.draft_layout);
    if (parsed.success) setLayout(parsed.data);
    setTplId(t.id); setName(t.name); setDirty(false);
    setScopeSel(t.scope === "printer" && t.printer_id ? `printer:${t.printer_id}` : t.scope === "site" && t.site_id ? `site:${t.site_id}` : "");
    const { data: v } = await supabase().from("receipt_template_versions").select("id,version_no,published_at").eq("template_id", t.id).order("version_no", { ascending: false });
    const vs = (v ?? []) as Ver[];
    setVersions(vs);
    setPublishedVersion(t.published_version_id ? vs.find((x) => x.id === t.published_version_id)?.version_no ?? vs[0]?.version_no ?? null : null);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadTemplates(); }, [org]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measureBox = () => { setBox({ w: el.clientWidth, h: el.clientHeight }); setBoxReady(true); };
    const ro = new ResizeObserver(measureBox);
    ro.observe(el);
    measureBox();
    return () => ro.disconnect();
  }, []);

  // px per mm: the whole paper fits the canvas at 100%, zoom scales from there
  const s = Math.max(1, Math.min((box.w - 28) / layout.paper.w, (box.h - 28) / layout.paper.h, 12)) * zoom;
  const ox = layout.printArea.x + layout.offset.x;
  const oy = layout.printArea.y + layout.offset.y;
  const parsed = LayoutSchema.safeParse(layout);
  const issues = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".") || "layout"}: ${i.message}`);
  const field = layout.fields.find((f) => f.id === sel) ?? null;

  const textOf = useCallback((f: LayoutField, raw: string) => fieldText(layout, f, raw, view.stage), [layout, view.stage]);

  const fits = useMemo(() => {
    const m = new Map<string, ReturnType<typeof fitText>>();
    for (const f of layout.fields) {
      const raw = view[f.key];
      if (!f.visible || !raw) continue;
      m.set(f.id, fitText(textOf(f, raw), f, layout.legibilityFloorPt, measure));
    }
    return m;
  }, [layout, view, measure, textOf]);
  const warnings = [...fits.entries()].filter(([, r]) => r.overflow || r.belowFloor).map(([id, r]) => `${kl(layout.fields.find((f) => f.id === id)!.key)}: ${r.overflow ? "does not fit even at the smallest size — make the box wider or the text shorter" : `shrinks to ${r.pt} pt (below ${layout.legibilityFloorPt} pt)`}`);

  const patch = (id: string, p: Partial<LayoutField>) => edit((l) => ({ ...l, fields: l.fields.map((f) => (f.id === id ? { ...f, ...p } : f)) }));
  const patchFont = (id: string, p: Partial<LayoutField["font"]>) => edit((l) => ({ ...l, fields: l.fields.map((f) => (f.id === id ? { ...f, font: { ...f.font, ...p } } : f)) }));
  /** Bigger / smaller text: moves the preferred (maximum) size; the smallest allowed size follows if needed. */
  const resize = (f: LayoutField, delta: number) => {
    const max = clamp(Math.round((f.font.maxPt + delta) * 2) / 2, 5, 48);
    patchFont(f.id, { maxPt: max, minPt: Math.min(f.font.minPt, max) });
  };

  const setSize = (f: LayoutField, pt: number) => patchFont(f.id, { maxPt: pt, minPt: Math.min(f.font.minPt, pt) });

  // ---- Canva-style helpers ------------------------------------------------------------------------------------------
  const typed = (k: string) => OPERATOR_TYPED.includes(k) || isCustomKey(k);
  const askOn = (f: LayoutField) => f.ask ?? f.visible;
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const ceil1 = (n: number) => Math.ceil(n * 10) / 10;
  /** Sizes the box so its text fits: keeps the chosen text size if the printing area allows, else shrinks (never below the smallest size), else wraps. */
  function fitOne(l: Layout, f: LayoutField): LayoutField {
    const a = l.printArea;
    const text = fieldText(l, f, view[f.key] ?? kl(f.key), view.stage);
    const lines = text.split("\n");
    const widthAt = (pt: number) => Math.max(...lines.map((x) => measure(x, f.font.family, pt, f.font.bold))) * 1.03 + 1.6;
    let pt = f.font.maxPt, need = widthAt(pt);
    while (need > a.w && pt > f.font.minPt) { pt = Math.max(f.font.minPt, pt - 0.5); need = widthAt(pt); }
    let w = need, rows = lines.length, fit = f.fit;
    if (need > a.w) { w = a.w; fit = "wrap"; rows = Math.min(6, Math.max(rows, Math.ceil(need / Math.max(1, a.w)))); }
    const h = ceil1(rows * pt * PT_TO_MM * f.lineHeight + 1);
    w = ceil1(Math.max(6, w));
    const x = Math.max(0, Math.min(f.x, a.w - w)), y = Math.max(0, Math.min(f.y, a.h - h));
    return { ...f, x: round1(x), y: round1(y), w, h, fit, maxLines: Math.max(f.maxLines, rows), font: { ...f.font, maxPt: pt, minPt: Math.min(f.font.minPt, pt) } };
  }
  const autoFit = (id: string) => { edit((l) => ({ ...l, fields: l.fields.map((f) => (f.id === id ? fitOne(l, f) : f)) })); setMsg({ k: "ok", t: "Box adjusted to fit its text. Real values can be longer than the sample, so check the preview." }); };
  const fixAll = () => {
    const bad = new Set([...fits.entries()].filter(([, r]) => r.overflow || r.belowFloor).map(([id]) => id));
    edit((l) => ({ ...l, fields: l.fields.map((f) => (bad.has(f.id) ? fitOne(l, f) : f)) }));
    setMsg({ k: "ok", t: `Adjusted ${bad.size} box${bad.size === 1 ? "" : "es"} to fit their text.` });
  };
  const removeField = (f: LayoutField) => { edit((l) => ({ ...l, fields: l.fields.filter((x) => x.id !== f.id), removed: [...new Set([...l.removed, f.key])] })); setSel(null); };
  const lastTap = useRef<{ id: string; t: number } | null>(null);

  // headings: none / English / Hindi, for every field at once
  const headingMode: "off" | "en" | "hi" = layout.fields.some((f) => f.visible && f.showLabel) ? layout.labelLang : "off";
  function setHeadings(mode: "off" | "en" | "hi") {
    edit((l) => ({
      ...l,
      labelLang: mode === "off" ? l.labelLang : mode,
      fields: l.fields.map((f) => ({ ...f, labelLang: undefined, showLabel: mode !== "off", labelEn: f.labelEn ?? (dl(f.key).en || undefined), labelHi: f.labelHi ?? (dl(f.key).hi || undefined) })),
    }));
  }

  // drag / resize on the canvas
  const drag = useRef<{ id: string; mode: "move" | "resize"; sx: number; sy: number; f: LayoutField } | null>(null);
  function down(e: React.PointerEvent, f: LayoutField, mode: "move" | "resize") {
    e.stopPropagation();
    if (mode === "move") { // double-click / double-tap: fit the box to its text
      const now = Date.now();
      if (lastTap.current?.id === f.id && now - lastTap.current.t < 400) { lastTap.current = null; setSel(f.id); autoFit(f.id); return; }
      lastTap.current = { id: f.id, t: now };
    }
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: f.id, mode, sx: e.clientX, sy: e.clientY, f };
    setSel(f.id); setTab("fields");
  }
  // ---- printing area: drag any edge / corner to crop it, drag the tab to move it ----
  const areaDrag = useRef<{ mode: string; sx: number; sy: number; base: Layout } | null>(null);
  function areaDown(e: React.PointerEvent, mode: string) {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    areaDrag.current = { mode, sx: e.clientX, sy: e.clientY, base: layoutRef.current };
    setSel(null);
  }
  /** New printing area for `next`. Resizing keeps every field where it is on the paper (like cropping a picture); moving the frame carries the fields along. Fields are kept inside the area. */
  function cropFrom(base: Layout, next: { x: number; y: number; w: number; h: number }, carry: boolean): Layout {
    const a0 = base.printArea, r1 = (n: number) => Math.round(n * 10) / 10;
    const shx = carry ? 0 : a0.x - next.x, shy = carry ? 0 : a0.y - next.y;
    const inside = <T extends { x: number; y: number; w: number; h: number }>(o: T): T => {
      const w = Math.min(o.w, next.w), h = Math.min(o.h, next.h);
      return { ...o, w: r1(w), h: r1(h), x: r1(clamp(o.x + shx, 0, next.w - w)), y: r1(clamp(o.y + shy, 0, next.h - h)) };
    };
    return { ...base, printArea: { x: r1(next.x), y: r1(next.y), w: r1(next.w), h: r1(next.h) }, fields: base.fields.map(inside), reprintMark: autoReprintMark(next) };
  }
  function moveArea(e: React.PointerEvent) {
    const ad = areaDrag.current;
    if (!ad) return;
    const dx = snap((e.clientX - ad.sx) / s), dy = snap((e.clientY - ad.sy) / s);
    const { paper, printArea: a0 } = ad.base, m = ad.mode, MINW = 20, MINH = 10;
    let { x, y, w, h } = a0;
    if (m === "move") { x = clamp(a0.x + dx, 0, paper.w - a0.w); y = clamp(a0.y + dy, 0, paper.h - a0.h); }
    else {
      if (m.includes("w")) { x = clamp(a0.x + dx, 0, a0.x + a0.w - MINW); w = a0.w - (x - a0.x); }
      if (m.includes("e")) w = clamp(a0.w + dx, MINW, paper.w - a0.x);
      if (m.includes("n")) { y = clamp(a0.y + dy, 0, a0.y + a0.h - MINH); h = a0.h - (y - a0.y); }
      if (m.includes("s")) h = clamp(a0.h + dy, MINH, paper.h - a0.y);
    }
    edit(() => cropFrom(ad.base, { x, y, w, h }, m === "move"));
  }
  function move(e: React.PointerEvent) {
    if (areaDrag.current) return moveArea(e);
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / s, dy = (e.clientY - d.sy) / s;
    const a = layout.printArea;
    if (d.mode === "move") patch(d.id, { x: clamp(snap(d.f.x + dx), 0, a.w - d.f.w), y: clamp(snap(d.f.y + dy), 0, a.h - d.f.h) });
    else patch(d.id, { w: clamp(snap(d.f.w + dx), 3, a.w - d.f.x), h: clamp(snap(d.f.h + dy), 2, a.h - d.f.y) });
  }
  function onKey(e: React.KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if ((e.ctrlKey || e.metaKey) && tag !== "INPUT" && tag !== "TEXTAREA") {
      const k = e.key.toLowerCase();
      if (k === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (k === "y") { e.preventDefault(); redo(); return; }
    }
    if (!field || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    const st = e.shiftKey ? 2 : 0.5;
    const a = layout.printArea;
    const k: Record<string, [number, number]> = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] };
    const v = k[e.key];
    if (!v) return;
    e.preventDefault();
    patch(field.id, { x: clamp(field.x + v[0], 0, a.w - field.w), y: clamp(field.y + v[1], 0, a.h - field.h) });
  }

  function addField(key: FieldKey, lab?: { en: string; hi: string }) {
    if (layout.fields.some((f) => f.id === key)) return;
    // put it in free space: below the lowest field, wide enough for heading + value
    const bottom = Math.max(0, ...layout.fields.filter((x) => x.visible).map((x) => x.y + x.h));
    const w = Math.min(70, Math.max(10, layout.printArea.w - 4));
    const slot = { x: 2, w, y: Math.max(0, Math.min(bottom + 1, layout.printArea.h - 6)) };
    const nf: LayoutField = {
      id: key, key, visible: true, order: layout.fields.length, x: slot.x, y: slot.y, w: slot.w, h: 6, showLabel: headingMode !== "off",
      labelEn: (lab ?? dl(key)).en || undefined, labelHi: (lab ?? dl(key)).hi || undefined,
      font: { family: "Courier New", minPt: 8, maxPt: 11, bold: false }, align: "left", fit: "shrink", maxLines: 1, lineHeight: 1.15,
    };
    edit((l) => ({ ...l, fields: [...l.fields, nf], removed: l.removed.filter((k) => k !== key) }));
    setSel(key);
  }
  // The "add" list is short on purpose: fields this slip had and the operator removed, plus extra fields that were created but not placed yet.
  const placed = (k: string) => layout.fields.some((f) => f.key === k);
  const unused: FieldKey[] = [...new Set([...layout.removed, ...customs.map((c) => c.key)])].filter((k): k is FieldKey => !placed(k) && (isCustomKey(k) ? customs.some((c) => c.key === k) : (FIELD_KEYS as readonly string[]).includes(k)));
  const [newField, setNewField] = useState<{ en: string; hi: string; kind: "text" | "number"; required: boolean } | null>(null);
  async function createField() {
    if (!org || !newField) return;
    if (!newField.en.trim()) return setMsg({ k: "error", t: "Type a name for the new field, for example Driver name." });
    const { data, error } = await supabase().rpc("save_custom_field", {
      p_org: org.organization_id, p_key: null as unknown as string, p_label_en: newField.en, p_label_hi: newField.hi as unknown as string,
      p_kind: newField.kind, p_required: newField.required, p_ask_at: "first", p_active: true,
    });
    if (error) return setMsg({ k: "error", t: error.message.includes("custom_field_limit") ? "You can have at most 8 extra fields." : friendlyError(error) });
    const key = (data as { key: FieldKey }).key;
    customsHook.reload();
    addField(key, { en: `${newField.en.trim()} :`, hi: `${(newField.hi.trim() || newField.en.trim())} :` });
    patch(key, { required: newField.required });
    setNewField(null);
    setMsg({ k: "ok", t: "New field added. It now appears on the Weighment form too (after you save this layout)." });
  }

  async function save(publish: boolean) {
    if (!org || !parsed.success) return;
    const sb = supabase();
    const { data, error } = await sb.rpc("save_template_draft", {
      p_org: org.organization_id, p_id: tplId as unknown as string, p_name: name, p_scope: (scopeSel.startsWith("printer:") ? "printer" : scopeSel.startsWith("site:") ? "site" : "tenant") as "tenant",
      p_site: (scopeSel.startsWith("site:") ? scopeSel.slice(5) : null) as unknown as string, p_printer: (scopeSel.startsWith("printer:") ? scopeSel.slice(8) : null) as unknown as string, p_layout: LayoutSchema.parse({ ...parsed.data, reprintMark: autoReprintMark(parsed.data.printArea) }) as never,
    });
    if (error) return setMsg({ k: "error", t: friendlyError(error) });
    const id = (data as { id: string }).id;
    setTplId(id);
    clearCache("receipt:");
    if (publish) {
      const r = await sb.rpc("publish_template", { p_org: org.organization_id, p_template: id });
      if (r.error) return setMsg({ k: "error", t: friendlyError(r.error) });
      setMsg({ k: "ok", t: `Published version ${(r.data as { version_no: number }).version_no}\nNew invoices use it; invoices already issued keep the version they printed with.` });
    } else setMsg({ k: "ok", t: "Draft saved\nIt is not used for printing until you publish it." });
    setDirty(false);
    void loadTemplates();
  }
  // ---- test print: goes through the real queue, so it also proves the Print Agent, the printer and the paper size ----
  const [testPrinter, setTestPrinter] = useState("");
  const [testJob, setTestJob] = useState<{ id?: string; status: string; error?: string | null } | null>(null);
  useEffect(() => {
    if (!msg) return;
    const timer = setTimeout(() => setMsg(null), msg.k === "error" || msg.k === "warn" ? 8000 : 4500);
    return () => clearTimeout(timer);
  }, [msg]);
  const testBusy = !!testJob && !TEST_DONE.has(testJob.status);
  useEffect(() => {
    const id = testJob?.id;
    if (!id || TEST_DONE.has(testJob!.status)) return;
    let stop = false;
    const started = Date.now();
    const tick = async () => {
      const { data } = await supabase().from("print_jobs").select("status,last_error_code").eq("id", id).maybeSingle();
      if (stop) return;
      const j = data as { status: string; last_error_code: string | null } | null;
      if (j) setTestJob({ id, status: j.status, error: j.last_error_code });
      if (!j || !TEST_DONE.has(j.status)) {
        if (Date.now() - started > 120_000) setTestJob({ id, status: "unknown", error: "no_agent_response" });
        else timer = setTimeout(tick, 2000);
      }
    };
    let timer = setTimeout(tick, 1500);
    return () => { stop = true; clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testJob?.id]);
  async function sendTest() {
    if (!org || testBusy) return;
    const printerId = testPrinter || printers[0]?.id;
    if (!printerId) return;
    if (!parsed.success) return setMsg({ k: "error", t: "Fix the problems shown below the slip first, then test print." });
    const vals: Record<string, string> = {};
    for (const [k, v] of Object.entries(view)) if (typeof v === "string" && v) vals[k] = v;
    setTestJob({ status: "sending" });
    const { data, error } = await supabase().rpc("enqueue_test_print", {
      p_org: org.organization_id, p_printer: printerId,
      p_layout: LayoutSchema.parse({ ...parsed.data, reprintMark: autoReprintMark(parsed.data.printArea) }) as never,
      p_values: vals as never, p_idem: newIdemKey(),
    });
    if (error) { setTestJob(null); return setMsg({ k: "error", t: error.message.includes("printer_unavailable") ? "That printer's Print Agent is switched off or paused. Check the printer PC." : friendlyError(error) }); }
    setTestJob({ id: (data as { id: string }).id, status: "queued" });
  }

  /** Changing the paper keeps the printing area inside it, and re-fits the full design if that is what is printed. */
  function setPaper(pw: number, ph: number) {
    pw = clamp(Math.round(pw * 10) / 10, 20, 500); ph = clamp(Math.round(ph * 10) / 10, 20, 500);
    let note: string | null = null;
    edit((l) => {
      let next: Layout = { ...l, paper: { w: pw, h: ph } };
      if (l.mode === "blank" && l.decor.some((d) => d.id === "frame")) {
        try { next = applyFullDesign(next, { title: org?.display_name ?? "" }); } catch (e) { note = e instanceof DesignError ? e.message : null; }
      }
      const a = next.printArea;
      const x = Math.min(a.x, Math.max(0, pw - 10)), y = Math.min(a.y, Math.max(0, ph - 10));
      const area = { x, y, w: Math.min(a.w, pw - x), h: Math.min(a.h, ph - y) };
      // a smaller paper shrinks the layout with it: boxes scale down with the printing area and always stay inside it
      const sx = Math.min(1, area.w / next.printArea.w), sy = Math.min(1, area.h / next.printArea.h);
      const scaled = sx < 1 || sy < 1 ? { ...next, fields: next.fields.map((f) => ({ ...f, x: f.x * sx, w: f.w * sx, y: f.y * sy, h: f.h * sy })) } : next;
      return cropFrom(scaled, area, true);
    });
    setSel(null);
    setMsg(note ? { k: "warn", t: note } : null);
  }
  /** Typing a paper size: applied on Enter / leaving the box, so a number like 150 can be typed freely. */
  function commitPaper(side: "w" | "h", v: string) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return setMsg({ k: "error", t: "Enter the paper size in millimetres, for example 210." });
    const c = clamp(Math.round(n * 10) / 10, 20, 500);
    if (side === "w") setPaper(c, layout.paper.h); else setPaper(layout.paper.w, c);
    if (c !== n) setMsg({ k: "warn", t: `Paper size must be between 20 and 500 mm
Using ${c} mm.` });
  }
  /** "Fit to screen": shows the whole paper, and makes the paper the same shape as the uploaded ticket image (original proportions, never stretched). */
  function fitToImage() {
    setZoom(1);
    if (!underlay) return setMsg({ k: "info", t: "Paper fitted to the screen\nUpload your ticket image in Settings → Ticket design to also match the paper size to it." });
    const img = new Image();
    img.onload = () => {
      const a = img.naturalWidth / img.naturalHeight;
      if (!Number.isFinite(a) || a <= 0) return;
      // a known paper size with the same shape (either way round), else keep the longer side and follow the image's shape
      const known = PAPER_SIZES.flatMap((q) => [{ w: q.w, h: q.h }, { w: q.h, h: q.w }]).filter((q) => Math.abs(q.w / q.h - a) / a < 0.02).sort((x, y) => Math.abs(x.w / x.h - a) - Math.abs(y.w / y.h - a))[0];
      const L = Math.max(layout.paper.w, layout.paper.h);
      const size = known ?? (a >= 1 ? { w: L, h: Math.round((L / a) * 10) / 10 } : { w: Math.round(L * a * 10) / 10, h: L });
      setPaper(size.w, size.h);
      setMsg({ k: "ok", t: `Paper set to ${size.w} × ${size.h} mm
Same shape as your ticket image.` });
    };
    img.onerror = () => setMsg({ k: "error", t: "Could not read the ticket image." });
    img.src = underlay;
  }
  const fitArea = (margin: number) => edit((l) => ({ ...l, printArea: { x: margin, y: margin, w: Math.max(10, l.paper.w - 2 * margin), h: Math.max(10, l.paper.h - 2 * margin) } }));
  const centreArea = () => edit((l) => ({ ...l, printArea: { ...l.printArea, x: Math.max(0, (l.paper.w - l.printArea.w) / 2), y: Math.max(0, (l.paper.h - l.printArea.h) / 2) } }));
  /** Scales all field positions so that every field sits inside the printing area (keeps their arrangement). */
  const fitFieldsToArea = () => edit((l) => {
    const vis = l.fields.filter((f) => f.visible);
    const right = Math.max(1, ...vis.map((f) => f.x + f.w)), bottom = Math.max(1, ...vis.map((f) => f.y + f.h));
    const sx = Math.min(1, l.printArea.w / right), sy = Math.min(1, l.printArea.h / bottom);
    const r1 = (n: number) => Math.round(n * 10) / 10;
    return { ...l, fields: l.fields.map((f) => ({ ...f, x: r1(f.x * sx), w: r1(f.w * sx), y: r1(f.y * sy), h: r1(f.h * sy) })) };
  });
  const fieldsOutside = issues.some((i) => /Field exceeds printable area/.test(i));
  function chooseWhatToPrint(mode: "preprinted" | "blank") {
    if (mode === "preprinted") return edit((l) => ({ ...l, mode: "preprinted" }));
    try { edit((l) => applyFullDesign(l, { title: org?.display_name ?? "" })); setMsg({ k: "ok", t: "Full design applied: header and footer are drawn around the printing area. You can still edit every element." }); }
    catch (e) { setMsg({ k: "warn", t: e instanceof DesignError ? e.message : "Could not apply the design." }); }
  }
  const setArea = (k: "x" | "y" | "w" | "h", v: string) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    edit((l) => {
      const a = { ...l.printArea, [k]: n };
      const x = clamp(a.x, 0, l.paper.w - 20), y = clamp(a.y, 0, l.paper.h - 10);
      return cropFrom(l, { x, y, w: clamp(a.w, 20, l.paper.w - x), h: clamp(a.h, 10, l.paper.h - y) }, true);
    });
  };
  const paperPreset = matchPaperSize(layout.paper.w, layout.paper.h);
  const num = (label: string, v: number, on: (s: string) => void, step = 0.5) => (
    <div><label className="label text-xs">{label}</label><input className="field !min-h-[40px]" type="number" step={step} value={v} onChange={(e) => on(e.target.value)} /></div>
  );

  const status = tplId ? (dirty ? { t: "Unsaved changes", c: "bg-amber-100 text-amber-900" } : publishedVersion ? { t: `Published v${publishedVersion}`, c: "bg-green-100 text-green-800" } : { t: "Draft (not published)", c: "bg-slate-100 text-slate-700" }) : { t: "New — not saved", c: "bg-amber-100 text-amber-900" };

  const sizes = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32];
  const q = search.trim().toLowerCase();
  const shownFields = layout.fields.filter((f) => !q || kl(f.key).toLowerCase().includes(q) || (view[f.key] ?? "").toLowerCase().includes(q));
  const paperPx = { w: layout.paper.w * s, h: layout.paper.h * s };
  const iconBtn = "grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-slate-200 bg-white text-navy hover:bg-slate-50 disabled:opacity-40";

  return (
    <div onKeyDown={onKey} className="flex flex-col bg-slate-50 lg:min-h-0 lg:flex-1">
      {/* top bar */}
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <button type="button" className={iconBtn} onClick={openMenu} aria-label="Open the side menu" title="Open the side menu">
          <svg aria-hidden width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 5h14M3 10h14M3 15h14" /></svg>
        </button>
        <Link href="/settings" className={iconBtn} aria-label="Back to Settings" title="Back to Settings">
          <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 3 5 8l5 5" /></svg>
        </Link>
        <div className="min-w-0 flex-1">
          <p className="hidden truncate text-xs text-slate-600 sm:block"><Link href="/settings" className="hover:underline">Settings</Link> › Receipt layout</p>
          <h1 className="truncate text-lg font-bold leading-tight text-navy">Receipt Layout Editor</h1>
          <p className="truncate text-xs text-slate-600">Paper {layout.paper.w} × {layout.paper.h} mm</p>
        </div>
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
          {(dirty || !publishedVersion || !tplId) && <span className={`badge ${status.c}`}>{status.t}</span>}
          <button className="btn-ghost !min-h-[40px] !rounded-xl" disabled={issues.length > 0} onClick={() => save(false)}>Save draft</button>
          <button className="btn-primary !min-h-[40px] !rounded-xl" disabled={issues.length > 0} onClick={() => save(true)}>Publish</button>
        </div>
      </header>
      {msg && (
        <div role={msg.k === "error" ? "alert" : "status"} aria-live={msg.k === "error" ? "assertive" : "polite"}
          className="ios-toast fixed left-1/2 top-4 z-[80] flex w-[min(92vw,460px)] -translate-x-1/2 items-start gap-3 rounded-2xl bg-white/95 p-3 pr-2 shadow-[0_12px_40px_rgba(15,30,50,0.25)] ring-1 ring-black/5 backdrop-blur-xl">
          <span aria-hidden className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm font-bold text-white ${msg.k === "ok" ? "bg-brand-dark" : msg.k === "error" ? "bg-red-600" : msg.k === "warn" ? "bg-amber-500" : "bg-sky-600"}`}>{msg.k === "ok" ? "✓" : msg.k === "error" ? "!" : msg.k === "warn" ? "!" : "i"}</span>
          <div className="min-w-0 flex-1 py-0.5 text-sm">
            <p className="font-semibold text-navy">{msg.t.split("\n")[0]}</p>
            {msg.t.includes("\n") && <p className="mt-0.5 text-slate-600">{msg.t.split("\n").slice(1).join(" ")}</p>}
          </div>
          <button type="button" className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-600 hover:bg-slate-100" onClick={() => setMsg(null)} aria-label="Dismiss">✕</button>
        </div>
      )}

      <div className="flex flex-col lg:min-h-0 lg:flex-1 lg:flex-row">
        {/* CENTRE: edit bar (top) · dotted screen · view controls (bottom) */}
        <div className="flex min-w-0 flex-col lg:min-h-0 lg:flex-1">
          <div role="toolbar" aria-label={field ? `Edit ${kl(field.key)}` : "Edit the selected box"} className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2 [scrollbar-width:thin]">
            {field ? (
              <>
                <Select aria-label="Choose a field" className="field !min-h-[40px] !w-auto min-w-[160px] shrink-0 !rounded-xl" value={field.id} onChange={(e) => setSel(e.target.value)}>
                  {layout.fields.map((x) => <option key={x.id} value={x.id}>{kl(x.key)}</option>)}
                </Select>
                <Toggle on={field.font.bold} label="Bold" onClick={() => patchFont(field.id, { bold: !field.font.bold })}><b>B</b></Toggle>
                <Toggle on={!!field.font.italic} label="Italic" onClick={() => patchFont(field.id, { italic: !field.font.italic })}><i>I</i></Toggle>
                <Toggle on={!!field.font.underline} label="Underline" onClick={() => patchFont(field.id, { underline: !field.font.underline })}><u>U</u></Toggle>
                <Select aria-label="Text size (pt)" className="field !min-h-[40px] !w-[84px] shrink-0 !rounded-xl" value={String(field.font.maxPt)} onChange={(e) => setSize(field, Number(e.target.value))}>
                  {[...new Set([...sizes, field.font.maxPt])].sort((a, b) => a - b).map((x) => <option key={x} value={String(x)}>{x}</option>)}
                </Select>
                <div role="radiogroup" aria-label="Alignment" className="inline-flex shrink-0 overflow-hidden rounded-xl border border-slate-200">
                  {([["left", "M2 4h12M2 8h8M2 12h10"], ["center", "M2 4h12M4 8h8M3 12h10"], ["right", "M2 4h12M6 8h8M4 12h10"]] as ["left" | "center" | "right", string][]).map(([v, d]) => (
                    <button key={v} type="button" role="radio" aria-checked={field.align === v} aria-label={`Align ${v}`} title={`Align ${v}`} onClick={() => patch(field.id, { align: v })}
                      className={`grid h-10 w-10 place-items-center ${field.align === v ? "bg-navy text-white" : "bg-white text-navy hover:bg-slate-50"}`}>
                      <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d={d} /></svg>
                    </button>
                  ))}
                </div>
                <Toggle on={field.showLabel} label="Print a heading before the value" title="Heading before the value" onClick={() => patch(field.id, { showLabel: !field.showLabel, labelEn: field.labelEn ?? (dl(field.key).en || undefined), labelHi: field.labelHi ?? (dl(field.key).hi || undefined) })}>Aa</Toggle>
                {field.showLabel && (
                  <Select aria-label="Heading language" className="field !min-h-[40px] !w-[96px] shrink-0 !rounded-xl" value={field.labelLang ?? layout.labelLang} onChange={(e) => patch(field.id, { labelLang: e.target.value as "en" | "hi" })}>
                    <option value="en">EN</option><option value="hi">हिन्दी</option>
                  </Select>
                )}
                <button type="button" className="btn-ghost !min-h-[40px] shrink-0 !rounded-xl !px-3" title="Fit the box to its text (or double-click the box)" onClick={() => autoFit(field.id)}>⤢ Fit</button>
                <button type="button" className="btn-danger !min-h-[40px] shrink-0 !rounded-xl !px-3" title="Remove from the slip" aria-label="Remove this field" onClick={() => removeField(field)}>
                  <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4" /></svg>
                </button>
              </>
            ) : (
              <p className="whitespace-nowrap px-1 text-sm text-slate-600">Click a box on the slip to edit it. Drag the <b className="text-brand-dark">green frame</b> edges or corners to change the printing area.</p>
            )}
          </div>

          <div className="relative min-h-[360px] flex-1 lg:min-h-[200px]">
            <div ref={wrap} className={`absolute inset-0 ${zoom > 1 ? "overflow-auto" : "overflow-hidden"} bg-slate-100 [background-image:radial-gradient(#cbd5e1_1px,transparent_1px)] [background-size:18px_18px]`} onPointerDown={() => setSel(null)}>
              <div className="flex min-h-full min-w-full p-[14px]">
                <div className={`relative m-auto ${boxReady ? "" : "invisible"}`} style={{ width: paperPx.w, height: paperPx.h }}>
                  <div className="relative select-none overflow-hidden bg-white shadow-[0_8px_30px_rgba(15,30,50,0.18)] ring-1 ring-slate-300" style={{ width: layout.paper.w * s, height: layout.paper.h * s, touchAction: "none" }}
                onPointerMove={move} onPointerUp={() => { drag.current = null; areaDrag.current = null; }} onPointerCancel={() => { drag.current = null; areaDrag.current = null; }} onPointerDown={(e) => { e.stopPropagation(); setSel(null); }} aria-label="Paper preview">
                {grid && <div aria-hidden className="pointer-events-none absolute inset-0" style={{ backgroundImage: "linear-gradient(to right, rgba(25,185,87,0.18) 1px, transparent 1px), linear-gradient(to bottom, rgba(25,185,87,0.18) 1px, transparent 1px)", backgroundSize: `${5 * s}px ${5 * s}px`, backgroundPosition: `${ox * s}px ${oy * s}px` }} />}
                  {underlay && /* eslint-disable-next-line @next/next/no-img-element */ <img src={underlay} alt="" className="pointer-events-none absolute inset-0 h-full w-full object-contain opacity-30" fetchPriority="high" decoding="async" />}
                  <div className="pointer-events-none absolute border-2 border-dashed border-brand" style={{ left: ox * s, top: oy * s, width: layout.printArea.w * s, height: layout.printArea.h * s }}>
                    <button type="button" onPointerDown={(e) => areaDown(e, "move")} title="Drag to move the printing area"
                      className="pointer-events-auto absolute flex min-h-[24px] cursor-move items-center gap-1 whitespace-nowrap rounded-md bg-brand-dark px-1.5 py-1 text-[10px] font-semibold text-white shadow"
                      style={oy * s > 32 ? { left: 22, top: -30 } : { left: 22, top: 4 }}><span aria-hidden>✥</span> Printing area {layout.printArea.w}×{layout.printArea.h} mm</button>
                    {([["n", "ns-resize", { left: 12, right: 12, top: -6, height: 12 }], ["s", "ns-resize", { left: 12, right: 12, bottom: -6, height: 12 }], ["w", "ew-resize", { top: 12, bottom: 12, left: -6, width: 12 }], ["e", "ew-resize", { top: 12, bottom: 12, right: -6, width: 12 }]] as [string, string, React.CSSProperties][]).map(([m, cur, st]) => (
                      <div key={"band" + m} aria-hidden onPointerDown={(e) => areaDown(e, m)} className="pointer-events-auto absolute" style={{ ...st, cursor: cur }} />
                    ))}
                    {([["n", "ns-resize", { left: "50%", top: 0 }], ["s", "ns-resize", { left: "50%", top: "100%" }], ["w", "ew-resize", { left: 0, top: "50%" }], ["e", "ew-resize", { left: "100%", top: "50%" }], ["nw", "nwse-resize", { left: 0, top: 0 }], ["ne", "nesw-resize", { left: "100%", top: 0 }], ["sw", "nesw-resize", { left: 0, top: "100%" }], ["se", "nwse-resize", { left: "100%", top: "100%" }]] as [string, string, React.CSSProperties][]).map(([m, cur, st]) => (
                      <div key={m} aria-hidden onPointerDown={(e) => areaDown(e, m)} className="pointer-events-auto absolute grid h-6 w-6 -translate-x-1/2 -translate-y-1/2 place-items-center" style={{ ...st, cursor: cur }}>
                        <span className="h-3.5 w-3.5 rounded-[4px] border-2 border-brand-dark bg-white shadow" />
                      </div>
                    ))}
                  </div>
                  {layout.mode === "blank" && layout.decor.map((d) => {
                    const px = (layout.offset.x + d.x) * s, py = (layout.offset.y + d.y) * s;
                    if (d.type === "text") return <div key={d.id} className="pointer-events-none absolute overflow-hidden whitespace-pre text-black" style={{ left: px, top: py, width: d.w * s, height: d.h * s, fontFamily: `'${d.font.family}','Nirmala UI',monospace`, fontSize: d.font.pt * PT_TO_MM * s, fontWeight: d.font.bold ? 700 : 400, fontStyle: d.font.italic ? "italic" : "normal", textDecoration: d.font.underline ? "underline" : "none", textAlign: d.align, lineHeight: 1.1 }}>{d.text}</div>;
                    if (d.type === "line") { const horiz = d.h <= d.w; return <div key={d.id} className="pointer-events-none absolute" style={{ left: px, top: py, width: horiz ? d.w * s : 0, height: horiz ? 0 : d.h * s, [horiz ? "borderTop" : "borderLeft"]: `${Math.max(1, d.weight * s)}px solid #000` }} />; }
                    return <div key={d.id} className="pointer-events-none absolute box-border" style={{ left: px, top: py, width: d.w * s, height: d.h * s, border: `${Math.max(1, d.weight * s)}px solid #000` }} />;
                  })}
                  {layout.fields.filter((f) => f.visible).map((f) => {
                    const fit = fits.get(f.id);
                    const bad = fit && (fit.overflow || fit.belowFloor);
                    return (
                      <div key={f.id} role="button" tabIndex={0} aria-label={view[f.key] ? `${kl(f.key)}: ${textOf(f, view[f.key]!)}` : kl(f.key)} onPointerDown={(e) => down(e, f, "move")} onFocus={() => setSel(f.id)} onDoubleClick={() => autoFit(f.id)}
                        className={`absolute cursor-move overflow-hidden border ${sel === f.id ? "border-2 border-navy bg-navy/10" : bad ? "border-red-500 bg-red-50/60" : "border-dashed border-slate-400"}`}
                        style={{ left: (ox + f.x) * s, top: (oy + f.y) * s, width: f.w * s, height: f.h * s }}>
                        {fit ? (
                          <div style={{ fontFamily: `'${f.font.family}','Nirmala UI',monospace`, fontSize: fit.pt * PT_TO_MM * s, lineHeight: `${fit.pt * PT_TO_MM * f.lineHeight * s}px`, fontWeight: f.font.bold ? 700 : 400, fontStyle: f.font.italic ? "italic" : "normal", textDecoration: f.font.underline ? "underline" : "none", textAlign: f.align, whiteSpace: "pre", color: "#000" }}>{fit.lines.join("\n")}</div>
                        ) : <span className="text-[10px] text-slate-500">{kl(f.key)}</span>}
                        {sel === f.id && <span onPointerDown={(e) => down(e, f, "resize")} className="absolute bottom-0 right-0 h-3 w-3 cursor-nwse-resize bg-navy" aria-label="Resize" />}
                      </div>
                    );
                  })}
                </div>
                </div>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-t border-slate-200 bg-white px-3 py-2">
            <div className="flex items-center gap-1">
              <button type="button" className={iconBtn} onClick={undo} disabled={past.current.length === 0} aria-label="Undo" title="Undo (Ctrl+Z)">
                <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3 2 6l3 3" /><path d="M2 6h7a4 4 0 0 1 0 8H6" /></svg>
              </button>
              <button type="button" className={iconBtn} onClick={redo} disabled={future.current.length === 0} aria-label="Redo" title="Redo (Ctrl+Y)">
                <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m11 3 3 3-3 3" /><path d="M14 6H7a4 4 0 0 0 0 8h3" /></svg>
              </button>
            </div>
            <span className="h-6 w-px bg-slate-200" />
            <div className="flex items-center gap-1">
              <button type="button" className={iconBtn} onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10))} aria-label="Zoom out" title="Zoom out">−</button>
              <button type="button" className="min-w-[52px] rounded-lg px-1 text-sm font-semibold text-navy hover:bg-slate-100" style={{ minHeight: 36 }} onClick={() => setZoom(1)} title="Back to 100%">{Math.round(zoom * 100)}%</button>
              <button type="button" className={iconBtn} onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.1) * 10) / 10))} aria-label="Zoom in" title="Zoom in">＋</button>
              <button type="button" className={iconBtn} onClick={fitToImage} aria-label="Fit to screen: match the paper to the ticket image" title="Fit to screen — sets the paper size to your ticket image">
                <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2 6V3h3M14 6V3h-3M2 10v3h3M14 10v3h-3" /></svg>
              </button>
              <button type="button" className={`${iconBtn} ${grid ? "!border-navy !bg-navy !text-white" : ""}`} aria-pressed={grid} onClick={() => setGrid((g) => !g)} aria-label="Show a 5 mm grid" title="Show a 5 mm grid">
                <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2 2h12v12H2zM2 6h12M2 10h12M6 2v12M10 2v12" /></svg>
              </button>
            </div>
            <span className="hidden h-6 w-px bg-slate-200 sm:block" />
            <div className="flex items-center gap-2">
              <span className="hidden text-sm text-slate-600 sm:inline">Preview</span>
              <Seg label="Slip to preview" value={slip} onChange={setSlip} options={[["closed", "Closing slip"], ["open", "Opening slip"]]} />
            </div>
          </div>

          {(issues.length > 0 || warnings.length > 0) && (
            <div className="max-h-36 shrink-0 space-y-2 overflow-y-auto border-t border-slate-200 bg-white p-3">
              {issues.map((i) => <Alert key={i}>{i}</Alert>)}
              {warnings.map((w) => <Alert key={w} kind="warn">{w}</Alert>)}
              {warnings.length > 0 && <button type="button" className="btn-primary w-full !min-h-[44px] !rounded-xl" onClick={fixAll}>✨ Fix automatically: fit every box to its text</button>}
            </div>
          )}
        </div>

        {/* RIGHT: fields / paper / more */}
        <aside aria-label="Editor panel" className="flex w-full flex-col border-t border-slate-200 bg-white lg:min-h-0 lg:w-[400px] lg:shrink-0 lg:border-l lg:border-t-0">
          <div role="tablist" aria-label="Designer sections" className="grid shrink-0 grid-cols-2 border-b border-slate-200">
            {([["fields", "Fields"], ["paper", "Paper"]] as [Tab, string][]).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={`min-h-[48px] text-sm font-semibold ${tab === k ? "border-b-2 border-brand text-navy" : "text-slate-600 hover:bg-slate-50"}`}>{label}</button>
            ))}
          </div>
          <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
            {tab === "fields" && (
              <div className="space-y-4 p-4">
                <div className="relative">
                  <svg aria-hidden width="16" height="16" viewBox="0 0 20 20" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="9" cy="9" r="6" /><path d="m14 14 4 4" /></svg>
                  <input className="field !rounded-xl !pl-9" type="search" aria-label="Search fields" placeholder="Search fields…" value={search} onChange={(e) => setSearch(e.target.value)} />
                </div>
                <div>
                  <p className="label">Headings printed before each value</p>
                  <Seg label="Headings" value={headingMode} onChange={setHeadings} options={[["off", "None"], ["en", "English"], ["hi", "हिन्दी"]]} />
                  <p className="mt-1 text-xs text-slate-600">Example: <b>{headingMode === "hi" ? DEFAULT_LABELS.vehicle.hi : headingMode === "en" ? DEFAULT_LABELS.vehicle.en : "(no heading)"}</b> RJ14GD9158. Choose “None” when the heading is already printed on your form. You can edit each heading below.</p>
                </div>

                <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {shownFields.map((f) => (
                    <li key={f.id} className={sel === f.id ? "bg-brand-50" : ""}>
                      <div className="flex items-center gap-2 px-3 py-2">
                        <button type="button" className="h-9 w-9 rounded border border-slate-300 text-base" aria-pressed={f.visible} aria-label={`${f.visible ? "Hide" : "Show"} ${kl(f.key)}`} title={f.visible ? "Printed — click to hide" : "Hidden — click to show"} onClick={() => patch(f.id, { visible: !f.visible })}>{f.visible ? "👁" : "🚫"}</button>
                        <button type="button" className={`min-h-[40px] flex-1 text-left text-sm ${f.visible ? "text-navy" : "text-slate-500 line-through"}`} onClick={() => setSel(sel === f.id ? null : f.id)} aria-expanded={sel === f.id}>
                          <b>{kl(f.key)}</b> <span className="text-xs text-slate-600">{values[f.key] ?? ""}</span>
                        </button>
                        {typed(f.key) && <button type="button" aria-pressed={askOn(f)} title="Ask this on the Weighment form" onClick={() => patch(f.id, { ask: !askOn(f), ...(askOn(f) ? { required: false } : {}) })} className={`whitespace-nowrap rounded-full border px-2 py-1 text-xs font-semibold ${askOn(f) ? "border-brand bg-brand-50 text-brand-dark" : "border-slate-300 text-slate-600"}`}>{askOn(f) ? (f.required ? "Asked ✱" : "Asked") : "Not asked"}</button>}
                      </div>

                      {sel === f.id && (
                        <div className="space-y-3 border-t border-brand/30 bg-white px-3 py-3">
                          <div>
                            {!f.showLabel && <p className="text-xs text-slate-600">No heading is printed for this field. Switch on “Aa” in the bar above the slip to print one.</p>}
                            {f.showLabel && (
                              <div className="grid gap-2 sm:grid-cols-2">
                                <div><label className="label text-xs">Heading in English {(f.labelLang ?? layout.labelLang) === "en" && <span className="badge bg-brand-50 text-brand-dark">printing</span>}</label>
                                  <input className="field !min-h-[40px]" maxLength={40} value={f.labelEn ?? ""} onChange={(e) => patch(f.id, { labelEn: e.target.value })} /></div>
                                <div><label className="label text-xs">हिन्दी में शीर्षक {(f.labelLang ?? layout.labelLang) === "hi" && <span className="badge bg-brand-50 text-brand-dark">printing</span>}</label>
                                  <input className="field !min-h-[40px]" maxLength={40} value={f.labelHi ?? ""} onChange={(e) => patch(f.id, { labelHi: e.target.value })} /></div>
                              </div>
                            )}
                          </div>

                          {typed(f.key) ? (
                            <div className="rounded-lg bg-slate-50 p-2">
                              <label className="flex min-h-[40px] items-center gap-2 text-sm font-medium"><input type="checkbox" className="h-5 w-5" checked={askOn(f)} onChange={(e) => patch(f.id, { ask: e.target.checked, ...(e.target.checked ? {} : { required: false }) })} />Ask this on the Weighment form</label>
                              {askOn(f) && <label className="flex min-h-[40px] items-center gap-2 pl-7 text-sm"><input type="checkbox" className="h-5 w-5" checked={f.required === true} onChange={(e) => patch(f.id, { required: e.target.checked })} />Operator <b>must</b> fill it in <span className="text-xs text-slate-600">(otherwise optional)</span></label>}
                              <p className="pl-1 text-xs text-slate-600">Switch it off and the form stops asking (the field can still print).</p>
                            </div>
                          ) : null}
                          <div className="grid grid-cols-2 gap-2">
                            <div><label className="label text-xs">Font</label>
                              <Select className="field !min-h-[40px]" value={f.font.family} onChange={(e) => patchFont(f.id, { family: e.target.value as FontFamily })}>{Object.keys(FONT_FAMILIES).map((x) => <option key={x}>{x}</option>)}</Select></div>
                            <div><label className="label text-xs">If the text is too long</label>
                              <Select className="field !min-h-[40px]" value={f.fit} onChange={(e) => patch(f.id, { fit: e.target.value as LayoutField["fit"] })}><option value="shrink">Make it smaller</option><option value="wrap">Wrap to more lines</option><option value="clip">Cut it off</option></Select></div>
                            {f.fit === "wrap" && num("Maximum lines", f.maxLines, (v) => patch(f.id, { maxLines: clamp(Math.round(Number(v)) || 1, 1, 6) }), 1)}
                          </div>

                          <details>
                            <summary className="cursor-pointer text-sm font-medium text-navy">Exact position &amp; size (mm)</summary>
                            <div className="mt-2 grid grid-cols-2 gap-2">
                              {num("From left", f.x, (v) => patch(f.id, { x: Number(v) || 0 }))}{num("From top", f.y, (v) => patch(f.id, { y: Number(v) || 0 }))}
                              {num("Width", f.w, (v) => patch(f.id, { w: Number(v) || 1 }))}{num("Height", f.h, (v) => patch(f.id, { h: Number(v) || 1 }))}
                              {num("Smallest text (pt)", f.font.minPt, (v) => patchFont(f.id, { minPt: clamp(Number(v) || 5, 5, f.font.maxPt) }))}
                            </div>
                          </details>
                          <button className="btn-danger !min-h-[40px]" onClick={() => removeField(f)}>Remove this field</button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>

                {addOpen && <div className="rounded-xl border border-brand/30 bg-brand-50/30 p-3">
                  <p className="label text-xs">Add to the slip</p>
                  <div className="flex flex-wrap gap-2">
                    {unused.map((k) => <button key={k} type="button" className="rounded-full border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-navy hover:bg-slate-50" title="Put it back on the slip" onClick={() => addField(k)}>＋ {kl(k)}</button>)}
                    <button type="button" className="rounded-full border border-brand bg-brand-50 px-3 py-2 text-sm font-semibold text-brand-dark" onClick={() => setNewField({ en: "", hi: "", kind: "text", required: false })}>＋ New field…</button>
                  </div>
                  {unused.length === 0 && <p className="mt-1 text-xs text-slate-600">Fields you remove from the slip show up here so you can put them back. Use “New field…” for anything else you want to collect (driver name, challan no. …).</p>}
                  {newField && (
                    <div className="mt-2 space-y-2 rounded-lg border border-brand/40 bg-brand-50/40 p-3">
                      <p className="text-sm font-semibold text-navy">New field</p>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div><label className="label text-xs" htmlFor="nf-en">Name (English)</label><input id="nf-en" className="field !min-h-[40px]" maxLength={40} value={newField.en} onChange={(e) => setNewField({ ...newField, en: e.target.value })} placeholder="Driver name" /></div>
                        <div><label className="label text-xs" htmlFor="nf-hi">नाम (हिन्दी, optional)</label><input id="nf-hi" className="field !min-h-[40px]" maxLength={40} value={newField.hi} onChange={(e) => setNewField({ ...newField, hi: e.target.value })} placeholder="चालक का नाम" /></div>
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <Seg label="Field type" value={newField.kind} onChange={(v) => setNewField({ ...newField, kind: v })} options={[["text", "Text"], ["number", "Number"]]} />
                        <label className="flex min-h-[40px] items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={newField.required} onChange={(e) => setNewField({ ...newField, required: e.target.checked })} />Operator must fill it in</label>
                      </div>
                      <div className="flex gap-2"><button className="btn-primary !min-h-[40px]" onClick={() => void createField()}>Add this field</button><button className="btn-ghost !min-h-[40px]" onClick={() => setNewField(null)}>Cancel</button></div>
                      <p className="text-xs text-slate-600">The Weighment form asks for it automatically (after you save/publish the layout), and it is saved with every entry and printed where you place it.</p>
                    </div>
                  )}
                </div>}
                {shownFields.length === 0 && <p className="text-sm text-slate-600">No field matches “{search}”.</p>}
                <div className="sticky bottom-0 -mx-4 -mb-4 border-t border-slate-200 bg-white/95 p-3 backdrop-blur">
                  <button type="button" className="btn-primary w-full !min-h-[46px] !rounded-xl" aria-expanded={addOpen} onClick={() => setAddOpen((o) => !o)}>{addOpen ? "Close" : "＋ New field"}</button>
                </div>
              </div>
            )}

            {tab === "paper" && (
              <div className="space-y-5 p-4">
                <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">Set this <b>once</b> for your printer and paper. It applies to every invoice, and you can change it here any time.</p>

                <section aria-labelledby="ps1">
                  <h3 id="ps1" className="mb-2 font-bold text-navy">1 · Paper size</h3>
                  <label className="label text-xs" htmlFor="psz">Ready-made sizes</label>
                  <Select id="psz" className="field" value={paperPreset?.id ?? "custom"} onChange={(e) => { const p = PAPER_SIZES.find((x) => x.id === e.target.value); if (p) setPaper(p.w, p.h); }}>
                    {PAPER_SIZES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                    <option value="custom">Custom size (type below)</option>
                  </Select>
                  <p className="mt-1 text-xs text-slate-600">{paperPreset ? paperPreset.note : "Custom size: type the exact width and height of your paper."}</p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <AreaNum label="Width (mm)" value={layout.paper.w} onCommit={(v) => commitPaper("w", v)} />
                    <AreaNum label="Height (mm)" value={layout.paper.h} onCommit={(v) => commitPaper("h", v)} />
                  </div>
                </section>

                <section aria-labelledby="ps2">
                  <h3 id="ps2" className="mb-2 font-bold text-navy">2 · What should be printed?</h3>
                  <div role="radiogroup" aria-label="What should be printed" className="grid gap-2">
                    {([["preprinted", "Only the details", "Your paper already has the header, logo and boxes printed on it. The software prints just the values (vehicle, weights, party…) inside the printing area."],
                       ["blank", "The full design", "Blank paper. The software prints the header, footer, frame and notes outside the printing area AND the details inside it."]] as ["preprinted" | "blank", string, string][]).map(([m, title, text]) => (
                      <button key={m} type="button" role="radio" aria-checked={layout.mode === m} onClick={() => chooseWhatToPrint(m)}
                        className={`rounded-lg border p-3 text-left ${layout.mode === m ? "border-brand bg-brand-50" : "border-slate-300 bg-white hover:bg-slate-50"}`}>
                        <span className="flex items-center gap-2 font-semibold text-navy"><span aria-hidden className={`inline-block h-4 w-4 rounded-full border-2 ${layout.mode === m ? "border-brand bg-brand-dark" : "border-slate-400"}`} />{title}</span>
                        <span className="mt-1 block text-sm text-slate-600">{text}</span>
                      </button>
                    ))}
                  </div>
                  {layout.mode === "blank" && (
                    <div className="mt-2 space-y-2">
                      <div className="space-y-2 rounded-lg bg-slate-50 p-3">
                        <p className="text-sm font-semibold text-navy">Header &amp; footer text</p>
                        <p className="text-xs text-slate-600">Printed around the printing area. Leave a line empty to print nothing there.</p>
                        {HEADER_TEXT.map(([id, label]) => {
                          const d = layout.decor.find((x) => x.id === id);
                          if (!d || d.type !== "text") return null;
                          return (
                            <div key={id}><label className="label text-xs">{label}</label>
                              <input className="field !min-h-[40px]" maxLength={120} value={d.text}
                                onChange={(e) => edit((l) => ({ ...l, decor: l.decor.map((x) => (x.id === id && x.type === "text" ? { ...x, text: e.target.value } : x)) }))} /></div>
                          );
                        })}
                      </div>
                      <button className="btn-ghost w-full" onClick={() => chooseWhatToPrint("blank")}>Re-fit the design to this paper size</button>
                      <p className="text-xs text-slate-600">The design (header, footer, notes, signature line) is scaled to the paper size you chose, and the printing area is placed between header and footer.</p>
                    </div>
                  )}
                </section>

                <section aria-labelledby="ps3">
                  <h3 id="ps3" className="mb-1 font-bold text-navy">3 · Printing area</h3>
                  <p className="mb-2 text-xs text-slate-600">Only this part is filled with the details (the green dashed frame on the slip). <b>Drag its edges or corners on the slip</b> to crop it, or its green tab to move it. {layout.mode === "blank" ? "With the full design it sits between header and footer; you can still change it." : "Match it to the empty box on your pre-printed paper."}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <AreaNum label="Width (mm)" value={layout.printArea.w} onCommit={(v) => setArea("w", v)} /><AreaNum label="Height (mm)" value={layout.printArea.h} onCommit={(v) => setArea("h", v)} />
                    <AreaNum label="From left edge (mm)" value={layout.printArea.x} onCommit={(v) => setArea("x", v)} /><AreaNum label="From top edge (mm)" value={layout.printArea.y} onCommit={(v) => setArea("y", v)} />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button className="btn-ghost !min-h-[40px]" onClick={() => fitArea(5)}>Whole paper, 5 mm margin</button>
                    <button className="btn-ghost !min-h-[40px]" onClick={centreArea}>Centre it</button>
                  </div>
                  {fieldsOutside && <button className="btn-ghost mt-2 w-full !min-h-[40px]" onClick={fitFieldsToArea}>Some fields are outside the printing area — move them inside</button>}
                  <p className="mt-1 text-xs text-slate-600">Laser and inkjet printers cannot print the outer ~5 mm of the paper; dot-matrix can print closer to the edge.</p>
                </section>

                <ModeCard layout={layout} setLayout={edit} />

                <section className="rounded-lg border border-slate-200 p-3" aria-labelledby="ps5">
                  <h3 id="ps5" className="font-bold text-navy">Fine-tune</h3>
                  <p className="mb-2 text-xs text-slate-600">Moves everything if it prints slightly off. The printer’s own calibration (Settings → Printing) is added on top.</p>
                  <div className="grid grid-cols-2 gap-2">
                    {num("Right (+) / left (−) mm", layout.offset.x, (v) => edit((l) => ({ ...l, offset: { ...l.offset, x: Number(v) || 0 } })), 0.1)}
                    {num("Down (+) / up (−) mm", layout.offset.y, (v) => edit((l) => ({ ...l, offset: { ...l.offset, y: Number(v) || 0 } })), 0.1)}
                    {num("Smallest readable text (pt)", layout.legibilityFloorPt, (v) => edit((l) => ({ ...l, legibilityFloorPt: clamp(Number(v) || 8, 5, 14) })), 0.5)}
                  </div>
                </section>

                <section className="rounded-lg border border-slate-200 p-3" aria-labelledby="ps6">
                  <h3 id="ps6" className="font-bold text-navy">Test print</h3>
                  <p className="mb-2 text-xs text-slate-600">Prints this layout with the sample values on the real printer, through the Print Agent, so you can check the position, text size and paper. It works even before you publish.</p>
                  {printers.length === 0 ? (
                    <Alert kind="warn">No printer is connected yet. Pair the Print Agent and add a printer in Settings → Printing, then come back.</Alert>
                  ) : (
                    <div className="space-y-2">
                      {printers.length > 1 && (
                        <Select aria-label="Printer for the test print" className="field" value={testPrinter || printers[0]!.id} onChange={(e) => setTestPrinter(e.target.value)}>
                          {printers.map((p) => <option key={p.id} value={p.id}>{p.label || p.os_printer_name}</option>)}
                        </Select>
                      )}
                      <button className="btn-navy w-full" disabled={testBusy || !can("print.test")} onClick={() => void sendTest()}>{testBusy ? "Printing…" : "Test print"}</button>
                      {!can("print.test") && <p className="text-xs text-slate-600">You do not have permission to send test prints.</p>}
                      {testJob && (
                        <div aria-live="polite">
                          {testJob.status === "submitted_to_spooler" ? <Alert kind="ok">Sent to the printer’s Windows print queue. Check the paper.</Alert>
                            : testJob.status === "failed" ? <Alert>{PRINT_ERRORS[testJob.error ?? ""] ?? `The test print failed (${testJob.error ?? "unknown reason"}).`}</Alert>
                            : testJob.status === "unknown" ? <Alert kind="warn">{testJob.error === "no_agent_response" ? "The Print Agent did not respond. Is the printer PC switched on and the Print Agent running?" : "No confirmation was received. Check the paper before trying again."}</Alert>
                            : testJob.status === "routing_error" || testJob.status === "not_configured" ? <Alert>This printer is not available. Check Settings → Printing.</Alert>
                            : <Alert kind="info">{TEST_STEPS[testJob.status] ?? testJob.status}</Alert>}
                        </div>
                      )}
                    </div>
                  )}
                </section>
              </div>
            )}

          </div>
        </aside>
      </div>
    </div>
  );
}
