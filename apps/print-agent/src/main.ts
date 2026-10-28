import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, session, shell, Tray } from "electron";
import { hostname, release } from "node:os";
import { join } from "node:path";
import { isPdfPrinter, isVirtualPrinter, renderCalibrationHtml, renderHtml, ticketPreset } from "@dk/print-template";
import { AgentCore } from "./core";
import { DailyBackup } from "./backup";
import { ElectronPrinter } from "./electron-printer";
import { HttpApi, HttpError, pair, type AgentState } from "./http-api";
import { DirectApi, DirectUnavailable, Router, infoSignature, type PingInfo } from "./direct-api";
import { machineId, newSeed } from "./machine-id";
import { logFilePath, logLine } from "./logger";
import { FileJournal, clearToken, loadConfig, loadToken, saveConfig, saveToken } from "./store";
import { ScaleManager, type ScaleConfig } from "./scale/manager";
import { ScaleHost, helperFiles } from "./scale/links";
import { PROTOCOLS, type ProtocolId } from "./scale/protocols";

// Set at build time to your deployed website (must be HTTPS in production).
const DEFAULT_SERVER = process.env.DK_SERVER_URL || "https://dharam-kata-kappa.vercel.app";
// Addresses the website had before. A PC paired there is moved to the current address at start (no new pairing: same database).
const OLD_SERVERS = ["https://dharam-kata.vercel.app"];
// pairing and settings live in one folder for ALL versions, so updating the agent never needs pairing again
// (DK_USER_DATA: a separate folder for development tests only, so a test run never touches the real pairing)
app.setPath("userData", process.env.DK_USER_DATA || join(app.getPath("appData"), "Dharam Kata Print Agent"));
// the installer removes every older version, so only the newest is installed
const APP_ID = `in.thevaluationhouse.dharamkata.printagent.v${app.getVersion().replace(/\./g, "-")}`;
const PRODUCT = `Dharam Kata Print Agent ${app.getVersion()}`;
const POLL_MS = 5_000;
const MAX_POLL_MS = 60_000; // while the server cannot be reached the agent backs off instead of knocking every 5 s
const HEARTBEAT_MS = 30_000;
// with the direct route the heartbeat sends "still here" only; the full details (printers, version, scale) go when they change and at
// least this often
const FULL_INFO_MS = 5 * 60_000;

// One agent per PC. A second launch just brings the first one forward.
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.exit(0);

// A print agent needs no GPU: switching it off saves memory and avoids driver problems on old or unusual PCs.
app.disableHardwareAcceleration();
app.setAppUserModelId(APP_ID);

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
const printer = new ElectronPrinter((fileName) => {
  return backup ? backup.pdfPath(fileName) : join(loadConfig(DEFAULT_SERVER).backupDir || defaultBackupDir(), "PDFs", `${fileName}.pdf`);
});
const log: string[] = [];
const state = { connected: false, lastError: "", lastJob: "", printers: [] as string[], jobsPrinted: 0 };
let core: AgentCore | null = null;
let api: HttpApi | null = null; // the website (all agents before 0.1.9 used only this)
let direct: DirectApi | null = null; // the database itself, without the website (0.1.9+)
let link: Router | null = null; // direct when possible, else the website
let journal: FileJournal;
let backup: DailyBackup;
const defaultBackupDir = () => join(app.getPath("documents"), "DharamKata Backup");
// the weighing scale (optional): read only when the website asks ("Detect weight"); the simulator exists only with DK_SCALE_SIM=1
const SIM = process.env.DK_SCALE_SIM === "1";
let scaleHost: ScaleHost | null = null;
let scale: ScaleManager | null = null;
let scalePorts: { name: string; label: string; usb: boolean; bluetooth: boolean }[] = [];
let scaleDetect = { running: false, text: "", result: null as null | { ok: boolean; message: string; sample?: string } };
let scaleTest: { at: string; ok: boolean; text: string } | null = null;
// the window is told about scale changes at most 4 times a second (an indicator sends ~10 frames a second)
let uiTimer: ReturnType<typeof setTimeout> | null = null;
const uiChanged = () => { if (!uiTimer) uiTimer = setTimeout(() => { uiTimer = null; win?.webContents.send("state-changed"); }, 250); };
const uiFile = (name: string) => join(__dirname, "ui", name);

const note = (m: string) => {
  log.push(`${new Date().toLocaleTimeString()} ${m}`);
  if (log.length > 100) log.shift();
  logLine(m);
  win?.webContents.send("state-changed");
};

// Whatever goes wrong, the agent keeps running and writes it to agent.log.
process.on("uncaughtException", (e) => { logLine(`uncaughtException: ${e?.stack ?? e}`); });
process.on("unhandledRejection", (e) => { logLine(`unhandledRejection: ${e instanceof Error ? e.stack : String(e)}`); });

let machine: Promise<string> | null = null;
/** Stable id of this PC (hash), computed once. */
function thisMachine(): Promise<string> {
  machine ??= machineId(() => {
    const cfg = loadConfig(DEFAULT_SERVER);
    if (cfg.machineSeed) return cfg.machineSeed;
    const seed = newSeed();
    saveConfig({ ...cfg, machineSeed: seed });
    return seed;
  });
  return machine;
}

/** Saves what the server says about this PC: approval and THE printer it may print on. */
function applyState(st: AgentState | null | undefined) {
  if (!st) return;
  const cfg = loadConfig(DEFAULT_SERVER);
  if (cfg.approval !== st.approval || (cfg.printer ?? null) !== st.printer) note(st.approval === "pending" ? "Waiting for approval on the website" : `Printer for this PC: ${st.printer ?? "not chosen"}`);
  saveConfig({ ...cfg, approval: st.approval, printer: st.printer, request: st.request ? { kind: st.request.kind, printer: st.request.printer } : null });
}

function setupAgent() {
  const cfg = loadConfig(DEFAULT_SERVER);
  const token = loadToken();
  if (!cfg.agentId || !token) { core = null; api = null; direct = null; link = null; return; }
  api = new HttpApi(cfg.serverUrl, token);
  direct = cfg.direct?.url && cfg.direct.key ? new DirectApi(cfg.direct, token, (u, i) => net.fetch(u, i)) : null;
  link = new Router(() => direct, () => api!, note);
  lastInfo = "";
  // jobs only ever go to the printer approved for this PC; a mismatch first asks the server again (a change may just have been approved)
  core = new AgentCore(link, printer, journal, note, backup, () => new Date(), async (refresh) => {
    if (refresh) await heartbeat();
    return loadConfig(DEFAULT_SERVER).printer ?? null;
  });
}

const describe = (e: unknown) => (e instanceof Error ? e.message : "Unknown error");
const friendly = (e: unknown) => {
  if (e instanceof HttpError && e.status === 401) return "This PC was revoked or its credential is invalid. Pair it again.";
  const m = describe(e);
  return /fetch failed|network|ENOTFOUND|ECONN|ETIMEDOUT|ERR_|timeout|aborted/i.test(m) ? "Cannot reach the server. Check the internet connection (the agent keeps trying)." : m;
};

function refreshTray() {
  tray?.setToolTip(`Dharam Kata Print Agent - ${api ? (state.connected ? "connected" : "not connected") : "not paired"}`);
}

async function heartbeat() {
  if (!api) {
    // not paired yet: keep the printer list fresh for the first-run printer choice
    try { state.printers = await printer.list(); } catch { /* ignore */ }
    win?.webContents.send("state-changed");
    return;
  }
  try {
    const withStatus = await printer.listWithStatus();
    state.printers = withStatus.map((p) => p.name);
    const summary = scale?.summary() ?? null;
    const d = link?.usable();
    let done = false;
    if (d) {
      const info: PingInfo = { version: app.getVersion(), os: `Windows ${release()}`, printers: withStatus, machine_id: await thisMachine(), ...(summary ? { scale: summary } : {}) };
      const sig = infoSignature(info);
      const full = sig !== lastInfo || Date.now() - lastInfoAt > FULL_INFO_MS;
      try {
        const r = await d.ping(full ? info : null);
        if (full) { lastInfo = sig; lastInfoAt = Date.now(); }
        applyState(r.state);
        // the "check now" signal: a queued slip prints at once and a weight request is answered at once; nothing is polled meanwhile
        const c = loadConfig(DEFAULT_SERVER).direct;
        scaleHost?.listen(r.topic && c ? { url: c.url, key: c.key, topic: r.topic } : null, onSignal, onListening);
        // safety net: work the signal did not announce (e.g. sent while the connection was down)
        if (r.jobs) void drainJobs();
        if (r.weights) void checkWeights();
        scheduleRetry(r.next_job_in_ms);
        done = true;
      } catch (e) {
        if (!(e instanceof DirectUnavailable)) throw e;
        link!.down(e);
        lastInfo = "";
      }
    }
    if (!done) {
      // through the website, exactly as before 0.1.9
      const r = await api.heartbeat(app.getVersion(), `Windows ${release()}`, withStatus, await thisMachine(), summary);
      applyState(r?.state);
      rememberDirect(r?.direct ?? null);
      // the "check now" signal is only needed while a scale is set up (jobs are polled every 5 s on this route)
      scaleHost?.listen(scale?.config().enabled ? r?.signal ?? null : null, onSignal, onListening);
    }
    state.connected = true; state.lastError = "";
  } catch (e) {
    state.connected = false;
    state.lastError = friendly(e);
  }
  refreshTray();
  win?.webContents.send("state-changed");
}

let lastInfo = "";
let lastInfoAt = 0;

/** The website tells where the database is; from then on the agent talks to it directly. */
function rememberDirect(d: { url: string; key: string } | null) {
  if (!d?.url || !d.key || !/^https:\/\//.test(d.url)) return;
  const cfg = loadConfig(DEFAULT_SERVER);
  if (cfg.direct?.url === d.url && cfg.direct.key === d.key) return;
  saveConfig({ ...cfg, direct: { url: d.url, key: d.key } });
  const token = loadToken();
  direct = token ? new DirectApi({ url: d.url, key: d.key }, token, (u, i) => net.fetch(u, i)) : null;
  lastInfo = "";
  note("Printing and weight requests now go straight to the database (instant signal, no polling).");
}

/** Signals arrive and nothing is polled: only while the direct route works AND the signal channel is connected. */
const eventMode = () => !!link?.usable() && !!scaleHost?.listening;

/** "check now" from the server: "job" = a slip is queued for this PC, "weigh" = Detect weight was tapped. */
function onSignal(name: string) {
  if (name !== "weigh") void drainJobs();
  if (name !== "job") void checkWeights();
}
/** The signal channel (re)connected: pick up anything that was sent while it was away. */
function onListening() { void drainJobs(); void checkWeights(); }

/** A job waits for an automatic retry: claim it when its time comes (instead of polling for it). */
let retryTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRetry(ms: number | null) {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (ms === null || !Number.isFinite(ms)) return;
  retryTimer = setTimeout(() => { retryTimer = null; void drainJobs(); }, Math.min(Math.max(ms, 0), 10 * 60_000) + 500);
}

/**
 * Answers the website's "Detect weight" requests for this PC: reads the steady weight from the scale and sends it back.
 * Triggered by the server's signal (within a second); without the signal channel, by every 5-second poll.
 */
let weighing = false;
async function checkWeights() {
  if (!link || !scale || weighing || !scale.config().enabled) return;
  weighing = true;
  try {
    for (let i = 0; i < 5; i++) {
      const req = await link.nextWeightRead();
      if (!req) break;
      const r = await scale.read(8000);
      await link.finishWeightRead(req.id, r.ok ? { ok: true, kg: r.kg, raw: r.raw, frames: r.frames } : { ok: false, code: r.code });
      note(r.ok ? `Weight sent to the website: ${r.kg} kg` : `Weight not sent: ${r.message}`);
    }
  } catch (e) {
    logLine(`weight request failed: ${describe(e)}`);
  } finally {
    weighing = false;
  }
}

/** Every 5 s, but only when signals cannot arrive (website route, or the signal channel is down): then it works exactly as before. */
async function poll() {
  if (eventMode()) return;
  void checkWeights();
  await drainJobs();
}

let busy = false;
async function drainJobs() {
  if (!core || busy) return;
  busy = true;
  try {
    // drain: keep going while there are jobs, so a burst is not delayed by the poll interval
    await backup.flush(); // refresh any Excel file that was open/locked earlier
    for (let i = 0; i < 20; i++) {
      const r = await core.tick();
      if (r === "idle") break;
      state.lastJob = `${new Date().toLocaleTimeString()} ${r}`;
      if (r === "printed") state.jobsPrinted++;
      win?.webContents.send("state-changed");
    }
    state.connected = true;
  } catch (e) {
    state.connected = false;
    state.lastError = friendly(e);
  } finally {
    busy = false;
    refreshTray();
  }
}

/** Runs `fn` again after `ms`; after a failure the wait doubles (up to a minute), after a success it goes back to normal. */
function loop(fn: () => Promise<void>, ms: number, backoff: boolean) {
  let delay = ms;
  const run = async () => {
    await fn();
    delay = backoff && !state.connected && api ? Math.min(delay * 2, MAX_POLL_MS) : ms;
    setTimeout(() => void run(), delay);
  };
  setTimeout(() => void run(), delay);
}

function createWindow(showAtStart: boolean) {
  win = new BrowserWindow({
    width: 580, height: 760, minWidth: 460, minHeight: 520, show: false, title: "Dharam Kata Print Agent", autoHideMenuBar: true,
    backgroundColor: "#f4f7fa", icon: uiFile("icon.png"),
    webPreferences: { preload: join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.removeMenu();
  // the window only ever shows our own page: no pop-ups, no navigation away
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  void win.loadFile(uiFile("index.html"));
  // shown once the page has loaded (the window background matches the page, so there is no white flash); did-finish-load is used because
  // ready-to-show can be late when hardware acceleration is off
  win.webContents.once("did-finish-load", () => { if (showAtStart) win?.show(); });
  // closing the window keeps the agent running in the tray
  win.on("close", (e) => { if (!quitting) { e.preventDefault(); win?.hide(); } });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow(true);
  else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
}

/** Opens the firm's website in the normal browser. Only the address this agent is paired with (https, or localhost while testing). */
function openWebsite() {
  const url = loadConfig(DEFAULT_SERVER).serverUrl;
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || ["localhost", "127.0.0.1"].includes(u.hostname)) void shell.openExternal(u.origin);
  } catch { /* ignore a malformed address */ }
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(uiFile("tray.png")));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Dharam Kata Print Agent", click: showWindow },
    { label: `Open the website (${new URL(loadConfig(DEFAULT_SERVER).serverUrl).host})`, click: openWebsite },
    { label: "Open the backup folder", click: () => void shell.openPath(backup.getRoot()) },
    { label: "Show the log file", click: () => shell.showItemInFolder(logFilePath()) },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", showWindow);
  tray.on("double-click", showWindow);
  refreshTray();
}

if (hasLock) {
  app.whenReady().then(() => {
    // the app's own pages need no permissions (camera, location, notifications ...)
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    // the website moved: a PC paired at an old address now talks to the current one
    const moved = loadConfig(DEFAULT_SERVER);
    if (OLD_SERVERS.includes(moved.serverUrl.replace(/\/+$/, "")) && moved.serverUrl !== DEFAULT_SERVER) {
      saveConfig({ ...moved, serverUrl: DEFAULT_SERVER });
      logLine(`website address changed from ${moved.serverUrl} to ${DEFAULT_SERVER}`);
    }
    journal = new FileJournal();
    backup = new DailyBackup(loadConfig(DEFAULT_SERVER).backupDir || defaultBackupDir(), () => new Date(), note);
    setupAgent();
    const helper = helperFiles(__dirname);
    scaleHost = new ScaleHost(helper.preload, helper.page, note);
    scale = new ScaleManager(scaleHost, uiChanged, (learned) => {
      const c = loadConfig(DEFAULT_SERVER);
      if (c.scale) saveConfig({ ...c, scale: { ...c.scale, ...learned } });
    }, note);
    const sc = loadConfig(DEFAULT_SERVER).scale;
    if (sc?.enabled && (sc.source !== "sim" || SIM)) void scale.apply(sc);
    const hidden = process.argv.includes("--hidden") && !!loadToken(); // started with Windows and already paired: stay in the tray
    createWindow(!hidden);
    createTray();
    // start with Windows login, run in the background
    app.setLoginItemSettings({ openAtLogin: true, name: PRODUCT, args: ["--hidden"] });
    logLine(`started v${app.getVersion()} on Windows ${release()} (${process.arch})`);

    loop(poll, POLL_MS, true);
    loop(heartbeat, HEARTBEAT_MS, false);
    void heartbeat().then(() => poll());
  });
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("window-all-closed", () => { /* stay alive in tray */ });
  app.on("before-quit", () => { quitting = true; });
}

// ---- IPC (renderer is sandboxed; it never sees the token) --------------------------------------------
// the backup folder is scanned at most every 15 s (the window asks for its state often)
let summaryCache: { at: number; value: ReturnType<DailyBackup["summary"]> } | null = null;
const backupSummary = () => {
  if (!summaryCache || Date.now() - summaryCache.at > 15_000) summaryCache = { at: Date.now(), value: backup.summary() };
  return summaryCache.value;
};

ipcMain.handle("state", () => {
  const cfg = loadConfig(DEFAULT_SERVER);
  const bs = backupSummary();
  const selected = cfg.printer ?? null;
  return {
    paired: !!(cfg.agentId && loadToken()), label: cfg.label, server: cfg.serverUrl, version: app.getVersion(), host: hostname(), ...state, log: [...log].reverse(),
    backup: { root: backup.getRoot(), days: bs.days, latest: bs.latest ?? null },
    // printers that can really print (OneNote, Fax, XPS, Print to file are left out); PDF printers are marked
    choices: state.printers.filter((p) => !isVirtualPrinter(p)).map((p) => ({ name: p, pdf: isPdfPrinter(p) })),
    approval: cfg.approval ?? "approved", printer: selected, request: cfg.request ?? null,
    printerMissing: !!selected && state.printers.length > 0 && !state.printers.includes(selected),
    printerVirtual: !!selected && isVirtualPrinter(selected),
    scale: scaleState(),
  };
});

/** Everything the window shows about the scale. `live` changes many times a second and is updated in place. */
function scaleState() {
  const st = scale?.status();
  const cfg = scale?.config() ?? { enabled: false, source: "serial" as const };
  const s = st?.state;
  const live = !st || !st.enabled ? null
    : s?.kind === "stable" ? { kind: "stable", kg: s.kg }
    : s?.kind === "moving" ? { kind: "moving", kg: s.kg }
    : { kind: s?.kind ?? "no_data", kg: null };
  return {
    cfg, sim: SIM, ports: scalePorts, detect: scaleDetect, test: scaleTest,
    protocols: (Object.keys(PROTOCOLS) as ProtocolId[]).map((id) => ({ id, name: PROTOCOLS[id].name, families: PROTOCOLS[id].families })),
    status: st ? { link: st.link, error: st.error, protocol: st.protocol, port: st.port } : null,
    live: live ? { ...live, frames: st!.frames, rejected: st!.rejected, raw: st!.lastRaw, lastDataAt: st!.lastDataAt } : null,
  };
}

ipcMain.handle("scale-ports", async () => {
  if (!scale) return { ok: false };
  try { scalePorts = await scale.listPorts(); } catch (e) { note(`Could not list COM ports: ${describe(e)}`); }
  return { ok: true, ports: scalePorts };
});

/** Saves the scale settings typed in the window (only known fields, checked). */
ipcMain.handle("scale-save", async (_e, raw: Partial<ScaleConfig>) => {
  if (!scale) return { ok: false, error: "Not ready" };
  const source = raw.source === "tcp" ? "tcp" : raw.source === "sim" && SIM ? "sim" : "serial";
  const cfg: ScaleConfig = {
    enabled: !!raw.enabled, source,
    port: typeof raw.port === "string" && /^COM\d{1,3}$/i.test(raw.port) ? raw.port.toUpperCase() : undefined,
    baud: [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].includes(Number(raw.baud)) ? Number(raw.baud) : 9600,
    framing: raw.framing === "8E1" || raw.framing === "8O1" ? raw.framing : "8N1",
    mask7: !!raw.mask7,
    protocol: raw.protocol && (raw.protocol === "auto" || raw.protocol in PROTOCOLS) ? raw.protocol : "auto",
    unit: raw.unit === "t" ? "t" : "kg",
    host: typeof raw.host === "string" ? raw.host.trim().slice(0, 100) : undefined,
    tcpPort: Number.isInteger(Number(raw.tcpPort)) && Number(raw.tcpPort) > 0 && Number(raw.tcpPort) < 65536 ? Number(raw.tcpPort) : undefined,
    ask: !!raw.ask,
  };
  if (cfg.enabled && cfg.source === "serial" && !cfg.port) return { ok: false, error: "Choose the COM port the scale is connected to." };
  if (cfg.enabled && cfg.source === "tcp" && (!cfg.host || !cfg.tcpPort)) return { ok: false, error: "Enter the scale's network address and port." };
  saveConfig({ ...loadConfig(DEFAULT_SERVER), scale: cfg });
  scaleTest = null;
  await scale.apply(cfg);
  note(cfg.enabled ? `Scale settings saved (${cfg.source === "serial" ? cfg.port : cfg.source === "tcp" ? `${cfg.host}:${cfg.tcpPort}` : "simulator"})` : "Scale turned off");
  void heartbeat(); // the website learns at once whether Detect weight is available
  return { ok: true };
});

/** Finds speed, framing and format of the indicator on a COM port by listening (and, only if allowed, by asking). */
ipcMain.handle("scale-detect", async (_e, port: string, ask: boolean, unit: "kg" | "t") => {
  if (!scale || scaleDetect.running) return { ok: false };
  if (!/^COM\d{1,3}$/i.test(String(port))) return { ok: false, error: "Choose a COM port first." };
  scaleDetect = { running: true, text: "Starting…", result: null };
  uiChanged();
  try {
    const r = await scale.autoDetect(String(port).toUpperCase(), { ask: !!ask }, (text) => { scaleDetect.text = text; uiChanged(); });
    if (r.ok) {
      const cfg = { ...r.cfg, unit: unit === "t" ? "t" as const : "kg" as const };
      saveConfig({ ...loadConfig(DEFAULT_SERVER), scale: cfg });
      await scale.apply(cfg);
      scaleDetect = { running: false, text: "", result: { ok: true, message: `Found: ${PROTOCOLS[cfg.protocol as ProtocolId].name}, ${cfg.baud} baud ${cfg.mask7 ? "7 data bits + parity" : cfg.framing}. Saved.` } };
      note(`Scale found on ${cfg.port}: ${PROTOCOLS[cfg.protocol as ProtocolId].name}, ${cfg.baud} baud`);
      void heartbeat();
    } else {
      scaleDetect = { running: false, text: "", result: { ok: false, message: r.message, sample: r.sample } };
      const c = loadConfig(DEFAULT_SERVER).scale;
      if (c?.enabled) await scale.apply(c);
    }
  } catch (e) {
    scaleDetect = { running: false, text: "", result: { ok: false, message: describe(e) } };
  }
  uiChanged();
  return { ok: true };
});

/** "Read weight now" button in the window: the same reading the website gets. */
ipcMain.handle("scale-test", async () => {
  if (!scale) return { ok: false };
  const r = await scale.read(6000);
  scaleTest = { at: new Date().toLocaleTimeString(), ok: r.ok, text: r.ok ? `${r.kg.toLocaleString("en-IN")} kg (steady, ${r.frames} identical readings)` : r.message };
  uiChanged();
  return { ok: true };
});

ipcMain.handle("pair", async (_e, code: string, label: string, printerName: string) => {
  try {
    const cfg = loadConfig(DEFAULT_SERVER);
    const chosen = String(printerName ?? "");
    const installed = await printer.list();
    if (!chosen || !installed.includes(chosen) || isVirtualPrinter(chosen)) return { ok: false, error: "Choose the printer this PC prints slips on." };
    const r = await pair(cfg.serverUrl, String(code).trim(), String(label).trim() || hostname(), `Windows ${release()}`, await thisMachine(), chosen);
    saveToken(r.token);
    // a website without the approval feature yet sends no "approval": then nothing is locked locally and printing works as in 0.1.4
    const approval = r.approval ?? "approved";
    saveConfig({ ...cfg, agentId: r.agent_id, label: String(label).trim() || hostname(), approval, printer: r.approval === "approved" ? chosen : null,
      request: approval === "pending" ? { kind: "takeover", printer: chosen } : null });
    setupAgent();
    await heartbeat();
    note(approval === "pending" ? "Paired. Waiting for approval on the website (another PC prints for this site now)." : `Paired with the server. Printer: ${chosen}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof HttpError ? e.message : "Could not reach the server. Check the internet connection." };
  }
});

ipcMain.handle("backup-choose", async () => {
  const r = await dialog.showOpenDialog({ title: "Choose the backup folder", properties: ["openDirectory", "createDirectory"] });
  if (r.canceled || !r.filePaths[0]) return { ok: false };
  const cfg = loadConfig(DEFAULT_SERVER);
  saveConfig({ ...cfg, backupDir: r.filePaths[0] });
  backup.setRoot(r.filePaths[0]);
  summaryCache = null;
  note(`Backup folder changed to ${r.filePaths[0]}`);
  return { ok: true };
});
ipcMain.handle("backup-open", async () => { await shell.openPath(backup.getRoot()); return { ok: true }; });
ipcMain.handle("website-open", () => { openWebsite(); return { ok: true }; });
ipcMain.handle("log-open", () => { shell.showItemInFolder(logFilePath()); return { ok: true }; });

/** "Change printer" / "choose it again": a request; the current printer keeps printing until it is approved on the website. */
ipcMain.handle("request-printer", async (_e, printerName: string) => {
  if (!api) return { ok: false, error: "This PC is not paired." };
  const chosen = String(printerName ?? "");
  const installed = await printer.list();
  if (!installed.includes(chosen) || isVirtualPrinter(chosen)) return { ok: false, error: "That printer is not installed on this PC." };
  try {
    const r = await link!.requestPrinter(chosen);
    applyState(r?.state);
    note(`Asked to use ${chosen}. An owner or administrator must approve it on the website.`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: friendly(e) };
  }
});

ipcMain.handle("unpair", () => {
  clearToken();
  scaleHost?.listen(null, () => {}); // no more signals for this PC
  saveConfig({ ...loadConfig(DEFAULT_SERVER), agentId: null, printer: null, approval: undefined, request: null });
  setupAgent();
  state.connected = false;
  refreshTray();
  return { ok: true };
});

ipcMain.handle("test-print", async (_e, printerName: string, kind: "calibration" | "sample") => {
  const installed = await printer.list();
  if (!installed.includes(printerName)) return { ok: false, error: "That printer is not installed on this PC." };
  const layout = ticketPreset();
  const html = kind === "calibration"
    ? renderCalibrationHtml(layout)
    : renderHtml(layout, { serial: "TEST-000", vehicle: "TEST 0000", material: "SAMPLE", party: "TEST PRINT - NOT AN INVOICE", gross_weight: "0", tare_weight: "0", net_weight: "0", charge: "0" }).html;
  const r = await printer.print(html, { deviceName: printerName, widthMm: layout.paper.w, heightMm: layout.paper.h, copies: 1 });
  note(r.ok ? (r.note ?? `Test ${kind} sent to ${printerName}`) : `Test print failed: ${r.error}`);
  return r;
});
