"use client";
import { Select } from "@/components/ios";
import { FONT_FAMILIES, type Decor, type FontFamily, type Layout } from "@dk/print-template";

type SetLayout = (fn: (l: Layout) => Layout) => void;

const Num = ({ label, v, on, step = 0.5, min }: { label: string; v: number; on: (n: number) => void; step?: number; min?: number }) => (
  <div>
    <label className="label text-xs">{label}</label>
    <input className="field !min-h-[36px]" type="number" step={step} min={min} value={v} onChange={(e) => on(Number(e.target.value) || 0)} />
  </div>
);

/** Copies per invoice. (The "DUPLICATE" mark on reprints has a fixed place and needs no settings.) */
export function ModeCard({ layout, setLayout }: { layout: Layout; setLayout: SetLayout }) {
  return (
    <div className="card mt-4 space-y-3">
      <h2 className="font-bold text-navy">Copies</h2>
      <Num label="Copies printed per invoice (1–5)" v={layout.copies} step={1} min={1} on={(n) => setLayout((l) => ({ ...l, copies: Math.max(1, Math.min(5, Math.round(n) || 1)) }))} />
      <p className="text-xs text-slate-600">A reprint of an invoice is automatically marked “DUPLICATE” in a fixed place; the original invoice number and amounts never change.</p>
    </div>
  );
}

let seq = 1;
/** Static elements for blank-paper mode: text, rules and boxes. Coordinates are from the paper's top-left corner. */
const DECOR_NAMES: Record<string, string> = { firm: "Firm name (header)", addr: "Address line", govt: "Second header line", phone: "Phone / contact line", n1: "Footer note 1", n2: "Footer note 2", sign: "Signature caption", frame: "Frame", rule1: "Line under header", rule2: "Line above footer" };

export function DecorCard({ layout, setLayout }: { layout: Layout; setLayout: SetLayout }) {
  const add = (type: Decor["type"]) => {
    const id = `${type}${Date.now().toString(36)}${seq++}`;
    const d: Decor =
      type === "text" ? { id, type, x: 10, y: 4, w: 100, h: 8, text: "TITLE", font: { family: "Arial", pt: 14, bold: true }, align: "left" }
      : type === "line" ? { id, type, x: 10, y: 14, w: 100, h: 0, weight: 0.3 }
      : { id, type, x: 8, y: 30, w: 100, h: 40, weight: 0.3 };
    setLayout((l) => ({ ...l, decor: [...l.decor, d] }));
  };
  const patch = (id: string, p: Record<string, unknown>) => setLayout((l) => ({ ...l, decor: l.decor.map((d) => (d.id === id ? ({ ...d, ...p } as Decor) : d)) }));
  const remove = (id: string) => setLayout((l) => ({ ...l, decor: l.decor.filter((d) => d.id !== id) }));
  const blank = layout.mode === "blank";
  return (
    <div className="card mt-4 space-y-3">
      <h2 className="font-bold text-navy">Design elements (header, footer, lines)</h2>
      <p className="text-sm text-slate-600">{blank ? "Titles, company name, rules and boxes that the software prints on every slip." : "Only used when “Blank paper” is selected above; pre-printed forms ignore these."}</p>
      <div className="flex flex-wrap gap-2">
        <button className="btn-ghost !min-h-[36px]" onClick={() => add("text")}>＋ Text</button>
        <button className="btn-ghost !min-h-[36px]" onClick={() => add("line")}>＋ Line</button>
        <button className="btn-ghost !min-h-[36px]" onClick={() => add("rect")}>＋ Box</button>
      </div>
      {layout.decor.length === 0 && <p className="text-sm text-slate-600">None yet.</p>}
      {layout.decor.map((d) => (
        <div key={d.id} className="rounded-lg bg-slate-50 p-3">
          <div className="mb-2 flex items-center justify-between"><b className="text-sm">{DECOR_NAMES[d.id] ?? (d.type === "rect" ? "Box" : d.type === "line" ? "Line" : "Text")}</b><button className="btn-danger !min-h-[32px]" onClick={() => remove(d.id)}>Remove</button></div>
          {d.type === "text" && (
            <div className="mb-2 grid gap-2 sm:grid-cols-3">
              <div className="sm:col-span-3"><label className="label text-xs">Text</label><input className="field !min-h-[36px]" maxLength={120} value={d.text} onChange={(e) => patch(d.id, { text: e.target.value })} /></div>
              <div><label className="label text-xs">Font</label><Select className="field !min-h-[36px]" value={d.font.family} onChange={(e) => patch(d.id, { font: { ...d.font, family: e.target.value as FontFamily } })}>{Object.keys(FONT_FAMILIES).map((f) => <option key={f}>{f}</option>)}</Select></div>
              <Num label="Size (pt)" v={d.font.pt} on={(n) => patch(d.id, { font: { ...d.font, pt: Math.max(5, Math.min(48, n)) } })} />
              <div><label className="label text-xs">Align</label><Select className="field !min-h-[36px]" value={d.align} onChange={(e) => patch(d.id, { align: e.target.value })}><option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option></Select></div>
              <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
                <label className="flex min-h-[36px] items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={d.font.bold} onChange={(e) => patch(d.id, { font: { ...d.font, bold: e.target.checked } })} /><b>Bold</b></label>
                <label className="flex min-h-[36px] items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={!!d.font.italic} onChange={(e) => patch(d.id, { font: { ...d.font, italic: e.target.checked } })} /><i>Italic</i></label>
                <label className="flex min-h-[36px] items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={!!d.font.underline} onChange={(e) => patch(d.id, { font: { ...d.font, underline: e.target.checked } })} /><u>Underline</u></label>
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Num label="X (mm)" v={d.x} on={(n) => patch(d.id, { x: n })} /><Num label="Y (mm)" v={d.y} on={(n) => patch(d.id, { y: n })} />
            <Num label={d.type === "line" ? "Length H (mm)" : "Width (mm)"} v={d.w} on={(n) => patch(d.id, { w: n })} />
            <Num label={d.type === "line" ? "Length V (mm)" : "Height (mm)"} v={d.h} on={(n) => patch(d.id, { h: n })} />
            {d.type !== "text" && <Num label="Thickness (mm)" v={d.weight} step={0.1} on={(n) => patch(d.id, { weight: Math.max(0.1, Math.min(2, n)) })} />}
          </div>
          {d.type === "line" && <p className="mt-1 text-xs text-slate-600">Horizontal line: set vertical length to 0. Vertical line: set horizontal length to 0.</p>}
        </div>
      ))}
    </div>
  );
}
