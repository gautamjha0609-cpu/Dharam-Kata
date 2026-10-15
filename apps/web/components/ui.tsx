"use client";
import { useEffect, type ReactNode } from "react";

export function PageHead({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold text-navy">{title}</h1>
        {sub && <p className="text-sm text-slate-600">{sub}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="card text-center">
      <p className="font-semibold text-navy">{title}</p>
      {hint && <p className="mt-1 text-sm text-slate-600">{hint}</p>}
    </div>
  );
}

export function Alert({ kind = "error", children }: { kind?: "error" | "info" | "warn" | "ok"; children: ReactNode }) {
  const c = {
    error: "border-red-200 bg-red-50 text-red-800",
    info: "border-sky-200 bg-sky-50 text-sky-900",
    warn: "border-amber-200 bg-amber-50 text-amber-900",
    ok: "border-green-200 bg-green-50 text-green-900",
  }[kind];
  return (
    <div role={kind === "error" ? "alert" : "status"} className={`rounded-lg border px-3 py-2 text-sm ${c}`}>
      {children}
    </div>
  );
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl sm:max-w-lg sm:rounded-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold text-navy">{title}</h2>
          <button className="btn-ghost !min-h-[36px] !px-3" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Print status: text + icon + colour, never colour alone (SRS 4.1). Wording is honest about spooler vs paper. */
const PRINT: Record<string, { label: string; icon: string; cls: string }> = {
  not_configured: { label: "No printer set up", icon: "⚠", cls: "bg-amber-100 text-amber-900" },
  routing_error: { label: "Printer routing error", icon: "⚠", cls: "bg-red-100 text-red-800" },
  queued: { label: "Queued", icon: "⏳", cls: "bg-slate-100 text-slate-700" },
  claimed: { label: "Picked up by printer PC", icon: "⇢", cls: "bg-sky-100 text-sky-800" },
  rendering: { label: "Preparing", icon: "⚙", cls: "bg-sky-100 text-sky-800" },
  submitting: { label: "Sending to printer", icon: "⇢", cls: "bg-sky-100 text-sky-800" },
  submitted_to_spooler: { label: "Sent to Windows print queue", icon: "✓", cls: "bg-green-100 text-green-800" },
  failed: { label: "Failed", icon: "✕", cls: "bg-red-100 text-red-800" },
  unknown: { label: "Unknown - check the paper", icon: "?", cls: "bg-amber-100 text-amber-900" },
  cancelled: { label: "Cancelled", icon: "–", cls: "bg-slate-100 text-slate-600" },
};
export const PRINT_ERRORS: Record<string, string> = {
  layout_overflow: "Some text is too long for the ticket layout (e.g. a long material or debtor name). Shorten it or widen the field in Settings → Receipt layout, then reprint.",
  print_cancelled: "The print job was cancelled on the printer PC (for example a PDF printer's Save-as window was closed). Reprint it; PDF printers now save the file automatically with the newest agent.",
  printer_missing: "The printer is not installed on the printer PC (or its name changed). Check the printer and re-assign it in Settings → Printing.",
  printer_offline: "The printer is offline. Switch it on / check the cable. Safe automatic retries run for a few minutes; if it still fails, reprint.",
  paper_out: "The printer is out of paper. Load paper. Safe automatic retries run for a few minutes; if it still fails, reprint.",
  paper_jam: "The printer reports a paper jam. Clear it. Safe automatic retries run for a few minutes; if it still fails, reprint.",
  driver_failure: "The printer driver rejected the job. Check the printer and paper size, then reprint.",
  permission_denied: "Windows denied access to the printer on the printer PC.",
  invalid_template: "The receipt layout is invalid. Re-publish it in Settings → Receipt layout.",
  invalid_payload: "The invoice data was incomplete.",
  lease_expired_after_submit: "The printer PC stopped responding while printing. Check the paper before reprinting so it is not printed twice.",
  max_attempts: "The printer PC could not complete this job after several tries.",
  printer_inactive: "The assigned printer is switched off in settings.",
  printer_not_selected: "The printer PC refused this slip because it is not the printer approved for that PC. Check Settings → Printing, then print again.",
  pc_replaced: "The printer PC was replaced by a new PC before this slip printed. Print it again if needed.",
  pc_paired_again: "The printer PC was paired again before this slip printed. Print it again if needed.",
};
export function PrintBadge({ status }: { status?: string | null }) {
  if (!status) return <span className="badge bg-slate-100 text-slate-600">No print job</span>;
  const p = PRINT[status] ?? { label: status, icon: "•", cls: "bg-slate-100 text-slate-700" };
  return (
    <span className={`badge ${p.cls}`}>
      <span aria-hidden>{p.icon}</span>
      {p.label}
    </span>
  );
}
