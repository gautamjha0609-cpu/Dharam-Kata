import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type WeightUnit = "kg" | "tonne";

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

function dec(value: string | number, field: string): Decimal {
  try {
    const d = new Decimal(value);
    if (!d.isFinite()) throw new Error("not finite");
    return d;
  } catch {
    throw new DomainError("invalid_number", `${field} is not a valid number`);
  }
}

/** Net weight in kg, 3 decimals. Default loaded-first workflow: tare must not exceed gross. */
export function netWeightKg(gross: string | number, tare: string | number): string {
  const g = dec(gross, "gross weight");
  const t = dec(tare, "tare weight");
  if (g.isNegative() || t.isNegative()) throw new DomainError("negative_weight", "Weights cannot be negative");
  if (t.gt(g)) throw new DomainError("tare_exceeds_gross", "Empty weight cannot exceed loaded weight");
  return g.minus(t).toFixed(3);
}

/** Convert kg to the tenant's fixed billing unit. Not rounded until display. */
export function weightInUnit(kg: string | number, unit: WeightUnit): Decimal {
  const d = dec(kg, "weight");
  return unit === "tonne" ? d.div(1000) : d;
}

export interface ResolvedWeights {
  /** the heavier weighing = loaded vehicle */
  gross: string;
  /** the lighter weighing = empty vehicle */
  tare: string;
  net: string;
  /** which of the two weighings was loaded: the first one the operator entered, or the second */
  loadedWas: "first" | "second";
}

/**
 * A vehicle may be weighed loaded-first (goods in) or empty-first (goods out). The operator just enters two weights;
 * the HEAVIER one is the loaded weight, the lighter one is the empty weight. Equal weights are rejected.
 */
export function resolveWeights(first: string | number, second: string | number): ResolvedWeights {
  const a = dec(first, "first weight");
  const b = dec(second, "second weight");
  if (a.isNegative() || b.isNegative() || a.isZero() || b.isZero()) throw new DomainError("invalid_weight", "Both weights must be greater than zero");
  if (a.eq(b)) throw new DomainError("weights_equal", "The two weights are the same, so there is no goods weight");
  const firstHeavier = a.gt(b);
  const hi = firstHeavier ? a : b;
  const lo = firstHeavier ? b : a;
  return { gross: hi.toFixed(3), tare: lo.toFixed(3), net: hi.minus(lo).toFixed(3), loadedWas: firstHeavier ? "first" : "second" };
}

export interface FeeInput {
  netKg: string | number;
  unit: WeightUnit;
  /** Price per selected unit, entered by the operator. */
  rate: string | number;
}

/** fee = net weight (in the tenant's fixed unit) x entered rate, half-up to 2 dp. Never floating point. */
export function computeFee({ netKg, unit, rate }: FeeInput): { quantity: string; rate: string; amount: string } {
  const r = dec(rate, "rate");
  if (r.isNegative()) throw new DomainError("negative_rate", "Price cannot be negative");
  const qty = weightInUnit(netKg, unit);
  return {
    quantity: qty.toDecimalPlaces(3).toFixed(3),
    rate: r.toFixed(2),
    amount: qty.mul(r).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
  };
}

export interface NumberFormat {
  prefix?: string;
  padding?: number;
}

/** Display format of an allocated sequence value. The DB allocates; this only renders. */
export function formatInvoiceNumber(n: number, { prefix = "", padding = 0 }: NumberFormat = {}): string {
  if (!Number.isInteger(n) || n < 0) throw new DomainError("invalid_sequence", "Sequence must be a non-negative integer");
  return `${prefix}${String(n).padStart(Math.max(0, padding), "0")}`;
}

/** Vehicle numbers are matched case/space-insensitively but displayed as entered. */
export function normalizeVehicle(reg: string): string {
  return reg.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
