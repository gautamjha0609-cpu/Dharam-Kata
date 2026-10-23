// Decides whether the weight on the indicator can be trusted RIGHT NOW. Pure code (time is passed in) so every rule is tested.
//
// A weight is accepted only when ALL of these hold:
//  1. frames with a failing checksum are thrown away (they never count, never reset anything else);
//  2. the newest frame is fresh (arrived less than FRESH_MS ago): an unplugged cable can never return an old weight;
//  3. at least MIN_FRAMES consecutive frames carry exactly the same weight, spanning at least MIN_SPAN_MS;
//  4. if the format reports motion, none of those frames says "moving";
//  5. the weight is a real mass in kg, not an overload / error frame.
import { toKg, type Reading } from "./protocols";

export const FRESH_MS = 1500;
export const MIN_FRAMES = 3;
export const MIN_SPAN_MS = 700;

export type ScaleState =
  | { kind: "no_data" }
  | { kind: "stale"; lastAt: number }
  | { kind: "overload" }
  | { kind: "bad_unit" }
  | { kind: "moving"; kg: number }
  | { kind: "stable"; kg: number; since: number; frames: number; raw: string };

interface Frame { at: number; kg: number | null; stable: boolean | null; overload: boolean; badUnit: boolean; raw: string }

export class WeightTracker {
  private frames: Frame[] = [];
  /** good frames received since start (for the diagnostics line) */
  count = 0;
  rejected = 0;
  constructor(private indicatorUnit: () => "kg" | "t" = () => "kg") {}

  push(r: Reading, at: number) {
    if (r.checksumOk === false) { this.rejected++; return; }
    const kg = r.value === null ? null : toKg(r.value, r.unit, this.indicatorUnit());
    this.frames.push({ at, kg, stable: r.stable, overload: r.overload, badUnit: r.value !== null && kg === null, raw: r.raw });
    this.count++;
    if (this.frames.length > 60) this.frames.splice(0, this.frames.length - 60);
  }

  reset() { this.frames = []; }

  state(now: number): ScaleState {
    const last = this.frames[this.frames.length - 1];
    if (!last) return { kind: "no_data" };
    if (now - last.at > FRESH_MS) return { kind: "stale", lastAt: last.at };
    if (last.overload) return { kind: "overload" };
    if (last.badUnit || last.kg === null) return { kind: "bad_unit" };
    // the run of identical weights ending with the newest frame
    let i = this.frames.length - 1;
    while (i > 0 && this.frames[i - 1]!.kg === last.kg) i--;
    const run = this.frames.slice(i);
    const moving = run.some((f) => f.stable === false);
    const span = last.at - run[0]!.at;
    if (moving || run.length < MIN_FRAMES || span < MIN_SPAN_MS) return { kind: "moving", kg: last.kg };
    return { kind: "stable", kg: last.kg, since: run[0]!.at, frames: run.length, raw: last.raw };
  }
}
