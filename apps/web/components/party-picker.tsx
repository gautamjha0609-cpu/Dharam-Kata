"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { DebtorDialog } from "@/components/debtor-dialog";
import { clearCache, isFresh, peek, put } from "@/lib/swr-cache";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { friendlyError } from "@/lib/errors";
import type { Party } from "@/lib/types";

export function useParties() {
  const { org } = useApp();
  const key = org ? `parties:${org.organization_id}` : "";
  const [parties, setParties] = useState<Party[]>(() => (key ? peek<Party[]>(key, 5 * 60_000) ?? [] : []));
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!org) return;
    const cached = peek<Party[]>(key, 5 * 60_000);
    if (cached) setParties(cached);
    if (cached && tick === 0 && isFresh(key, 15_000)) return;
    void supabase()
      .from("parties")
      .select("id,display_name,party_type,gstin,pan,phone,address,active")
      .eq("organization_id", org.organization_id)
      .eq("active", true)
      .order("display_name")
      .limit(1000)
      .then(({ data }: { data: unknown }) => setParties(put(key, (data ?? []) as Party[])));
  }, [org, tick, key]);
  return { parties, reload: () => { clearCache("parties:"); setTick((t) => t + 1); } };
}

type Hit = Pick<Party, "id" | "display_name" | "gstin" | "phone">;
const COLS = "id,display_name,gstin,phone";

/**
 * Debtor type-ahead. Only THIS firm's debtors are ever searched (organization_id in every query, plus the database's row security).
 * It never loads the whole list: it asks for the 8 best matches while the person types (one small request, 250 ms after they stop).
 * A typed name that is not in the list turns the box red and offers to create the debtor first: a free-typed name is never attached silently.
 */
export function PartyPicker({ value, onChange, onName, required, label = "Debtor" }: {
  value: string | null;
  onChange: (id: string | null) => void;
  /** live text/name of what is typed or selected, so a receipt preview can reflect it immediately */
  onName?: (name: string) => void;
  required?: boolean;
  label?: string;
}) {
  const { org, can } = useApp();
  const id = useId();
  const [text, setText] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Hit | null>(null);
  const [creating, setCreating] = useState(false);
  const seq = useRef(0);
  const canCreate = can("party.create") || can("party.manage");

  // an id handed in by the screen (closing an entry that already has a debtor): show its name
  useEffect(() => {
    if (!value || !org) { if (!value) setPicked(null); return; }
    if (picked?.id === value) return;
    let live = true;
    void supabase().from("parties").select(COLS).eq("organization_id", org.organization_id).eq("id", value).maybeSingle()
      .then(({ data }: { data: unknown }) => { if (live && data) { const h = data as Hit; setPicked(h); setText(h.display_name); onName?.(h.display_name); } });
    return () => { live = false; };
  }, [value, org]); // eslint-disable-line react-hooks/exhaustive-deps

  const search = useCallback((q: string) => {
    if (!org) return;
    const mine = ++seq.current;
    setLoading(true);
    let qb = supabase().from("parties").select(COLS).eq("organization_id", org.organization_id).eq("active", true).order("normalized_name").limit(8);
    const s = q.trim().toUpperCase().replace(/[%_,()]/g, " ");
    if (s) qb = qb.ilike("normalized_name", `%${s.replace(/\s+/g, "%")}%`);
    void qb.then(({ data }: { data: unknown }) => { if (mine === seq.current) { setHits((data ?? []) as Hit[]); setLoading(false); } });
  }, [org]);

  // typing: wait until the person pauses
  useEffect(() => {
    if (!open || picked) return;
    const t = setTimeout(() => search(text), text.trim() ? 250 : 0);
    return () => clearTimeout(t);
  }, [text, open, picked, search]);

  function choose(h: Hit) { setPicked(h); setText(h.display_name); setOpen(false); onChange(h.id); onName?.(h.display_name); }
  function onInput(v: string) {
    setText(v); setOpen(true); setPicked(null); onChange(null); onName?.(v.trim());
    // exactly one of the suggestions was typed out in full: take it
    const exact = hits.find((h) => h.display_name.toLowerCase() === v.trim().toLowerCase());
    if (exact) choose(exact);
  }

  const typed = text.trim();
  const unknown = typed !== "" && !picked && !loading && !hits.some((h) => h.display_name.toLowerCase() === typed.toLowerCase());
  return (
    <div className="relative">
      <label className="label" htmlFor={id + "-in"}>{label}{required && <span className="text-red-600"> *</span>}</label>
      <input id={id + "-in"} role="combobox" aria-expanded={open} aria-controls={id + "-list"} aria-invalid={unknown} autoComplete="off"
        className={`field ${unknown ? "!border-red-500 !bg-red-50" : picked ? "!border-brand" : ""}`}
        value={text} placeholder="Type to search this firm's debtors…" onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onChange={(e) => onInput(e.target.value)} />
      {open && !picked && hits.length > 0 && (
        <ul id={id + "-list"} role="listbox" className="absolute left-0 right-0 z-30 mt-1 max-h-64 overflow-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
          {hits.map((h) => (
            <li key={h.id} role="option" aria-selected={false}>
              <button type="button" className="flex min-h-[44px] w-full flex-col items-start justify-center px-3 py-1 text-left hover:bg-slate-50" onMouseDown={(e) => e.preventDefault()} onClick={() => choose(h)}>
                <span className="font-medium text-navy">{h.display_name}</span>
                {(h.gstin || h.phone) && <span className="text-xs text-slate-500">{[h.gstin, h.phone].filter(Boolean).join(" · ")}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {unknown && (
        <div role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-red-700">“{typed}” is not one of your debtors.</span>
          {canCreate
            ? <button type="button" className="btn-primary !min-h-[36px] !px-3" onClick={() => setCreating(true)}>Create new debtor</button>
            : <span className="text-slate-600">Ask your administrator to add this debtor.</span>}
        </div>
      )}
      <DebtorDialog open={creating} presetName={typed} onClose={() => setCreating(false)}
        onSaved={(p) => { setCreating(false); choose({ id: p.id, display_name: p.display_name, gstin: p.gstin ?? null, phone: p.phone ?? null }); }} />
    </div>
  );
}
