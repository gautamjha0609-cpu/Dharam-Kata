import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("agent", {
  state: () => ipcRenderer.invoke("state"),
  pair: (code: string, label: string) => ipcRenderer.invoke("pair", code, label),
  testPrint: (printer: string, kind: "calibration" | "sample") => ipcRenderer.invoke("test-print", printer, kind),
  unpair: () => ipcRenderer.invoke("unpair"),
  backupChoose: () => ipcRenderer.invoke("backup-choose"),
  backupOpen: () => ipcRenderer.invoke("backup-open"),
  logOpen: () => ipcRenderer.invoke("log-open"),
  websiteOpen: () => ipcRenderer.invoke("website-open"),
  onState: (cb: () => void) => ipcRenderer.on("state-changed", () => cb()),
});
