"use client";
/**
 * iOS-style dropdown and calendar controls used everywhere in the app (no native select or date pickers).
 * - Phones (< 640 px): a bottom sheet like an iOS action sheet / date picker sheet.
 * - Larger screens: a frosted popover under the field.
 * Keyboard: arrows, Enter, Esc, type-ahead. Screen readers: combobox + listbox / dialog roles.
 */
import { Children, Fragment, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { nowIstLocal } from "@/lib/format";

/* ---------- shared bits ---------- */

function useIsMobile() {
  const [m, setM] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(max-width: 639px)");
    const f = () => setM(q.matches);
    f(); q.addEventListener("change", f);
    return () => q.removeEventListener("change", f);
  }, []);
  return m;
}

const Chevrons = () => (
  <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" className="shrink-0 text-slate-500" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.5 5.5 7 2l3.5 3.5M3.5 8.5 7 12l3.5-3.5" />
  </svg>
);
const CalendarIcon = () => (
  <svg aria-hidden width="18" height="18" viewBox="0 0 20 20" className="shrink-0 text-slate-500" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4.5" width="14" height="12.5" rx="3" /><path d="M3 8.5h14M7 2.5v3M13 2.5v3" />
  </svg>
);
const Check = () => (
  <svg aria-hidden width="18" height="18" viewBox="0 0 18 18" className="shrink-0 text-brand" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 9.5 7.5 13.5 14.5 5" /></svg>
);

/** A floating layer: popover next to the trigger, or a bottom sheet on phones. */
function Layer({ open, onClose, anchor, mobile, title, width, children, onKeyDown, panelRef }: {
  open: boolean; onClose: () => void; anchor: HTMLElement | null; mobile: boolean; title: string; width?: number;
  children: ReactNode; onKeyDown?: (e: React.KeyboardEvent) => void; panelRef?: React.RefObject<HTMLDivElement>;
}) {
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; maxH: number; w: number } | null>(null);
  const own = useRef<HTMLDivElement>(null);
  const ref = panelRef ?? own;

  const place = useCallback(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = Math.max(r.width, width ?? 0);
    const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - w - 8));
    const below = window.innerHeight - r.bottom - 12, above = r.top - 12;
    if (below < 280 && above > below) setPos({ left, bottom: window.innerHeight - r.top + 6, maxH: Math.min(360, above - 6), w });
    else setPos({ left, top: r.bottom + 6, maxH: Math.min(360, below - 6), w });
  }, [anchor, width]);

  useLayoutEffect(() => { if (open && !mobile) place(); }, [open, mobile, place]);
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => { if (!mobile && !ref.current?.contains(e.target as Node)) onClose(); };
    const onDown = (e: PointerEvent) => { const t = e.target as Node; if (!ref.current?.contains(t) && !anchor?.contains(t)) onClose(); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); anchor?.focus(); } };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onEsc, true);
    if (mobile) document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("resize", place); window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("keydown", onEsc, true);
      if (mobile) document.body.style.overflow = "";
    };
  }, [open, mobile, anchor, onClose, place, ref]);

  if (!open || typeof document === "undefined") return null;
  if (mobile) {
    return createPortal(
      <div className="fixed inset-0 z-[70]" onKeyDown={onKeyDown}>
        <div className="ios-fade absolute inset-0 bg-black/35" onClick={onClose} />
        <div ref={ref} role="dialog" aria-modal="true" aria-label={title}
          className="ios-sheet absolute inset-x-0 bottom-0 mx-auto max-w-lg px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <div className="flex max-h-[80vh] flex-col overflow-hidden rounded-3xl bg-white/95 shadow-2xl backdrop-blur-xl">
            <div className="flex justify-center pt-2"><span className="h-1.5 w-10 rounded-full bg-slate-300" /></div>
            <div className="px-4 pb-1 pt-2 text-center text-[13px] font-semibold uppercase tracking-wide text-slate-600">{title}</div>
            {children}
          </div>
          <button type="button" onClick={onClose} className="mt-2 min-h-[52px] w-full rounded-2xl bg-white text-[17px] font-semibold text-brand-dark shadow-xl">Cancel</button>
        </div>
      </div>, document.body);
  }
  if (!pos) return null;
  return createPortal(
    <div ref={ref} role="dialog" aria-label={title} onKeyDown={onKeyDown}
      style={{ position: "fixed", left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.w, maxHeight: pos.maxH }}
      className="ios-pop z-[70] flex flex-col overflow-hidden rounded-2xl bg-white/95 shadow-[0_12px_40px_rgba(15,30,50,0.22)] ring-1 ring-black/5 backdrop-blur-xl">
      {children}
    </div>, document.body);
}

/* ---------- Select ---------- */

interface Opt { value: string; label: string; disabled?: boolean }
function textOf(n: ReactNode): string {
  return Children.toArray(n).map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : isValidElement(c) ? textOf((c.props as { children?: ReactNode }).children) : "")).join("");
}
function optionsOf(children: ReactNode): Opt[] {
  const out: Opt[] = [];
  const walk = (n: ReactNode) => Children.forEach(n, (c) => {
    if (!isValidElement(c)) return;
    const el = c as ReactElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>;
    if (el.type === "option") { const label = textOf(el.props.children); out.push({ value: String(el.props.value ?? label), label, disabled: el.props.disabled }); }
    else if (el.type === Fragment || el.type === "optgroup") walk(el.props.children);
  });
  walk(children);
  return out;
}

export interface SelectProps {
  id?: string; className?: string; value?: string | number | null; disabled?: boolean; required?: boolean; title?: string;
  "aria-label"?: string; placeholder?: string;
  onChange?: (e: { target: { value: string } }) => void;
  children?: ReactNode;
}

/** Drop-in replacement for a native select with <option> children. */
export function Select({ id, className = "field", value, disabled, onChange, children, placeholder, ...rest }: SelectProps) {
  const opts = useMemo(() => optionsOf(children), [children]);
  const cur = String(value ?? "");
  const sel = opts.find((o) => o.value === cur);
  const [open, setOpen] = useState(false);
  const [act, setAct] = useState(0);
  const mobile = useIsMobile();
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const type = useRef({ s: "", t: 0 });
  const uid = useId();
  const label = rest["aria-label"] ?? rest.title ?? (open && id ? document.querySelector(`label[for="${id}"]`)?.textContent ?? "Choose" : "Choose");

  const openIt = () => { if (disabled) return; setAct(Math.max(0, opts.findIndex((o) => o.value === cur))); setOpen(true); };
  const close = useCallback(() => setOpen(false), []);
  const pick = (o: Opt) => { if (o.disabled) return; onChange?.({ target: { value: o.value } }); setOpen(false); btn.current?.focus(); };

  useEffect(() => { if (open) list.current?.focus({ preventScroll: true }); }, [open, mobile]);
  useEffect(() => { if (open) list.current?.querySelector(`[data-i="${act}"]`)?.scrollIntoView({ block: "nearest" }); }, [open, act]);

  function listKey(e: React.KeyboardEvent) {
    const step = (d: number) => { let i = act; for (let n = 0; n < opts.length; n++) { i = (i + d + opts.length) % opts.length; if (!opts[i]?.disabled) break; } setAct(i); };
    if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
    else if (e.key === "Home") { e.preventDefault(); setAct(0); }
    else if (e.key === "End") { e.preventDefault(); setAct(opts.length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); const o = opts[act]; if (o) pick(o); }
    else if (e.key === "Tab") setOpen(false);
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      const now = Date.now(); const t = type.current;
      t.s = now - t.t > 700 ? e.key.toLowerCase() : t.s + e.key.toLowerCase(); t.t = now;
      const i = opts.findIndex((o) => o.label.toLowerCase().startsWith(t.s));
      if (i >= 0) setAct(i);
    }
  }

  return (
    <>
      <button ref={btn} id={id} type="button" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${uid}-l` : undefined}
        aria-label={rest["aria-label"] ? `${rest["aria-label"]}: ${sel?.label ?? placeholder ?? "Select…"}` : undefined} disabled={disabled}
        className={`${className} flex items-center justify-between gap-2 text-left ${disabled ? "opacity-60" : "active:bg-slate-50"} ${open ? "!border-brand ring-2 ring-brand/25" : ""}`}
        onClick={() => (open ? close() : openIt())}
        onKeyDown={(e) => { if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); openIt(); } }}>
        <span className={`truncate ${sel ? "" : "text-slate-500"}`}>{sel?.label ?? placeholder ?? "Select…"}</span>
        <Chevrons />
      </button>
      <Layer open={open} onClose={close} anchor={btn.current} mobile={mobile} title={label}>
        <ul ref={list} id={`${uid}-l`} role="listbox" tabIndex={-1} aria-label={label} aria-activedescendant={`${uid}-o${act}`} onKeyDown={listKey}
          className={`overflow-y-auto overscroll-contain outline-none ${mobile ? "max-h-[55vh]" : "max-h-[inherit]"}`}>
          {opts.map((o, i) => (
            <li key={o.value + i} id={`${uid}-o${i}`} data-i={i} role="option" aria-selected={o.value === cur} aria-disabled={o.disabled}
              onPointerEnter={() => setAct(i)} onClick={() => pick(o)}
              className={`flex cursor-pointer items-center justify-between gap-3 border-t border-slate-200/70 px-4 first:border-t-0 ${mobile ? "min-h-[52px] text-[17px]" : "min-h-[44px] text-[15px]"}
                ${o.disabled ? "text-slate-300" : "text-navy"} ${i === act ? "bg-slate-100/90" : ""} ${o.value === cur ? "font-semibold" : ""}`}>
              <span className="min-w-0 break-words py-2">{o.label}</span>
              {o.value === cur && <Check />}
            </li>
          ))}
        </ul>
      </Layer>
    </>
  );
}

/* ---------- Calendar / date / date-time ---------- */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW = ["S", "M", "T", "W", "T", "F", "S"];
const p2 = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${p2(m + 1)}-${p2(d)}`;
function parse(v: string | undefined | null): { y: number; m: number; d: number; hh: number; mm: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(v ?? "");
  return m ? { y: +m[1]!, m: +m[2]! - 1, d: +m[3]!, hh: +(m[4] ?? 0), mm: +(m[5] ?? 0) } : null;
}
const show = (v: string, time: boolean) => {
  const p = parse(v);
  if (!p) return "";
  return `${p2(p.d)} ${MONTHS[p.m]!.slice(0, 3)} ${p.y}${time ? `, ${p2(p.hh)}:${p2(p.mm)}` : ""}`;
};

function Calendar({ value, min, max, onPick }: { value: string; min?: string; max?: string; onPick: (date: string) => void }) {
  const today = nowIstLocal().slice(0, 10);
  const sel = parse(value) ?? parse(today)!;
  const [view, setView] = useState({ y: sel.y, m: sel.m });
  const [months, setMonths] = useState(false);
  const first = new Date(view.y, view.m, 1).getDay();
  const days = new Date(view.y, view.m + 1, 0).getDate();
  const minD = min?.slice(0, 10), maxD = max?.slice(0, 10);
  const go = (d: number) => setView((v) => { const n = new Date(v.y, v.m + d, 1); return { y: n.getFullYear(), m: n.getMonth() }; });
  const off = (s: string) => (minD && s < minD) || (maxD && s > maxD);

  return (
    <div className="select-none p-3">
      <div className="mb-2 flex items-center justify-between">
        <button type="button" onClick={() => setMonths((x) => !x)} aria-label="Choose month and year" aria-expanded={months}
          className="flex min-h-[40px] items-center gap-1 rounded-lg px-2 text-[17px] font-semibold text-navy hover:bg-slate-100">
          {MONTHS[view.m]} {view.y}
          <svg aria-hidden width="10" height="10" viewBox="0 0 10 10" className={`text-brand transition ${months ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 1.5 6.5 5 3 8.5" /></svg>
        </button>
        <div className="flex">
          <button type="button" aria-label={months ? "Previous year" : "Previous month"} onClick={() => (months ? setView((v) => ({ ...v, y: v.y - 1 })) : go(-1))} className="grid h-10 w-10 place-items-center rounded-full text-brand hover:bg-slate-100">
            <svg aria-hidden width="10" height="16" viewBox="0 0 10 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2 2 8l6 6" /></svg>
          </button>
          <button type="button" aria-label={months ? "Next year" : "Next month"} onClick={() => (months ? setView((v) => ({ ...v, y: v.y + 1 })) : go(1))} className="grid h-10 w-10 place-items-center rounded-full text-brand hover:bg-slate-100">
            <svg aria-hidden width="10" height="16" viewBox="0 0 10 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m2 2 6 6-6 6" /></svg>
          </button>
        </div>
      </div>
      {months ? (
        <div className="grid grid-cols-3 gap-2 py-1">
          {MONTHS.map((n, i) => (
            <button key={n} type="button" onClick={() => { setView((v) => ({ ...v, m: i })); setMonths(false); }}
              className={`min-h-[44px] rounded-xl text-[15px] font-medium ${i === view.m ? "bg-brand-dark text-white" : "text-navy hover:bg-slate-100"}`}>{n.slice(0, 3)}</button>
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-7 text-center text-[12px] font-semibold text-slate-500" aria-hidden>{DOW.map((d, i) => <div key={i} className="py-1">{d}</div>)}</div>
          <div className="grid grid-cols-7 gap-y-1" role="grid" aria-label={`${MONTHS[view.m]} ${view.y}`}>
            {Array.from({ length: first }, (_, i) => <div key={"b" + i} />)}
            {Array.from({ length: days }, (_, i) => {
              const d = i + 1, s = ymd(view.y, view.m, d), chosen = s === value.slice(0, 10), isToday = s === today, dis = off(s);
              return (
                <button key={s} type="button" role="gridcell" aria-selected={chosen} aria-label={show(s, false)} aria-current={isToday ? "date" : undefined} disabled={!!dis} onClick={() => onPick(s)}
                  className={`mx-auto grid h-10 w-10 place-items-center rounded-full text-[17px] transition
                    ${chosen ? "bg-brand-dark font-semibold text-white" : isToday ? "font-semibold text-brand-dark ring-1 ring-brand/50" : "text-navy hover:bg-slate-100"}
                    ${dis ? "!text-slate-300 hover:!bg-transparent" : ""}`}>{d}</button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

const ROW = 40;
/** iOS-like wheel: a scroll-snap column of numbers with the selected one in the highlighted band. */
function Wheel({ count, value, onChange, label }: { count: number; value: number; onChange: (n: number) => void; label: string }) {
  const el = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { if (el.current) el.current.scrollTop = value * ROW; }, [value]);
  function onScroll() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!el.current) return;
      const n = Math.min(count - 1, Math.max(0, Math.round(el.current.scrollTop / ROW)));
      if (n !== value) onChange(n);
    }, 90);
  }
  return (
    <div className="relative h-[200px] w-20">
      <div className="pointer-events-none absolute inset-x-0 top-[80px] h-10 rounded-lg bg-slate-200/70" />
      <div ref={el} role="listbox" aria-label={label} tabIndex={0} onScroll={onScroll}
        onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); onChange(Math.min(count - 1, value + 1)); } if (e.key === "ArrowUp") { e.preventDefault(); onChange(Math.max(0, value - 1)); } }}
        className="relative h-full snap-y snap-mandatory overflow-y-auto overscroll-contain py-[80px] text-center [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} role="option" aria-selected={i === value} onClick={() => onChange(i)}
            className={`flex h-10 snap-center items-center justify-center text-[22px] tabular-nums ${i === value ? "font-semibold text-navy" : "text-slate-500"}`}>{p2(i)}</div>
        ))}
      </div>
    </div>
  );
}

interface DateProps {
  id?: string; className?: string; value: string; min?: string; max?: string; disabled?: boolean; clearable?: boolean; placeholder?: string;
  "aria-label"?: string;
  onChange: (e: { target: { value: string } }) => void;
}

function DatePicker({ time, id, className = "field", value, min, max, disabled, clearable, placeholder, onChange, ...rest }: DateProps & { time: boolean }) {
  const [open, setOpen] = useState(false);
  const mobile = useIsMobile();
  const btn = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const label = rest["aria-label"] ?? (open && id ? document.querySelector(`label[for="${id}"]`)?.textContent ?? "Choose date" : "Choose date");
  const p = parse(value);
  const clamp = (v: string) => (max && v > max ? max : min && v < min ? min : v);
  const set = (v: string) => onChange({ target: { value: v ? clamp(v) : "" } });
  const base = p ?? parse(nowIstLocal())!;
  const hh = p?.hh ?? base.hh, mm = p?.mm ?? base.mm;
  const stamp = (date: string, h: number, m: number) => (time ? `${date}T${p2(h)}:${p2(m)}` : date);

  return (
    <>
      <button ref={btn} id={id} type="button" aria-haspopup="dialog" aria-expanded={open} aria-label={rest["aria-label"] ? `${rest["aria-label"]}: ${value ? show(value, time) : placeholder ?? (time ? "Select date & time" : "Select date")}` : undefined} disabled={disabled}
        className={`${className} flex items-center justify-between gap-2 text-left ${disabled ? "opacity-60" : "active:bg-slate-50"} ${open ? "!border-brand ring-2 ring-brand/25" : ""}`}
        onClick={() => setOpen((o) => !o)}>
        <span className={`truncate ${value ? "" : "text-slate-500"}`}>{value ? show(value, time) : placeholder ?? (time ? "Select date & time" : "Select date")}</span>
        <CalendarIcon />
      </button>
      <Layer open={open} onClose={close} anchor={btn.current} mobile={mobile} title={label} width={time ? 330 : 310}>
        <div className="flex min-h-0 flex-1 flex-col">
         <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <Calendar value={value} min={min} max={max} onPick={(d) => { set(stamp(d, hh, mm)); if (!time) close(); }} />
          {time && (
            <div className="border-t border-slate-200/70 px-3 pb-2 pt-3">
              <div className="mb-1 text-center text-[13px] font-semibold uppercase tracking-wide text-slate-600">Time</div>
              <div className="flex items-center justify-center gap-1">
                <Wheel label="Hour" count={24} value={hh} onChange={(n) => set(stamp(p ? ymd(p.y, p.m, p.d) : nowIstLocal().slice(0, 10), n, mm))} />
                <span className="text-2xl font-semibold text-navy" aria-hidden>:</span>
                <Wheel label="Minute" count={60} value={mm} onChange={(n) => set(stamp(p ? ymd(p.y, p.m, p.d) : nowIstLocal().slice(0, 10), hh, n))} />
              </div>
            </div>
          )}
         </div>
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-slate-200/70 p-2">
            <button type="button" className="min-h-[44px] rounded-xl px-4 text-[15px] font-semibold text-brand-dark hover:bg-slate-100"
              onClick={() => { set(time ? nowIstLocal() : nowIstLocal().slice(0, 10)); if (!time) close(); }}>{time ? "Now" : "Today"}</button>
            <div className="flex gap-1">
              {clearable && value && <button type="button" className="min-h-[44px] rounded-xl px-4 text-[15px] font-semibold text-slate-600 hover:bg-slate-100" onClick={() => { set(""); close(); }}>Clear</button>}
              {time && <button type="button" className="min-h-[44px] rounded-xl bg-brand-dark px-5 text-[15px] font-semibold text-white" onClick={close}>Done</button>}
            </div>
          </div>
        </div>
      </Layer>
    </>
  );
}

/** Calendar field. value / onChange use "YYYY-MM-DD" (same as <input type="date">). */
export const DateInput = (p: DateProps) => <DatePicker {...p} time={false} />;
/** Calendar + time wheels. value / onChange use "YYYY-MM-DDTHH:mm" (same as <input type="datetime-local">). */
export const DateTimeInput = (p: DateProps) => <DatePicker {...p} time />;
