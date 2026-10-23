import { describe, expect, it } from "vitest";
import { ScaleManager, type Framing, type Link, type LinkFactory } from "./manager";

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const xk = (w: number) => {
  const body = "+" + String(w).padStart(6, "0") + "0";
  let x = 0; for (const c of body) x ^= c.charCodeAt(0);
  return "\x02" + body + (x >> 4).toString(16).toUpperCase() + (x & 15).toString(16).toUpperCase() + "\x03";
};

/** A fake indicator on a COM port: sends `frame()` every `everyMs` when opened at its own speed, garbage at any other speed. */
function fakeScale(o: { baud: number; framing?: Framing; frame: () => string; everyMs?: number; busy?: boolean; silent?: boolean }) {
  const opened: string[] = [];
  const written: string[] = [];
  const serial = (port: string, baud: number, framing: Framing): Link => {
    let timer: ReturnType<typeof setInterval> | null = null;
    return {
      async open(onData) {
        if (o.busy) throw new Error("Failed to open serial port (access denied)");
        opened.push(`${port}@${baud}/${framing}`);
        if (o.silent) return;
        const right = baud === o.baud && framing === (o.framing ?? "8N1");
        timer = setInterval(() => onData(right ? enc(o.frame()) : Uint8Array.from({ length: 12 }, (_, i) => (i * 97 + baud) & 0xff)), o.everyMs ?? 40);
      },
      async write(b) { written.push(String.fromCharCode(...b)); },
      async close() { if (timer) clearInterval(timer); },
    };
  };
  const factory: LinkFactory = { serial, tcp: () => serial("tcp", o.baud, "8N1"), sim: () => serial("sim", o.baud, "8N1"), listPorts: async () => [{ name: "COM3", label: "USB Serial (COM3)", usb: true, bluetooth: false }] };
  return { factory, opened, written };
}
const manager = (f: LinkFactory) => new ScaleManager(f, () => {}, () => {}, () => {});

describe("ScaleManager", () => {
  it("auto-detects speed and format, then reads the steady weight", async () => {
    const s = fakeScale({ baud: 2400, frame: () => xk(34210) });
    const m = manager(s.factory);
    const d = await m.autoDetect("COM3", { listenMs: 300 }, () => {});
    expect(d.ok && d.cfg).toMatchObject({ baud: 2400, framing: "8N1", protocol: "xk3190", port: "COM3" });
    if (!d.ok) return;
    await m.apply(d.cfg);
    const r = await m.read(3000);
    expect(r).toMatchObject({ ok: true, kg: 34210 });
    expect(s.written).toEqual([]); // never sent anything to the indicator
  });

  it("finds 8E1 indicators in the second pass", async () => {
    const s = fakeScale({ baud: 4800, framing: "8E1", frame: () => "ST,GS,+0012340kg\r\n" });
    const d = await manager(s.factory).autoDetect("COM3", { listenMs: 300 }, () => {});
    expect(d.ok && d.cfg).toMatchObject({ baud: 4800, framing: "8E1", protocol: "and_std" });
  });

  it("learns the format by itself when it is set to automatic", async () => {
    const s = fakeScale({ baud: 9600, frame: () => "  15105 kg\r\n" });
    const m = manager(s.factory);
    await m.apply({ enabled: true, source: "serial", port: "COM3", baud: 9600, framing: "8N1", protocol: "auto" });
    expect(await m.read(4000)).toMatchObject({ ok: true, kg: 15105 });
  });

  it("refuses a moving weight", async () => {
    let w = 30000;
    const s = fakeScale({ baud: 9600, frame: () => xk((w += 10)) });
    const m = manager(s.factory);
    await m.apply({ enabled: true, source: "serial", port: "COM3", baud: 9600, protocol: "xk3190" });
    expect(await m.read(1200)).toMatchObject({ ok: false, code: "unstable" });
  });

  it("refuses zero (empty bridge)", async () => {
    const s = fakeScale({ baud: 9600, frame: () => xk(0) });
    const m = manager(s.factory);
    await m.apply({ enabled: true, source: "serial", port: "COM3", baud: 9600, protocol: "xk3190" });
    expect(await m.read(2000)).toMatchObject({ ok: false, code: "zero_weight" });
  });

  it("says when nothing arrives", async () => {
    const s = fakeScale({ baud: 9600, frame: () => "", silent: true });
    const m = manager(s.factory);
    await m.apply({ enabled: true, source: "serial", port: "COM3", baud: 9600, protocol: "xk3190" });
    expect(await m.read(600)).toMatchObject({ ok: false, code: "no_data" });
    const d = await m.autoDetect("COM3", { listenMs: 20 }, () => {});
    expect(d.ok).toBe(false);
  });

  it("says when the COM port is used by another program", async () => {
    const s = fakeScale({ baud: 9600, frame: () => xk(1), busy: true });
    const m = manager(s.factory);
    await m.apply({ enabled: true, source: "serial", port: "COM3", baud: 9600, protocol: "xk3190" });
    expect(await m.read(400)).toMatchObject({ ok: false, code: "port_busy" });
    const d = await m.autoDetect("COM3", { listenMs: 20 }, () => {});
    expect(d.ok === false && d.message).toMatch(/could not be opened/);
  });

  it("only asks the indicator (read-only request) when told to", async () => {
    const s = fakeScale({ baud: 9600, frame: () => "S S     22340 kg\r\n" });
    const m = manager(s.factory);
    await m.apply({ enabled: true, source: "serial", port: "COM3", baud: 9600, protocol: "mt_sics", ask: true });
    expect(await m.read(3000)).toMatchObject({ ok: true, kg: 22340 });
    expect(s.written.every((w) => w === "SI\r\n")).toBe(true);
    expect(s.written.length).toBeGreaterThan(0);
  });

  it("not configured", async () => {
    const m = manager(fakeScale({ baud: 9600, frame: () => "" }).factory);
    expect(await m.read(100)).toMatchObject({ ok: false, code: "not_configured" });
  });
});
