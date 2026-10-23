import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Journal, PendingAck } from "./core";
import type { ScaleConfig } from "./scale/manager";

const dir = () => {
  const d = app.getPath("userData");
  mkdirSync(d, { recursive: true });
  return d;
};
function readJson<T>(name: string, fallback: T): T {
  try {
    const p = join(dir(), name);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(name: string, v: unknown) {
  const p = join(dir(), name);
  writeFileSync(p + ".tmp", JSON.stringify(v));
  renameSync(p + ".tmp", p); // atomic replace: a crash never leaves a half-written journal
}

export interface Config {
  serverUrl: string; agentId: string | null; label: string; backupDir?: string;
  /** the printer this PC is approved to print on (from the server); null = not chosen yet */
  printer?: string | null;
  /** "approved" | "pending" (waiting for the owner) | "rejected" */
  approval?: string;
  /** an open request on the website (takeover or printer change) */
  request?: { kind: string; printer: string | null } | null;
  /** fallback machine id when Windows' own id cannot be read */
  machineSeed?: string;
  /** the weighing scale on this PC (optional) */
  scale?: ScaleConfig;
}
export const loadConfig = (defaultUrl: string): Config => readJson<Config>("config.json", { serverUrl: defaultUrl, agentId: null, label: "" });
export const saveConfig = (c: Config) => writeJson("config.json", c);

/** The device credential is encrypted with the OS (Windows DPAPI via Electron safeStorage); never plaintext on disk. */
export function saveToken(token: string) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("OS secure storage is not available");
  writeFileSync(join(dir(), "device.bin"), safeStorage.encryptString(token));
}
export function loadToken(): string | null {
  try {
    const p = join(dir(), "device.bin");
    return existsSync(p) ? safeStorage.decryptString(readFileSync(p)) : null;
  } catch {
    return null;
  }
}
export function clearToken() {
  try { writeFileSync(join(dir(), "device.bin"), Buffer.alloc(0)); } catch { /* ignore */ }
}

interface JournalFile { acks: PendingAck[]; submitted: string[] }
export class FileJournal implements Journal {
  private data: JournalFile = readJson<JournalFile>("journal.json", { acks: [], submitted: [] });
  private save() { writeJson("journal.json", this.data); }
  pending() { return [...this.data.acks]; }
  add(a: PendingAck) { this.data.acks = [...this.data.acks.filter((x) => x.jobId !== a.jobId), a]; this.save(); }
  remove(id: string) { this.data.acks = this.data.acks.filter((x) => x.jobId !== id); this.save(); }
  submitted(id: string) { return this.data.submitted.includes(id); }
  markSubmitted(id: string) { this.data.submitted = [...this.data.submitted.slice(-499), id]; this.save(); }
}
