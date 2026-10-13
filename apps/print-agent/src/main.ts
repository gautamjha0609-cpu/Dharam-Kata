import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell, Tray } from "electron";
import { hostname, release } from "node:os";
import { join } from "node:path";
import { renderCalibrationHtml, renderHtml, ticketPreset } from "@dk/print-template";
import { AgentCore } from "./core";
import { DailyBackup } from "./backup";
import { ElectronPrinter } from "./electron-printer";
import { HttpApi, HttpError, pair } from "./http-api";
import { logFilePath, logLine } from "./logger";
import { FileJournal, clearToken, loadConfig, loadToken, saveConfig, saveToken } from "./store";

// Set at build time to your deployed website, e.g. https://dharam-kata.vercel.app (must be HTTPS in production).
const DEFAULT_SERVER = process.env.DK_SERVER_URL || "http://localhost:3000";
const APP_ID = "in.thevaluationhouse.dharamkata.printagent";
const POLL_MS = 5_000;
const MAX_POLL_MS = 60_000; // while the server cannot be reached the agent backs off instead of knocking every 5 s
const HEARTBEAT_MS = 30_000;

// One agent per PC. A second launch just brings the first one forward.
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.exit(0);

// A print agent needs no GPU: switching it off saves memory and avoids driver problems on old or unusual PCs.
app.disableHardwareAcceleration();
app.setAppUserModelId(APP_ID);

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
const printer = new ElectronPrinter();
const log: string[] = [];
const state = { connected: false, lastError: "", lastJob: "", printers: [] as string[], jobsPrinted: 0 };
let core: AgentCore | null = null;
let api: HttpApi | null = null;
let journal: FileJournal;
let backup: DailyBackup;
const defaultBackupDir = () => join(app.getPath("documents"), "DharamKata Backup");
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

function setupAgent() {
  const cfg = loadConfig(DEFAULT_SERVER);
  const token = loadToken();
  if (!cfg.agentId || !token) { core = null; api = null; return; }
  api = new HttpApi(cfg.serverUrl, token);
  core = new AgentCore(api, printer, journal, note, backup);
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
  if (!api) return;
  try {
    const withStatus = await printer.listWithStatus();
    state.printers = withStatus.map((p) => p.name);
    await api.heartbeat(app.getVersion(), `Windows ${release()}`, withStatus);
    state.connected = true; state.lastError = "";
  } catch (e) {
    state.connected = false;
    state.lastError = friendly(e);
  }
  refreshTray();
  win?.webContents.send("state-changed");
}

let busy = false;
async function poll() {
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

function createTray() {
  tray = new Tray(nativeImage.createFromPath(uiFile("tray.png")));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Dharam Kata Print Agent", click: showWindow },
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
    journal = new FileJournal();
    backup = new DailyBackup(loadConfig(DEFAULT_SERVER).backupDir || defaultBackupDir(), () => new Date(), note);
    setupAgent();
    const hidden = process.argv.includes("--hidden") && !!loadToken(); // started with Windows and already paired: stay in the tray
    createWindow(!hidden);
    createTray();
    // start with Windows login, run in the background
    app.setLoginItemSettings({ openAtLogin: true, name: "Dharam Kata Print Agent", args: ["--hidden"] });
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
  return { paired: !!(cfg.agentId && loadToken()), label: cfg.label, server: cfg.serverUrl, version: app.getVersion(), host: hostname(), ...state, log: [...log].reverse(), backup: { root: backup.getRoot(), days: bs.days, latest: bs.latest ?? null } };
});

ipcMain.handle("pair", async (_e, code: string, label: string) => {
  try {
    const cfg = loadConfig(DEFAULT_SERVER);
    const r = await pair(cfg.serverUrl, String(code).trim(), String(label).trim() || hostname(), `Windows ${release()}`);
    saveToken(r.token);
    saveConfig({ ...cfg, agentId: r.agent_id, label: String(label).trim() || hostname() });
    setupAgent();
    await heartbeat();
    note("Paired with the server");
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
ipcMain.handle("log-open", () => { shell.showItemInFolder(logFilePath()); return { ok: true }; });

ipcMain.handle("unpair", () => {
  clearToken();
  saveConfig({ ...loadConfig(DEFAULT_SERVER), agentId: null });
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
  note(r.ok ? `Test ${kind} sent to ${printerName}` : `Test print failed: ${r.error}`);
  return r;
});
