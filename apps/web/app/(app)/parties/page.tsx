"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { friendlyError } from "@/lib/errors";
import { Alert, Empty, PageHead } from "@/components/ui";
import { DebtorDialog } from "@/components/debtor-dialog";
import { useLive } from "@/lib/use-live";
import type { Party } from "@/lib/types";

const PAGE = 50;
const COLS = "id,display_name,party_type,gstin,pan,phone,address,active";

/** This firm's debtors and vendors. Searched on the server in pages of 50, so a large list never loads at once. */
export default function DebtorsPage() {
  const { org, can } = useApp();
  const [rows, setRows] = useState<Party[]>([]);
  const [q, setQ] = useState("");
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<Party | "new" | null>(null);
  const seq = useRef(0);
  const manage = can("party.manage");
  const add = can("party.create") || manage;

  const load = useCallback(async (append: boolean, from = 0) => {
    if (!org) return;
    const mine = ++seq.current;
    setLoading(true); setErr(null);
    let qb = supabase().from("parties").select(COLS).eq("organization_id", org.organization_id).eq("active", true).order("normalized_name").range(from, from + PAGE);
    const s = q.trim().toUpperCase().replace(/[%_,()]/g, " ");
    if (s) qb = qb.ilike("normalized_name", `%${s.replace(/\s+/g, "%")}%`);
    const { data, error } = await qb;
    if (mine !== seq.current) return;
    if (error) setErr(friendlyError(error));
    const list = (data ?? []) as Party[];
    setMore(list.length > PAGE);
    setRows((prev) => (append ? [...prev, ...list.slice(0, PAGE)] : list.slice(0, PAGE)));
    setLoading(false);
  }, [org, q]);

  const first = useRef(true);
  useEffect(() => {
    const wait = first.current ? 0 : 250; // search as the person types, but not on every key
    first.current = false;
    const t = setTimeout(() => void load(false), wait);
    return () => clearTimeout(t);
  }, [load]);
  useLive(() => { if (rows.length <= PAGE) void load(false); }, ["invoices"], { staleMs: 5 * 60_000 });

  return (
    <div>
      <PageHead title="Debtors" sub="Your firm's debtors and vendors. Changes affect future entries only; issued invoices keep their details."
        actions={add ? <button className="btn-primary" onClick={() => setEdit("new")}>＋ Add debtor</button> : undefined} />
      <input className="field mb-3" type="search" placeholder="Search debtors…" aria-label="Search debtors" value={q} onChange={(e) => setQ(e.target.value)} />
      {err && <Alert>{err}</Alert>}
      {!loading && rows.length === 0 ? <Empty title={q ? "No debtor matches your search" : "No debtors yet"} hint={q ? undefined : "Add the first one with “Add debtor”."} /> : (
        <ul className="space-y-2">
          {rows.map((p) => (
            <li key={p.id} className="card flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold text-navy">{p.display_name}</p>
                <p className="text-sm text-slate-600">{[p.party_type, p.phone, p.gstin].filter(Boolean).join(" · ")}</p>
                {p.address && <p className="truncate text-xs text-slate-500">{p.address}</p>}
              </div>
              {manage && <button className="btn-ghost !min-h-[36px]" onClick={() => setEdit(p)}>Edit</button>}
            </li>
          ))}
        </ul>
      )}
      {loading && <p className="mt-3 text-slate-600">Loading…</p>}
      {more && !loading && <button className="btn-ghost mt-3 w-full" onClick={() => void load(true, rows.length)}>Load more</button>}
      <DebtorDialog open={!!edit} initial={edit === "new" ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void load(false); }} />
    </div>
  );
}
