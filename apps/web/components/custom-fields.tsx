"use client";
import { Select } from "@/components/ios";
import { useCallback, useEffect, useMemo, useState } from "react";
import { clearCache, isFresh, peek, put } from "@/lib/swr-cache";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { friendlyError } from "@/lib/errors";
import { Alert } from "@/components/ui";
import { CUSTOM_KEYS, type FieldKey } from "@dk/print-template";

export interface CustomField {
  key: (typeof CUSTOM_KEYS)[number];
  label_en: string;
  label_hi: string | null;
  kind: "text" | "number";
  required: boolean;
  ask_at: "first" | "second";
  active: boolean;
}

/** The firm's own extra fields (driver name, challan no. ...). */
export function useCustomFields() {
  const { org } = useApp();
  const key = org ? `customfields:${org.organization_id}` : "";
  const [all, setAll] = useState<CustomField[]>(() => (key ? peek<CustomField[]>(key) ?? [] : []));
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!org) return;
    const cached = peek<CustomField[]>(key);
    if (cached) setAll(cached);
    if (cached && tick === 0 && isFresh(key, 15_000)) return;
    let live = true;
    void supabase().from("custom_fields").select("key,label_en,label_hi,kind,required,ask_at,active").eq("organization_id", org.organization_id).order("key")
      .then(({ data }: { data: unknown }) => { if (live) setAll(put(key, (data ?? []) as CustomField[])); });
    return () => { live = false; };
  }, [org, tick, key]);
  const active = useMemo(() => all.filter((f) => f.active), [all]); // stable identity: effects depend on it
  return { all, active, reload: useCallback(() => { clearCache("customfields:"); clearCache("receipt:"); setTick((n) => n + 1); }, []) };
}

/** Inputs for the extra fields that are on the receipt. The same form is used at both visits, so they are asked both times. */
export function ExtraInputs({ fields, has, required, values, onChange }: {
  fields: CustomField[]; has: (k: FieldKey) => boolean; required: (k: FieldKey) => boolean;
  values: Record<string, string>; onChange: (key: string, v: string) => void;
}) {
  const shown = fields.filter((f) => has(f.key));
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((f) => (
        <div key={f.key}>
          <label className="label" htmlFor={`x-${f.key}`}>{f.label_en}{f.label_hi ? ` / ${f.label_hi}` : ""} {(f.required || required(f.key)) && <span className="text-red-600">*</span>}</label>
          <input id={`x-${f.key}`} className="field" inputMode={f.kind === "number" ? "decimal" : "text"} maxLength={100} value={values[f.key] ?? ""}
            onChange={(e) => onChange(f.key, e.target.value)} />
        </div>
      ))}
    </>
  );
}

/** The first missing required (and shown) extra field, or null. Numbers must be numeric. */
export function extraProblem(fields: CustomField[], has: (k: FieldKey) => boolean, required: (k: FieldKey) => boolean, values: Record<string, string>): string | null {
  for (const f of fields) {
    if (!has(f.key)) continue;
    const v = (values[f.key] ?? "").trim();
    if ((f.required || required(f.key)) && !v) return `Enter ${f.label_en}.`;
    if (v && f.kind === "number" && !/^-?d+(.d+)?$/.test(v)) return `${f.label_en} must be a number.`;
  }
  return null;
}

/** All shown extra fields (an empty value tells the server to clear it). Hidden fields never send stale text. */
export function extraPayload(fields: CustomField[], has: (k: FieldKey) => boolean, values: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const f of fields) if (has(f.key)) out[f.key] = (values[f.key] ?? "").trim();
  return out;
}

/** Settings card: the firm names its own extra fields. Fields are never deleted (old invoices keep their values), only turned off. */
export function CustomFieldsCard() {
  const { org } = useApp();
  const { all, reload } = useCustomFields();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ k: "ok" | "err"; t: string } | null>(null);
  const [draft, setDraft] = useState({ en: "", hi: "", kind: "text" as "text" | "number", ask_at: "first" as "first" | "second", required: false });

  async function save(p: { key: string | null; en: string; hi: string; kind: string; required: boolean; ask_at: string; active: boolean }) {
    if (!org) return false;
    setBusy(true); setMsg(null);
    const { error } = await supabase().rpc("save_custom_field", {
      p_org: org.organization_id, p_key: p.key as unknown as string, p_label_en: p.en, p_label_hi: p.hi as unknown as string,
      p_kind: p.kind, p_required: p.required, p_ask_at: "first", p_active: p.active,
    });
    setBusy(false);
    if (error) { setMsg({ k: "err", t: error.message.includes("custom_field_limit") ? "You can have at most 8 extra fields. Turn one off to reuse its slot." : friendlyError(error) }); return false; }
    reload();
    return true;
  }
  async function add() {
    if (!draft.en.trim()) return setMsg({ k: "err", t: "Type a name for the field, for example Driver name." });
    if (await save({ key: null, en: draft.en, hi: draft.hi, kind: draft.kind, required: draft.required, ask_at: draft.ask_at, active: true })) {
      setDraft({ en: "", hi: "", kind: "text", ask_at: "first", required: false });
      setMsg({ k: "ok", t: "Added. Now put it on the receipt: Settings → Receipt layout → 1 Fields → Add a field." });
    }
  }

  return (
    <section className="card space-y-3">
      <div>
        <h2 className="font-bold text-navy">Extra fields</h2>
        <p className="text-sm text-slate-600">Add your own details to every weighment, such as driver name, challan no. or destination. Place them on the receipt in the layout designer; the New weighment form then asks for them automatically.</p>
      </div>
      {msg && <Alert kind={msg.k === "ok" ? "ok" : "error"}>{msg.t}</Alert>}
      {all.length > 0 && (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200">
          {all.map((f) => (
            <li key={f.key} className="flex flex-wrap items-center gap-2 p-3">
              <div className="min-w-0 flex-1">
                <b className={f.active ? "" : "text-slate-500 line-through"}>{f.label_en}</b>{f.label_hi ? <span className="text-slate-600"> · {f.label_hi}</span> : null}
                <div className="text-xs text-slate-600">{f.kind === "number" ? "Number" : "Text"} {f.required ? " · required" : " · optional"}</div>
              </div>
              <button className="btn-ghost !min-h-[40px]" disabled={busy}
                onClick={() => void save({ key: f.key, en: f.label_en, hi: f.label_hi ?? "", kind: f.kind, required: f.required, ask_at: f.ask_at, active: !f.active })}>
                {f.active ? "Turn off" : "Turn on"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <div><label className="label" htmlFor="cf-en">Name (English)</label><input id="cf-en" className="field" maxLength={40} value={draft.en} onChange={(e) => setDraft({ ...draft, en: e.target.value })} placeholder="Driver name" /></div>
        <div><label className="label" htmlFor="cf-hi">Name (हिन्दी, optional)</label><input id="cf-hi" className="field" maxLength={40} value={draft.hi} onChange={(e) => setDraft({ ...draft, hi: e.target.value })} placeholder="चालक का नाम" /></div>
        <div><label className="label" htmlFor="cf-kind">Type</label>
          <Select id="cf-kind" className="field" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as "text" | "number" })}><option value="text">Text</option><option value="number">Number</option></Select></div>
      </div>
      <label className="flex min-h-[44px] items-center gap-2 text-sm"><input type="checkbox" checked={draft.required} onChange={(e) => setDraft({ ...draft, required: e.target.checked })} /> Operator must fill it in</label>
      <button className="btn-navy" disabled={busy} onClick={() => void add()}>Add field</button>
    </section>
  );
}
