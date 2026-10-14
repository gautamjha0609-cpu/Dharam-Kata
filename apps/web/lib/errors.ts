/** Maps stable DB/RPC error codes to operator-friendly messages. */
const MESSAGES: Record<string, string> = {
  forbidden: "You do not have permission to do this.",
  printer_not_found: "That printer no longer exists. Pick another printer.",
  printer_unavailable: "That printer is switched off or its Print Agent is paused. Check the printer PC.",
  invalid_layout: "The layout is not valid. Fix the problems shown and try again.",
  forbidden_site: "You are not assigned to this site.",
  organization_not_writable: "This organisation is suspended. Changes are blocked.",
  not_authenticated: "Your session has expired. Please sign in again.",
  idempotency_key_required: "Request could not be verified. Please retry.",
  vehicle_required: "Enter the vehicle number.",
  invalid_weight: "Enter a valid weight greater than zero.",
  weights_equal: "The two weights are the same, so there is no goods weight. Check the second weight.",
  weighment_not_pending: "This weighment is no longer awaiting its second weight.",
  weighment_not_ready: "This weighment is not ready to invoice.",
  version_conflict: "Someone else updated this record. Refresh and try again.",
  manual_time_forbidden: "You are not allowed to set the time manually.",
  manual_time_required: "Enter the date and time.",
  manual_reason_required: "A reason is required for a manual time.",
  manual_time_in_future: "The time cannot be in the future.",
  weight_unit_not_set: "Set the billing weight unit (kg or tonne) in Settings first.",
  series_not_initialized: "Set up the invoice number series in Settings first.",
  invalid_rate: "Enter a valid price.",
  party_required_for_credit: "Select a debtor for a credit entry.",
  party_gstin_exists: "A debtor with this GSTIN already exists in your firm.",
  party_name_exists: "A debtor with this name already exists in your firm.",
  invalid_amount_paid: "Paid now cannot be more than the amount of this entry.",
  invalid_amount: "Enter a valid amount.",
  open_entry_exists: "This vehicle already has an open entry. Check the vehicle again and choose whether to close it or start a new one.",
  invalid_extra_number: "One of the extra fields must be a number.",
  unknown_custom_field: "An extra field is switched off or no longer exists. Refresh the page.",
  amount_exceeds_outstanding: "Amount is more than the outstanding balance.",
  invoice_not_issued: "This invoice is already cancelled.",
  reason_required: "A reason is required.",
  unit_locked_after_first_invoice: "The billing unit cannot change after the first invoice is issued.",
  series_would_reuse_numbers: "That start number would reuse an invoice number already issued.",
  invalid_or_expired_code: "That code is invalid or has expired.",
};

export function friendlyError(err: unknown): string {
  const msg = typeof err === "object" && err && "message" in err ? String((err as { message: unknown }).message) : String(err ?? "");
  for (const [code, text] of Object.entries(MESSAGES)) if (msg.includes(code)) return text;
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return "Cannot reach the server. Check your connection and try again.";
  return "Something went wrong. Please try again.";
}
