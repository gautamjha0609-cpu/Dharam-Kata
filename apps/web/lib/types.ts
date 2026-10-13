export interface Weighment {
  id: string;
  /** the firm's extra field values (keys x1..x8) */
  extra?: Record<string, string> | null;
  site_id: string;
  vehicle_display: string;
  vehicle_normalized: string;
  party_id: string | null;
  material: string | null;
  notes: string | null;
  status: "pending_empty" | "ready_to_invoice" | "invoiced" | "voided";
  gross_weight_kg: string;
  gross_weight_at: string;
  gross_time_mode: "automatic" | "manual";
  tare_weight_kg: string | null;
  tare_weight_at: string | null;
  net_weight_kg: string | null;
  rate_at_gross: string | null;
  rate_at_tare: string | null;
  version: number;
  created_at: string;
}

export interface Invoice {
  id: string;
  /** open = first weighing only (opening slip printed); closed = both weighings done */
  stage: "open" | "closed";
  extra?: Record<string, string> | null;
  site_id: string;
  invoice_number: string;
  status: "issued" | "cancelled";
  issued_at: string;
  payment_mode: "cash" | "credit";
  party_id: string | null;
  party_name: string | null;
  vehicle_display: string;
  material: string | null;
  notes: string | null;
  gross_weight_kg: string;
  gross_weight_at: string;
  tare_weight_kg: string | null;
  tare_weight_at: string | null;
  net_weight_kg: string | null;
  weight_unit: "kg" | "tonne";
  quantity: string;
  rate: string;
  fee_total: string;
  cancel_reason: string | null;
}

export interface Party {
  id: string;
  display_name: string;
  party_type: string;
  gstin: string | null;
  phone: string | null;
  city: string | null;
  active: boolean;
}

export interface PrintJob {
  id: string;
  invoice_id: string;
  job_type: "original" | "reprint" | "test";
  status: string;
  attempt_count: number;
  last_error_code: string | null;
  queued_at: string;
  submitted_at: string | null;
  reprint_reason: string | null;
}
