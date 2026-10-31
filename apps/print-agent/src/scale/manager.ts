// The weighing scale on this PC: one connection (COM port, network or simulator), decoding, the stability rules, auto-detection
// and the "read the weight now" answer the website asks for. Nothing is ever sent to the indicator unless the person turns on
// "ask the indicator" for a format that needs it (and then only that format's READ-ONLY request).
import { ASKED, CONTINUOUS, Decoder, PROTOCOLS, bytesToText, detect, readability, showRaw, type ProtocolId } from "./protocols";
import { WeightTracker, type ScaleState } from "./tracker";

export type Framing = "8N1" | "8E1" | "8O1";
export interface ScaleConfig {
  enabled: boolean;
  source: "serial" | "tcp" | "sim";
  port?: string;
  baud?: number;
  framing?: Framing;
  /** the top bit is a parity bit (7E1 / 7O1 indicators): decode with it cleared */
  mask7?: boolean;
  protocol?: ProtocolId | "auto";
  unit?: "kg" | "t";
  host?: string;
  tcpPort?: number;
  /** send the format's read-only request while reading (only for formats that do not send by themselves) */
  ask?: boolean;
  /** a steady weight below this is an empty bridge (dirt, water, zero drift), not a vehicle; default MIN_VEHICLE_KG */
  minKg?: number;
}

/** Legal minimum of a weighbridge with 10 kg divisions (20 divisions). Below this the bridge counts as empty. */
export const MIN_VEHICLE_KG = 200;

/** A connection that delivers bytes. */
export interface Link {
  open(onData: (b: Uint8Array) => void, onClosed: (code: string, message: string) => void): Promise<void>;
  write(b: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
export interface LinkFactory {
  serial(port: string, baud: number, framing: Framing): Link;
  tcp(host: string, port: number): Link;
  sim(): Link;
  listPorts(): Promise<PortInfo[]>;
}
export interface PortInfo { name: string; label: string; usb: boolean; bluetooth: boolean }

export type ReadCode = "not_configured" | "no_data" | "unstable" | "overload" | "bad_unit" | "zero_weight" | "negative_weight" | "port_busy" | "port_lost" | "connecting";
export type ReadResult = { ok: true; kg: number; raw: string; frames: number } | { ok: false; code: ReadCode; message: string };

export const READ_MESSAGES: Record<ReadCode, string> = {
  not_configured: "No weighing scale is set up on the printer PC.",
  no_data: "No weight is coming from the scale. Check that the indicator is on and the cable is connected.",
  unstable: "The weight is not steady. Wait until the vehicle stops moving, then tap Detect weight again.",
  overload: "The scale shows overload or an error.",
  bad_unit: "The scale sends a unit that is not kg or tonne. Set the indicator to kg.",
  zero_weight: "The scale shows 0 or almost 0 (empty weighbridge). Is the vehicle on the weighbridge?",
  negative_weight: "The scale shows a negative weight. Zero the indicator with the bridge empty.",
  port_busy: "The scale's COM port could not be opened. Close any other weighing software that uses it, or check the cable.",
  port_lost: "The scale's cable or USB adapter was disconnected.",
  connecting: "Connecting to the scale…",
};

export const SERIAL_BAUDS = [9600, 2400, 4800, 1200, 19200, 38400, 57600, 115200];
const now = () => Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ScaleStatus {
  enabled: boolean;
  source: ScaleConfig["source"];
  port: string | null;
  protocol: ProtocolId | null;
  link: "off" | "connecting" | "open" | "error";
  error: { code: ReadCode; message: string } | null;
  state: ScaleState;
  lastDataAt: number | null;
  frames: number;
  rejected: number;
  /** last bytes received, readable, for the diagnostics box */
  lastRaw: string;
}

export class ScaleManager {
  private cfg: ScaleConfig = { enabled: false, source: "serial" };
  private link: Link | null = null;
  private decoder: Decoder | null = null;
  private tracker: WeightTracker;
  private rawTail = new Uint8Array(0);
  private linkState: ScaleStatus["link"] = "off";
  private error: ScaleStatus["error"] = null;
  private lastDataAt: number | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private detecting = false;
  private detectedAt = 0;

  constructor(private readonly links: LinkFactory, private readonly onChange: () => void, private readonly onLearned: (c: Partial<ScaleConfig>) => void, private readonly log: (m: string) => void) {
    this.tracker = new WeightTracker(() => this.cfg.unit ?? "kg");
  }

  config() { return { ...this.cfg }; }
  listPorts() { return this.links.listPorts(); }

  /** Applies a (new) configuration: closes the old connection and opens the new one. */
  async apply(cfg: ScaleConfig) {
    this.cfg = { ...cfg };
    await this.stop();
    if (cfg.enabled && !this.detecting) void this.start();
  }

  status(): ScaleStatus {
    return {
      enabled: this.cfg.enabled, source: this.cfg.source, port: this.cfg.source === "serial" ? this.cfg.port ?? null : this.cfg.source === "tcp" ? `${this.cfg.host}:${this.cfg.tcpPort}` : "simulator",
      protocol: this.decoder?.protocol ?? null, link: this.linkState, error: this.error, state: this.tracker.state(now()),
      lastDataAt: this.lastDataAt, frames: this.tracker.count, rejected: this.tracker.rejected, lastRaw: showRaw(bytesToText(this.rawTail.slice(-64), this.cfg.mask7)),
    };
  }

  /** What the server is told (heartbeat): enough for the website to show "Scale connected" and to enable the Detect button. */
  summary() {
    const s = this.status();
    return {
      enabled: s.enabled, source: s.source, port: s.port, protocol: s.protocol, link: s.link,
      state: s.state.kind, error: s.error?.code ?? null, last_data_at: s.lastDataAt ? new Date(s.lastDataAt).toISOString() : null,
    };
  }

  private makeLink(): Link | null {
    const c = this.cfg;
    if (c.source === "sim") return this.links.sim();
    if (c.source === "tcp") return c.host && c.tcpPort ? this.links.tcp(c.host, c.tcpPort) : null;
    return c.port ? this.links.serial(c.port, c.baud ?? 9600, c.framing ?? "8N1") : null;
  }

  private async start() {
    const gen = ++this.generation;
    const link = this.makeLink();
    if (!link) { this.linkState = "error"; this.error = { code: "not_configured", message: READ_MESSAGES.not_configured }; this.onChange(); return; }
    this.link = link;
    this.linkState = "connecting"; this.error = null;
    this.tracker.reset();
    const proto = this.cfg.protocol && this.cfg.protocol !== "auto" ? this.cfg.protocol : null;
    this.decoder = proto ? new Decoder(proto, !!this.cfg.mask7) : null;
    this.onChange();
    try {
      await link.open((b) => { if (gen === this.generation) this.onData(b); }, (code, message) => {
        if (gen !== this.generation) return;
        this.linkState = "error"; this.error = { code: code === "port_busy" ? "port_busy" : "port_lost", message: message || READ_MESSAGES.port_lost };
        this.log(`Scale connection closed: ${message || code}`);
        this.link = null;
        this.onChange();
        this.scheduleReconnect(gen);
      });
      if (gen !== this.generation) { await link.close().catch(() => {}); return; }
      this.linkState = "open";
      this.log(`Scale connected (${this.status().port})`);
    } catch (e) {
      if (gen !== this.generation) return;
      const message = e instanceof Error ? e.message : String(e);
      const code = /busy|access|denied|open|in use/i.test(message) ? "port_busy" : "port_lost";
      this.linkState = "error"; this.error = { code, message: READ_MESSAGES[code] };
      this.link = null;
      this.log(`Scale could not be opened: ${message}`);
      this.scheduleReconnect(gen);
    }
    this.onChange();
  }

  private scheduleReconnect(gen: number) {
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = setTimeout(() => { if (gen === this.generation && this.cfg.enabled && !this.detecting) void this.start(); }, 4000);
  }

  private async stop() {
    this.generation++;
    if (this.reconnect) { clearTimeout(this.reconnect); this.reconnect = null; }
    const l = this.link;
    this.link = null;
    this.linkState = "off";
    if (l) await l.close().catch(() => {});
  }

  private onData(b: Uint8Array) {
    this.lastDataAt = now();
    const tail = new Uint8Array(Math.min(this.rawTail.length + b.length, 2048));
    const joined = new Uint8Array(this.rawTail.length + b.length);
    joined.set(this.rawTail); joined.set(b, this.rawTail.length);
    tail.set(joined.slice(-tail.length));
    this.rawTail = tail;
    if (!this.decoder) {
      // format not known yet (or set to automatic): learn it from what arrives, at the speed already set
      if (now() - this.detectedAt > 500 && this.rawTail.length >= 48) {
        this.detectedAt = now();
        const d = detect(this.rawTail);
        if (d) {
          this.decoder = new Decoder(d.protocol, d.mask7);
          this.cfg.protocol = d.protocol; this.cfg.mask7 = d.mask7;
          this.onLearned({ protocol: d.protocol, mask7: d.mask7 });
          this.log(`Scale format recognised: ${PROTOCOLS[d.protocol].name}`);
          for (const r of d.readings) this.tracker.push(r, now());
        }
      }
      this.onChange();
      return;
    }
    for (const r of this.decoder.push(b)) this.tracker.push(r, now());
    this.onChange();
  }

  /** "Detect weight" from the website: the steady weight within `timeoutMs`, or the reason there is none. */
  async read(timeoutMs = 8000): Promise<ReadResult> {
    if (!this.cfg.enabled) return { ok: false, code: "not_configured", message: READ_MESSAGES.not_configured };
    if (!this.link && !this.detecting) { void this.start(); }
    const deadline = now() + timeoutMs;
    const proto = this.decoder?.protocol;
    const ask = this.cfg.ask && proto && ASKED.includes(proto) ? new TextEncoder().encode(PROTOCOLS[proto].request) : null;
    let lastAsk = 0;
    while (now() < deadline) {
      if (ask && this.link && now() - lastAsk > 400) { lastAsk = now(); await this.link.write(ask).catch(() => {}); }
      const s = this.tracker.state(now());
      if (s.kind === "stable") {
        if (s.kg < 0) return { ok: false, code: "negative_weight", message: READ_MESSAGES.negative_weight };
        if (s.kg < (this.cfg.minKg ?? MIN_VEHICLE_KG)) return { ok: false, code: "zero_weight", message: READ_MESSAGES.zero_weight };
        return { ok: true, kg: s.kg, raw: s.raw, frames: s.frames };
      }
      await sleep(100);
    }
    const s = this.tracker.state(now());
    if (this.error && (s.kind === "no_data" || s.kind === "stale")) return { ok: false, code: this.error.code, message: this.error.message };
    const code: ReadCode = s.kind === "moving" ? "unstable" : s.kind === "overload" ? "overload" : s.kind === "bad_unit" ? "bad_unit" : this.linkState === "connecting" ? "connecting" : "no_data";
    return { ok: false, code, message: READ_MESSAGES[code] };
  }

  /**
   * Finds how the indicator on a COM port talks: listens at each common speed (8N1; 7-bit + parity is decoded from the same
   * capture), then 8E1 / 8O1. Optionally sends the read-only requests of the formats that only answer when asked.
   */
  async autoDetect(port: string, opts: { ask?: boolean; listenMs?: number }, progress: (text: string) => void): Promise<{ ok: true; cfg: ScaleConfig } | { ok: false; message: string; sample?: string }> {
    this.detecting = true;
    await this.stop();
    const listenMs = opts.listenMs ?? 1600;
    let heardText: string | undefined;
    try {
      const tries: [number, Framing][] = [...SERIAL_BAUDS.map((b) => [b, "8N1"] as [number, Framing]), ...[9600, 2400, 4800, 19200, 1200].flatMap((b) => [[b, "8E1"], [b, "8O1"]] as [number, Framing][])];
      for (const [baud, framing] of tries) {
        progress(`Listening on ${port} at ${baud} baud (${framing})…`);
        const r = await this.capture(this.links.serial(port, baud, framing), listenMs);
        if (r.error) return { ok: false, message: r.error };
        if (!r.data.length) continue;
        const d = detect(r.data);
        if (d) return { ok: true, cfg: { ...this.cfg, enabled: true, source: "serial", port, baud, framing, mask7: d.mask7, protocol: d.protocol } };
        if (readability(r.data) > 0.85 || readability(r.data, true) > 0.9) heardText ??= showRaw(bytesToText(r.data.slice(0, 96), readability(r.data) <= 0.85));
      }
      if (opts.ask) {
        for (const id of ASKED) for (const baud of [9600, 2400, 4800, 19200, 1200]) {
          progress(`Asking on ${port} at ${baud} baud (${PROTOCOLS[id].name})…`);
          const r = await this.capture(this.links.serial(port, baud, "8N1"), 900, new TextEncoder().encode(PROTOCOLS[id].request));
          if (r.error) return { ok: false, message: r.error };
          const d = detect(r.data, 1);
          if (d && d.protocol === id) return { ok: true, cfg: { ...this.cfg, enabled: true, source: "serial", port, baud, framing: "8N1", mask7: d.mask7, protocol: id, ask: true } };
        }
      }
      return heardText
        ? { ok: false, message: "Data arrives but its format is not known. Set the indicator's serial output to continuous mode (often called tF=0 / CONT), or contact support with the sample below.", sample: heardText }
        : { ok: false, message: "Nothing arrives on this port. Check the cable (the PC's RX must meet the indicator's TX), that the indicator's serial output is switched on, and that this is the right COM port." };
    } finally {
      this.detecting = false;
    }
  }

  /** Opens a link, optionally sends a request, collects bytes for `ms`, closes. */
  private async capture(link: Link, ms: number, request?: Uint8Array): Promise<{ data: Uint8Array; error?: string }> {
    const chunks: Uint8Array[] = [];
    let closedWith = "";
    try {
      await link.open((b) => chunks.push(b), (_c, m) => { closedWith = m; });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return { data: new Uint8Array(0), error: /busy|access|denied|in use|open/i.test(m) ? READ_MESSAGES.port_busy : `The port could not be opened: ${m}` };
    }
    try {
      if (request) await link.write(request).catch(() => {});
      await sleep(ms);
    } finally {
      await link.close().catch(() => {});
    }
    void closedWith;
    const size = chunks.reduce((n, c) => n + c.length, 0);
    const data = new Uint8Array(size);
    let o = 0; for (const c of chunks) { data.set(c, o); o += c.length; }
    return { data };
  }
}

export { CONTINUOUS };
