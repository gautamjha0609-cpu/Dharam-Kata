// Real connections for the scale, used by ScaleManager:
//  - COM ports (RS-232, RS-485 converters, USB-serial adapters such as FTDI / CH340 / PL2303 / CP210x, Bluetooth serial) through
//    Chromium's Web Serial in a hidden helper window. No native module, so the same code runs in the x64, 32-bit and ARM installers.
//  - network indicators (TCP, e.g. an Ethernet indicator or a serial-to-Ethernet converter) through Node's net module.
//  - a simulator (only when DK_SCALE_SIM=1 is set) for demonstrations and end-to-end tests without a weighbridge.
// The helper window also keeps the "check now" signal from the server (Supabase Realtime broadcast), see ScaleHost.listen().
import { BrowserWindow, ipcMain, session, type IpcMainEvent } from "electron";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import type { Framing, Link, LinkFactory, PortInfo } from "./manager";

interface SerialPortItem { portId: string; portName: string; displayName?: string; vendorId?: string; productId?: string }

export class ScaleHost implements LinkFactory {
  private win: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private lastList: SerialPortItem[] = [];
  private want: string | null = null;
  private dataSink: ((b: Uint8Array) => void) | null = null;
  private closedSink: ((code: string, message: string) => void) | null = null;
  private busy: Promise<unknown> = Promise.resolve();
  private signal: ((name: string) => void) | null = null;
  private onListening: (() => void) | null = null;
  /** the "check now" signal channel is connected right now */
  listening = false;
  private signalCfg: string | null = null;

  constructor(private readonly preload: string, private readonly page: string, private readonly log: (m: string) => void) {
    const ses = session.fromPartition("dk-scale");
    // only the helper window may use serial ports; the port it gets is the one ScaleHost asked for, nothing else
    ses.on("select-serial-port", (event, portList, wc, callback) => {
      event.preventDefault();
      if (!this.win || wc.id !== this.win.webContents.id) return callback("");
      this.lastList = portList as SerialPortItem[];
      const p = this.want ? this.lastList.find((x) => x.portName.toUpperCase() === this.want!.toUpperCase()) : undefined;
      callback(p ? p.portId : "");
    });
    ses.setPermissionCheckHandler((wc, permission) => permission === "serial" && !!this.win && wc?.id === this.win.webContents.id);
    ses.setDevicePermissionHandler((d) => d.deviceType === "serial");
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    ipcMain.on("scale-data", (e: IpcMainEvent, b: Uint8Array) => { if (this.fromHelper(e)) this.dataSink?.(b instanceof Uint8Array ? b : new Uint8Array(b)); });
    ipcMain.on("scale-event", (e: IpcMainEvent, ev: { type: string; name?: unknown; message?: string; status?: string }) => {
      if (!this.fromHelper(e)) return;
      if (ev.type === "lost") this.closedSink?.("port_lost", "The scale's cable or USB adapter was disconnected.");
      else if (ev.type === "closed") this.closedSink?.("port_lost", ev.message || "The scale connection closed.");
      else if (ev.type === "signal") this.signal?.(typeof ev.name === "string" ? ev.name : "");
      else if (ev.type === "read_error") this.log(`Scale line error (${ev.name}): ${ev.message ?? ""}`);
      else if (ev.type === "rt") {
        const now = ev.status === "listening";
        if (now !== this.listening) this.log(`Realtime signal: ${ev.status}`); // only changes, not every reconnect attempt
        this.listening = now;
        if (now) this.onListening?.(); // (re)connected: anything sent while it was away is picked up at once
      }
    });
  }

  private fromHelper(e: IpcMainEvent) { return !!this.win && !this.win.isDestroyed() && e.sender.id === this.win.webContents.id; }

  private helper(): Promise<void> {
    if (this.win && !this.win.isDestroyed() && this.ready) return this.ready;
    this.win = new BrowserWindow({
      show: false, width: 200, height: 100,
      webPreferences: { partition: "dk-scale", preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    this.win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.win.webContents.on("will-navigate", (e) => e.preventDefault());
    this.win.webContents.on("render-process-gone", () => {
      this.log("Scale helper restarted");
      this.closedSink?.("port_lost", "The scale helper stopped; reconnecting.");
      this.listening = false;
      this.win = null; this.ready = null;
      if (this.signalCfg) setTimeout(() => void this.listenRaw(), 2000);
    });
    this.ready = this.win.loadFile(this.page).then(() => undefined);
    return this.ready;
  }

  /** Runs a helper function as if the person clicked (Web Serial only opens ports from a user gesture). One at a time. */
  private run<T>(code: string): Promise<T> {
    const next = this.busy.then(async () => { await this.helper(); return this.win!.webContents.executeJavaScript(code, true) as Promise<T>; });
    this.busy = next.catch(() => undefined);
    return next;
  }

  async listPorts(): Promise<PortInfo[]> {
    this.want = null;
    await this.run("window.dkScan()");
    // only real COM ports (Chromium also lists Bluetooth audio services by MAC address); each port once
    const seen = new Set<string>();
    return this.lastList.filter((p) => /^COM\d{1,3}$/i.test(p.portName) && !seen.has(p.portName.toUpperCase()) && !!seen.add(p.portName.toUpperCase())).map((p) => {
      const label = p.displayName ? `${p.displayName}` : p.portName;
      return { name: p.portName, label: label.includes(p.portName) ? label : `${label} (${p.portName})`, usb: !!p.vendorId, bluetooth: /bluetooth|bthenum/i.test(label) };
    }).sort((a, b) => Number(a.name.replace(/\D/g, "")) - Number(b.name.replace(/\D/g, "")));
  }

  serial(port: string, baud: number, framing: Framing): Link {
    const parity = framing === "8E1" ? "even" : framing === "8O1" ? "odd" : "none";
    return {
      open: async (onData, onClosed) => {
        this.want = port;
        this.dataSink = onData; this.closedSink = onClosed;
        const r = await this.run<{ ok: boolean; code?: string; message?: string }>(`window.dkOpen(${JSON.stringify({ baudRate: baud, dataBits: 8, stopBits: 1, parity })})`);
        this.want = null;
        if (!r.ok) {
          this.dataSink = null; this.closedSink = null;
          throw new Error(r.code === "port_not_found" ? `${port} was not found on this PC` : `${port} is busy or could not be opened (access denied / in use): ${r.message ?? ""}`);
        }
      },
      write: async (b) => { await this.run(`window.dkWrite(${JSON.stringify([...b])})`); },
      close: async () => { this.dataSink = null; this.closedSink = null; await this.run("window.dkClose()").catch(() => {}); },
    };
  }

  tcp(host: string, port: number): Link {
    let sock: Socket | null = null;
    return {
      open: (onData, onClosed) => new Promise<void>((resolve, reject) => {
        let opened = false;
        sock = connect({ host, port, timeout: 5000 }, () => { opened = true; sock!.setTimeout(0); sock!.setKeepAlive(true, 10_000); resolve(); });
        sock.on("data", (d: Buffer) => onData(new Uint8Array(d)));
        sock.on("timeout", () => sock?.destroy(new Error(`No answer from ${host}:${port}`)));
        sock.on("error", (e) => { if (!opened) reject(e); });
        sock.on("close", () => { if (opened) onClosed("port_lost", `The network scale ${host}:${port} disconnected.`); });
      }),
      write: async (b) => { sock?.write(Buffer.from(b)); },
      close: async () => { const s = sock; sock = null; s?.removeAllListeners("close"); s?.destroy(); },
    };
  }

  /** Simulated XK3190 indicator: empty bridge, a vehicle drives on, settles, drives off. 10 frames a second. */
  sim(): Link {
    let timer: ReturnType<typeof setInterval> | null = null;
    return {
      open: async (onData) => {
        const start = Date.now();
        timer = setInterval(() => {
          const t = ((Date.now() - start) / 1000) % 30;
          const target = t < 4 ? 0 : t < 7 ? Math.round(34210 * (t - 4) / 3 / 10) * 10 : t < 19 ? 34210 : t < 22 ? Math.round(34210 * (22 - t) / 3 / 10) * 10 : 0;
          const body = "+" + String(Math.max(0, target)).padStart(6, "0") + "0";
          let x = 0; for (const c of body) x ^= c.charCodeAt(0);
          const frame = "\x02" + body + (x >> 4).toString(16).toUpperCase() + (x & 15).toString(16).toUpperCase() + "\x03";
          onData(Uint8Array.from(frame, (c) => c.charCodeAt(0)));
        }, 100);
      },
      write: async () => {},
      close: async () => { if (timer) clearInterval(timer); },
    };
  }

  /**
   * Listens for the server's "check now" signal (Supabase Realtime broadcast on this PC's secret topic). The signal carries no data:
   * the agent then asks the server, with its own credential, what to do. Without it the 5-second poll still picks requests up.
   */
  listen(cfg: { url: string; key: string; topic: string } | null, onSignal: (name: string) => void, onListening?: () => void) {
    const next = cfg ? JSON.stringify(cfg) : null;
    this.signal = onSignal;
    this.onListening = onListening ?? null;
    if (!next) this.listening = false;
    if (next === this.signalCfg) return;
    this.signalCfg = next;
    void this.listenRaw();
  }
  private async listenRaw() {
    await this.run(this.signalCfg ? `window.dkSignal(${this.signalCfg})` : "window.dkSignal(null)").catch(() => {});
  }
}

export const helperFiles = (dir: string) => ({ preload: join(dir, "scale-preload.js"), page: join(dir, "ui", "scale.html") });
