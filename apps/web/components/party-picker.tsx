"use client";
import { useEffect, useId, useState } from "react";
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
      .select("id,display_name,party_type,gstin,phone,city,active")
      .eq("organization_id", org.organization_id)
      .eq("active", true)
      .order("display_name")
      .limit(1000)
      .then(({ data }: { data: unknown }) => setParties(put(key, (data ?? []) as Party[])));
  }, [org, tick, key]);
  return { parties, reload: () => { clearCache("parties:"); setTick((t) => t + 1); } };
}

/**
 * Type-ahead + dropdown. Selecting a known party stores its stable id. A free-typed name is never silently
 * attached to a similar one: it is only created after an explicit click, and only with party.manage.
 */
export function PartyPicker({ value, onChange, onName, required, label = "Party / Debtor" }: {
  value: string | null;
  onChange: (id: string | null) => void;
  /** live text/name of what is typed or selected, so a receipt preview can reflect it immediately */
  onName?: (name: string) => void;
  required?: boolean;
  label?: string;
}) {
  const { org, can } = useApp();
  const { parties, reload } = useParties();
  const listId = useId();
  const selected = parties.find((p) => p.id === value);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (selected) { setText(selected.display_name); onName?.(selected.display_name); } }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  function onInput(v: string) {
    setText(v);
    onName?.(v.trim());
    setErr(null);
    const hit = parties.find((p) => p.display_name.toLowerCase() === v.trim().toLowerCase());
    onChange(hit ? hit.id : null);
  }

  async function createNew() {
    if (!org) return;
    setBusy(true);
    const { data, error } = await supabase().rpc("upsert_party", { p_org: org.organization_id, p_id: null as unknown as string, p_name: text.trim() });
    setBusy(false);
    if (error) return setErr(friendlyError(error));
    reload();
    onChange((data as { id: string }).id);
  }

  const isNew = text.trim() !== "" && !selected && !parties.some((p) => p.display_name.toLowerCase() === text.trim().toLowerCase());
  return (
    <div>
      <label className="label" htmlFor={listId + "-in"}>{label}{required && <span className="text-red-600"> *</span>}</label>
      <input id={listId + "-in"} className="field" list={listId} value={text} onChange={(e) => onInput(e.target.value)} placeholder="Type to search or choose…" autoComplete="off" required={required} />
      <datalist id={listId}>{parties.map((p) => <option key={p.id} value={p.display_name} />)}</datalist>
      {isNew && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-amber-800">“{text.trim()}” is not in the party list.</span>
          {can("party.manage") ? (
            <button type="button" className="btn-ghost !min-h-[36px]" disabled={busy} onClick={createNew}>{busy ? "Adding…" : "Add as new party"}</button>
          ) : (
            <span className="text-slate-600">Ask an admin to add it.</span>
          )}
        </div>
      )}
      {err && <p className="mt-1 text-sm text-red-700">{err}</p>}
    </div>
  );
}
