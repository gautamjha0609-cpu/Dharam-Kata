"use client";
import { DateTimeInput } from "@/components/ios";
import { Select } from "@/components/ios";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import { friendlyError } from "@/lib/errors";
import { fmtDateTime, inr, istLocalToIso, newIdemKey, nowIstLocal, num } from "@/lib/format";
import { DomainError, checkVehicle, formatVehicle, resolveWeights } from "@dk/domain";
import { Alert, Modal, PageHead, PrintBadge } from "@/components/ui";
import { PartyPicker } from "@/components/party-picker";
import { TicketPreview, previewValues, useReceipt } from "@/components/receipt";
import { ExtraInputs, extraPayload, extraProblem, useCustomFields } from "@/components/custom-fields";
import { PrintFollow, PrintTarget, WaitingSlips, useSitePrintStatus } from "@/components/print-status";
import type { Invoice, PrintJob } from "@/lib/types";

/** What find_open_entry returns for a vehicle that was weighed once and has not come back yet. */
interface OpenEntry {
  weighment_id: string; version: number; site_id: string; vehicle: string; first_weight_kg: string; first_at: string;
  invoice_id: string; invoice_number: string; amount: string; payment_mode: "cash" | "credit";
  party_id: string | null; party_name: string | null; material: string | null; notes: string | null; extra: Record<string, string> | null;
}
type Choice = "new" | "close";
interface DueItem { invoice_id: string; invoice_number: string; issued_at: string; amount: string; paid: string; outstanding: string; party_name: string | null }
interface Dues { total: string; count: number; items: DueItem[] }

/** Previous unpaid bills of this vehicle. Collapsed by default: the total is shown, the bill-by-bill list opens on click. */
function DuesBox({ dues, canPay }: { dues: Dues; canPay: boolean }) {
  return (
    <details className="rounded-lg border border-amber-300 bg-amber-50 text-amber-950">
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm font-semibold">
        <span>⚠ Previous dues: {inr(dues.total)} <span className="font-normal">({dues.count} unpaid {dues.count === 1 ? "bill" : "bills"})</span></span>
        <span className="text-xs font-medium text-amber-800">Show details ▾</span>
      </summary>
      <ul className="divide-y divide-amber-200 border-t border-amber-200 px-3 text-sm">
        {dues.items.map((it) => (
          <li key={it.invoice_id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 py-2">
            <span><b>{it.invoice_number}</b> <span className="text-xs text-amber-800">{fmtDateTime(it.issued_at)}</span></span>
            <span>Bill {inr(it.amount)} · paid {inr(it.paid)} · <b>due {inr(it.outstanding)}</b></span>
          </li>
        ))}
      </ul>
      {canPay && <p className="border-t border-amber-200 px-3 py-2 text-xs"><Link href="/collections" className="underline">Record a payment in Collections</Link>. These dues are not added to the new weighment.</p>}
    </details>
  );
}

export default function WeighmentPage() {
  const { org, sites, can } = useApp();
  const idem = useRef(newIdemKey());
  const [siteId, setSiteId] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [vehErr, setVehErr] = useState<string | null>(null); // the plate is not in a valid Indian format
  const [checking, setChecking] = useState(false);
  const [entries, setEntries] = useState<OpenEntry[] | null>(null); // null = vehicle not checked yet
  const [dues, setDues] = useState<Dues | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [popup, setPopup] = useState(false);

  const [weight, setWeight] = useState("");
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<"cash" | "credit">("cash");
  const [partyId, setPartyId] = useState<string | null>(null);
  const [partyName, setPartyName] = useState("");
  const [paid, setPaid] = useState("");
  const [material, setMaterial] = useState("");
  const [notes, setNotes] = useState("");
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [manual, setManual] = useState(false);
  const [at, setAt] = useState(nowIstLocal());
  const [reason, setReason] = useState("");
  const [copies, setCopies] = useState(""); // "" = the layout's default; a number = this slip only
  const [now, setNow] = useState(() => new Date().toISOString());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ inv: Invoice; kind: Choice; job: PrintJob | null } | null>(null);

  const custom = useCustomFields();
  const receipt = useReceipt(siteId);
  const mySites = sites.filter((s) => org?.site_ids.includes(s.id));
  useEffect(() => { if (!siteId && mySites[0]) setSiteId(mySites[0].id); }, [mySites, siteId]);
  useEffect(() => { const t = setInterval(() => setNow(new Date().toISOString()), 30_000); return () => clearInterval(t); }, []);

  // The form follows the receipt layout: a field is asked only if it is on the receipt; "required" comes from the layout.
  const askMaterial = receipt.has("material");
  const askParty = receipt.has("party") || receipt.has("debtor");
  const askNotes = receipt.has("notes");
  const entry = choice === "close" ? entries?.[0] ?? null : null;

  function resetForm(keepVehicle = false) {
    setEntries(null); setDues(null); setChoice(null); setPopup(false); setWeight(""); setAmount(""); setMode("cash"); setPartyId(null); setPartyName(""); setPaid("");
    setMaterial(""); setNotes(""); setExtra({}); setManual(false); setReason(""); setCopies(""); setError(null); setAt(nowIstLocal());
    if (!keepVehicle) setVehicle("");
    idem.current = newIdemKey();
  }

  /** The ONLY call that goes to the server while the vehicle number is typed: it runs when the operator presses "Check vehicle". */
  const check = useCallback(async (v: string) => {
    if (!org || !siteId) return;
    const plate = checkVehicle(v);
    if (!plate.ok) { setVehErr(plate.message); return; }
    setVehErr(null); v = formatVehicle(plate.value); setVehicle(v); // stored and shown in the standard form, e.g. RJ14 GD 9158
    setError(null); setChecking(true); setDone(null);
    const sb = supabase();
    const [o, d] = await Promise.all([
      sb.rpc("find_open_entry", { p_org: org.organization_id, p_site: siteId, p_vehicle: v }),
      sb.rpc("find_vehicle_dues", { p_org: org.organization_id, p_vehicle: v }),
    ]);
    setChecking(false);
    if (o.error) return setError(friendlyError(o.error));
    const list = (o.data ?? []) as unknown as OpenEntry[];
    const due = d.error ? null : (d.data as unknown as Dues); // a failed dues lookup never blocks the weighment
    setEntries(list); setDues(due && due.count > 0 ? due : null);
    const hasDues = !!due && due.count > 0;
    if (list.length === 0) { setChoice("new"); setPopup(hasDues); } else { setChoice(null); setPopup(true); }
  }, [org, siteId]);

  // arriving from the "Open entries" list: /weighments/new?vehicle=RJ14GD9158 checks straight away
  const auto = useRef(false);
  useEffect(() => {
    if (auto.current || !org || !siteId) return;
    const v = new URLSearchParams(window.location.search).get("vehicle");
    if (!v) return;
    auto.current = true;
    setVehicle(v.toUpperCase());
    void check(v.toUpperCase());
  }, [org, siteId, check]);

  function pickChoice(c: Choice) {
    setPopup(false); setChoice(c); setError(null);
    const e = entries?.[0];
    if (c === "close" && e) {
      setAmount(String(Number(e.amount))); setMode(e.payment_mode); setPartyId(e.party_id); setPartyName(e.party_name ?? "");
      setMaterial(e.material ?? ""); setNotes(e.notes ?? ""); setExtra(e.extra ?? {});
    }
    idem.current = newIdemKey();
  }

  // live preview of the slip that will print --------------------------------------------------------------------
  const when = manual ? istLocalToIso(at) : now;
  let res: ReturnType<typeof resolveWeights> | null = null;
  let weightErr: string | null = null;
  if (entry && weight) {
    try { res = resolveWeights(entry.first_weight_kg, weight); } catch (e) { weightErr = e instanceof DomainError ? e.message : "Invalid weight"; }
  }
  const xp = extraPayload(custom.active, receipt.has, extra);
  const preview = useMemo(() => {
    const base = { vehicle, material: askMaterial ? material : undefined, party: mode === "credit" ? partyName : undefined, notes: askNotes ? notes : undefined, paymentMode: mode, charge: amount || null, extra: xp };
    if (entry) {
      return res
        ? previewValues({ ...base, serial: entry.invoice_number, gross: res.gross, grossAt: res.loadedWas === "first" ? entry.first_at : when, tare: res.tare, tareAt: res.loadedWas === "first" ? when : entry.first_at, net: res.net })
        : previewValues({ ...base, serial: entry.invoice_number, stage: "open", gross: entry.first_weight_kg, grossAt: entry.first_at });
    }
    return previewValues({ ...base, serial: "(on issue)", stage: "open", gross: weight || null, grossAt: weight ? when : null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicle, material, partyName, notes, mode, amount, JSON.stringify(xp), entry, res?.gross, res?.tare, weight, when, askMaterial, askParty, askNotes]);

  const amountNum = Number(amount), paidNum = Number(paid);
  const paidTooMuch = mode === "credit" && paid !== "" && Number.isFinite(amountNum) && paidNum > amountNum + 1e-9;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!org || !choice) return;
    setError(null);
    const w = Number(weight), a = Number(amount);
    if (!Number.isFinite(w) || w <= 0) return setError(choice === "close" ? "Enter the second weight in kg." : "Enter the first weight in kg.");
    if (weightErr) return setError(weightErr);
    if (amount === "" || !Number.isFinite(a) || a < 0) return setError("Enter the amount.");
    if (mode === "credit" && !partyId) return setError("Select the debtor / party for a credit entry.");
    if (mode === "credit" && paid !== "" && (!(paidNum >= 0) || paidNum > a)) return setError(`Paid now cannot be more than the amount (${inr(a)}).`);
    if (askMaterial && receipt.required("material") && !material.trim()) return setError("Enter the material.");
    if (askNotes && receipt.required("notes") && !notes.trim()) return setError("Enter the notes.");
    const problem = extraProblem(custom.active, receipt.has, receipt.required, extra);
    if (problem) return setError(problem);
    setBusy(true);
    // "Copies" changed for this slip only: stored under this save's idempotency key, used once by its print job
    if (copies) {
      const { error: cErr } = await supabase().rpc("set_slip_copies", { p_org: org.organization_id, p_idem: idem.current, p_copies: Number(copies) });
      if (cErr) { setBusy(false); return setError(friendlyError(cErr)); }
    }
    const common = {
      p_amount: a, p_payment_mode: mode, p_party: (mode === "credit" ? partyId : null) as unknown as string,
      p_material: (askMaterial && material ? material : null) as unknown as string, p_notes: (askNotes && notes ? notes : null) as unknown as string,
      p_extra: xp as unknown as Record<string, never>,
      p_time_mode: manual ? "manual" : "automatic", p_at: (manual ? istLocalToIso(at) : null) as unknown as string,
      p_reason: (manual ? reason : null) as unknown as string, p_idem: idem.current,
      p_amount_paid: (mode === "credit" && paid ? Number(paid) : null) as unknown as number,
    };
    const sb = supabase();
    const { data, error: err } = choice === "close" && entry
      ? await sb.rpc("close_entry", { p_org: org.organization_id, p_weighment: entry.weighment_id, p_weight: w, p_expected_version: entry.version, ...common })
      : await sb.rpc("open_entry", { p_org: org.organization_id, p_site: siteId, p_vehicle: vehicle, p_weight: w, p_replace_open: (entries?.length ?? 0) > 0, ...common });
    if (err) {
      setBusy(false);
      // Somebody (or an earlier tab) changed this vehicle's entry since it was checked: look again and let the person choose, instead of a dead end.
      if (/open_entry_exists|weighment_not_pending|version_conflict/.test(String((err as { message?: string }).message ?? ""))) {
        const msg = friendlyError(err);
        setChoice(null); setEntries(null);
        await check(vehicle);
        return setError(msg);
      }
      return setError(friendlyError(err)); // the typed values stay on the form
    }
    const inv = (data as unknown as { invoice: Invoice }).invoice;
    const { data: job } = await sb.from("print_jobs").select("*").eq("invoice_id", inv.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    setBusy(false);
    setDone({ inv, kind: choice, job: (job as PrintJob) ?? null });
    resetForm();
  }

  // the slip we just sent: PrintFollow polls it, shows "Print successful" and offers "Print again" after 2 minutes
  const onJob = useCallback((j: PrintJob) => setDone((d) => (d ? { ...d, job: j } : d)), []);
  const print = useSitePrintStatus(siteId);

  if (!can("weighment.create")) return <Alert kind="warn">You do not have permission to create weighments.</Alert>;
  if (mySites.length === 0) return <Alert kind="warn">You are not assigned to any site yet. Ask your administrator.</Alert>;

  const ready = choice !== null;
  const closing = choice === "close" && !!entry;
  const defaultCopies = (closing ? receipt.layout.copiesClosing : receipt.layout.copiesOpening) ?? receipt.layout.copies;
  return (
    <div className="mx-auto max-w-5xl">
      <PageHead title="Weighment" sub="Type the vehicle number and press Check vehicle. The system finds out whether this is a new entry or the closing of an open one." />
      {done && (
        <div className="mb-4 space-y-2">
          <Alert kind="ok">
            {done.kind === "close" ? "Closed" : "Opened"} <b>{done.inv.vehicle_display}</b> — invoice <b>{done.inv.invoice_number}</b> · amount <b>{inr(done.inv.fee_total)}</b>.{" "}
            {done.kind === "new" ? "The opening slip is printing. When the vehicle comes back, check its number again to close this entry." : "The closing slip is printing (same invoice number)."}
          </Alert>
          <div className="flex flex-wrap items-center gap-2 text-sm"><span>Printing:</span><PrintBadge status={done.job?.status} />
            <Link href={`/invoices/${done.inv.id}`} className="underline">View invoice</Link></div>
          {(done.job?.status === "not_configured" || done.job?.status === "routing_error") && (
            <Alert kind="warn">Saved, but no printer is set up for this site. {can("print.route.manage") ? <Link className="underline" href="/settings">Set up a printer</Link> : "Ask your administrator."}</Alert>
          )}
          <PrintFollow job={done.job} printer={print.status?.printer ? `${print.status.printer.label} (${print.status.printer.pc})` : null} onJob={onJob} />
        </div>
      )}
      <div className="mb-4 space-y-2">
        <PrintTarget status={print.status} />
        <WaitingSlips status={{ printer: print.status?.printer ?? null, waiting: (print.status?.waiting ?? []).filter((w) => w.invoice_id !== done?.inv.id) }} reload={print.reload} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <form onSubmit={submit} className="card space-y-4" noValidate>
          {error && <Alert>{error}</Alert>}
          {mySites.length > 1 && (
            <div>
              <label className="label" htmlFor="site">Site</label>
              <Select id="site" className="field" value={siteId} disabled={ready} onChange={(e) => setSiteId(e.target.value)}>
                {mySites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </div>
          )}
          <div>
            <label className="label" htmlFor="veh">Vehicle number <span className="text-red-600">*</span></label>
            <div className="flex gap-2">
              <input id="veh" className={`field uppercase ${vehErr ? "!border-red-500 !bg-red-50" : ""}`} maxLength={14} autoCapitalize="characters" autoComplete="off" value={vehicle} disabled={ready}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (!ready) void check(vehicle); } }}
                onChange={(e) => { setVehicle(e.target.value.toUpperCase().replace(/[^A-Z0-9 -]/g, "")); setVehErr(null); setEntries(null); setChoice(null); }} placeholder="RJ14 GD 9158" aria-invalid={!!vehErr} />
              {!ready
                ? <button type="button" className="btn-navy whitespace-nowrap" disabled={checking || !vehicle.trim()} onClick={() => void check(vehicle)}>{checking ? "Checking…" : "Check vehicle"}</button>
                : <button type="button" className="btn-ghost whitespace-nowrap" onClick={() => resetForm()}>Change</button>}
            </div>
            {vehErr && <p role="alert" className="mt-1 text-xs font-medium text-red-700">{vehErr}</p>}
            {!ready && <p className="mt-1 text-xs text-slate-600">Type the full number, then press the button (or Enter). Nothing is sent to the server before that.</p>}
          </div>

          {ready && dues && !popup && <DuesBox dues={dues} canPay={can("payment.record")} />}
          {ready && (
            <>
              <div className={`rounded-lg border p-3 text-sm ${closing ? "border-sky-200 bg-sky-50 text-sky-900" : "border-green-200 bg-green-50 text-green-900"}`}>
                {closing && entry ? (
                  <>
                    <b>Closing an open entry</b> · invoice {entry.invoice_number}<br />
                    First weight {num(entry.first_weight_kg)} kg at {fmtDateTime(entry.first_at)} · amount entered then: {inr(entry.amount)}
                  </>
                ) : (
                  <><b>New entry</b> — an opening slip prints now{(entries?.length ?? 0) > 0 && <>; the earlier open entry of this vehicle will be cancelled</>}.</>
                )}
              </div>

              <div>
                <label className="label" htmlFor="wt">{closing ? "Second weight (kg)" : "First weight (kg)"} <span className="text-red-600">*</span></label>
                <input id="wt" className="field text-lg" inputMode="decimal" autoFocus value={weight} onChange={(e) => setWeight(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="e.g. 34210" />
                {closing ? (
                  <div className="mt-2 rounded-lg bg-slate-50 p-3 text-sm" aria-live="polite">
                    {weightErr ? <span className="text-red-700">{weightErr}</span> : res ? (
                      <>
                        <p>Loaded (heavier): <b>{num(res.gross)} kg</b> · Empty (lighter): <b>{num(res.tare)} kg</b></p>
                        <p>Net weight: <b className="text-lg text-navy">{num(res.net)} kg</b></p>
                      </>
                    ) : <span className="text-slate-600">The heavier of the two weights is taken as loaded, the lighter as empty — automatically.</span>}
                  </div>
                ) : <p className="mt-1 text-xs text-slate-600">Loaded or empty, whatever the scale shows. It is printed as “First weight”.</p>}
              </div>

              <div>
                <label className="label" htmlFor="amt">Amount (₹) <span className="text-red-600">*</span></label>
                <input id="amt" className="field text-lg" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="e.g. 350" />
                <p className="mt-1 text-xs text-slate-600">The total amount received for this entry. {closing ? <>It was {inr(entry!.amount)} at the first weight. <b>The amount you enter now is the one that counts.</b></> : "You can change it when the vehicle comes back; the last amount counts."}</p>
              </div>

              <fieldset>
                <legend className="label">Payment</legend>
                <div className="grid grid-cols-2 gap-2">
                  {(["cash", "credit"] as const).map((m) => (
                    <label key={m} className={`flex min-h-[44px] cursor-pointer items-center justify-center rounded-lg border text-sm font-semibold ${mode === m ? "border-brand bg-brand-50 text-brand-dark" : "border-slate-300"}`}>
                      <input type="radio" name="mode" className="sr-only" checked={mode === m} onChange={() => setMode(m)} />{m === "cash" ? "Cash" : "Credit"}
                    </label>
                  ))}
                </div>
              </fieldset>
              {mode === "credit" && (
                <div>
                  <label className="label" htmlFor="paid">Paid now (optional, ₹)</label>
                  <input id="paid" className={`field ${paidTooMuch ? "!border-red-500" : ""}`} inputMode="decimal" aria-invalid={paidTooMuch} value={paid} onChange={(e) => setPaid(e.target.value.replace(/[^0-9.]/g, ""))} />
                  {paidTooMuch
                    ? <p role="alert" className="mt-1 text-xs font-medium text-red-700">Paid now cannot be more than the amount ({inr(amountNum)}).</p>
                    : amount !== "" && <p className="mt-1 text-xs text-slate-600">Still to be paid after this: <b>{inr(Math.max(0, amountNum - (paid === "" ? 0 : paidNum)))}</b></p>}
                </div>
              )}
              {mode === "credit" && (
                <PartyPicker value={partyId} onChange={setPartyId} onName={setPartyName} required
                  label="Debtor (required for credit)" />
              )}
              {askMaterial && (
                <div>
                  <label className="label" htmlFor="mat">Material / goods {receipt.required("material") && <span className="text-red-600">*</span>}</label>
                  <input id="mat" className="field" value={material} onChange={(e) => setMaterial(e.target.value)} />
                </div>
              )}
              {askNotes && (
                <div>
                  <label className="label" htmlFor="notes">Notes {receipt.required("notes") && <span className="text-red-600">*</span>}</label>
                  <input id="notes" className="field" value={notes} onChange={(e) => setNotes(e.target.value)} />
                </div>
              )}
              <ExtraInputs fields={custom.active} has={receipt.has} required={receipt.required} values={extra} onChange={(k, v) => setExtra((x) => ({ ...x, [k]: v }))} />

              <div className="rounded-lg bg-slate-50 p-3">
                <p className="text-sm font-medium text-navy">Time</p>
                <p className="text-sm text-slate-600">{manual ? "Manual time (audited)" : "Automatic: the server records the exact time when you save."}</p>
                {can("weighment.manual_time") && (
                  <label className="mt-2 flex min-h-[44px] items-center gap-2 text-sm">
                    <input type="checkbox" className="h-5 w-5" checked={manual} onChange={(e) => setManual(e.target.checked)} /> Set time manually
                  </label>
                )}
                {manual && (
                  <div className="mt-2 space-y-3">
                    <div><label className="label" htmlFor="at">Date &amp; time (IST)</label><DateTimeInput id="at" className="field" value={at} max={nowIstLocal()} onChange={(e) => setAt(e.target.value)} /></div>
                    <div><label className="label" htmlFor="why">Reason <span className="text-red-600">*</span></label><input id="why" className="field" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
                  </div>
                )}
              </div>
              {/* copies of THIS slip only (quiet: rarely needed); needs a published layout, which carries the copies */}
              {receipt.published && <div className="flex items-center justify-end gap-1 text-xs text-slate-600">
                <label htmlFor="copies">Copies</label>
                <select id="copies" className="cursor-pointer rounded border-0 bg-transparent py-0.5 pl-1 pr-5 text-xs text-slate-700 underline decoration-dotted underline-offset-2 focus:ring-1 focus:ring-brand"
                  value={copies} onChange={(e) => setCopies(e.target.value)} aria-label="Copies of this slip">
                  <option value="">{defaultCopies} (default)</option>
                  {[1, 2, 3, 4, 5].map((n) => <option key={n} value={String(n)}>{n}{n === defaultCopies ? " (default)" : ""} — this slip only</option>)}
                </select>
              </div>}
              <button className="btn-primary w-full" disabled={busy || !org || !weight || amount === "" || !!weightErr || paidTooMuch}>
                {busy ? "Saving…" : closing ? "Close entry & print closing slip" : "Save & print opening slip"}
              </button>
            </>
          )}
          <p className="text-xs text-slate-600">{org?.display_name}</p>
        </form>

        <div className="lg:sticky lg:top-20 lg:self-start">
          <div className="card">
            <h2 className="mb-2 font-bold text-navy">{closing ? "Closing slip preview" : "Opening slip preview"}</h2>
            <TicketPreview config={receipt} values={preview} />
            {!receipt.published && <p className="mt-2 text-xs text-amber-800">Using the standard layout. An admin can adjust and publish it in Settings → Receipt layout.</p>}
          </div>
        </div>
      </div>

      <Modal open={popup && (!!entries?.length || !!dues)} onClose={() => setPopup(false)} title={entries?.length ? "This vehicle has an open entry" : "Previous dues for this vehicle"}>
        <div className="space-y-4">
          {dues && <DuesBox dues={dues} canPay={can("payment.record")} />}
          {entries && entries[0] ? (
            <>
              <dl className="grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-3 text-sm">
                <div><dt className="text-slate-600">Vehicle</dt><dd className="font-semibold">{entries[0].vehicle}</dd></div>
                <div><dt className="text-slate-600">Invoice no.</dt><dd className="font-semibold">{entries[0].invoice_number}</dd></div>
                <div><dt className="text-slate-600">First weight</dt><dd className="font-semibold">{num(entries[0].first_weight_kg)} kg</dd></div>
                <div><dt className="text-slate-600">Weighed at</dt><dd>{fmtDateTime(entries[0].first_at)}</dd></div>
                <div><dt className="text-slate-600">Amount entered</dt><dd>{inr(entries[0].amount)}</dd></div>
                {entries[0].party_name && <div><dt className="text-slate-600">Party</dt><dd>{entries[0].party_name}</dd></div>}
              </dl>
              <p className="text-sm text-slate-600">Is the vehicle back to finish this entry, or is it a new weighment?</p>
              <button type="button" className="btn-primary w-full" onClick={() => pickChoice("close")}>Close this entry (second weight)</button>
              <button type="button" className="btn-ghost w-full" onClick={() => pickChoice("new")}>New weighment</button>
            </>
          ) : (
            <button type="button" className="btn-primary w-full" onClick={() => setPopup(false)}>Continue with the new weighment</button>
          )}
        </div>
      </Modal>
    </div>
  );
}
