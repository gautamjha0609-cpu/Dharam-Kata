import { contextBridge, ipcRenderer } from "electron";

// The hidden scale helper page can only hand bytes and events to the main process; it has no other access.
contextBridge.exposeInMainWorld("dkBridge", {
  data: (b: Uint8Array) => ipcRenderer.send("scale-data", b),
  event: (e: Record<string, unknown>) => ipcRenderer.send("scale-event", e),
});
