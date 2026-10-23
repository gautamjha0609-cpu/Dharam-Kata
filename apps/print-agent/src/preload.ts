import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("agent", {
  state: () => ipcRenderer.invoke("state"),
  pair: (code: string, label: string, printer: string) => ipcRenderer.invoke("pair", code, label, printer),
  requestPrinter: (printer: string) => ipcRenderer.invoke("request-printer", printer),
  testPrint: (printer: string, kind: "calibration" | "sample") => ipcRenderer.invoke("test-print", printer, kind),
  unpair: () => ipcRenderer.invoke("unpair"),
  backupChoose: () => ipcRenderer.invoke("backup-choose"),
  backupOpen: () => ipcRenderer.invoke("backup-open"),
  logOpen: () => ipcRenderer.invoke("log-open"),
  websiteOpen: () => ipcRenderer.invoke("website-open"),
  scalePorts: () => ipcRenderer.invoke("scale-ports"),
  scaleSave: (cfg: unknown) => ipcRenderer.invoke("scale-save", cfg),
  scaleDetect: (port: string, ask: boolean, unit: string) => ipcRenderer.invoke("scale-detect", port, ask, unit),
  scaleTest: () => ipcRenderer.invoke("scale-test"),
  onState: (cb: () => void) => ipcRenderer.on("state-changed", () => cb()),
});
