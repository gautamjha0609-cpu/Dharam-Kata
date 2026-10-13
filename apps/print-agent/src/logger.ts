import { app } from "electron";
import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 1_000_000;
export const logFilePath = () => join(app.getPath("userData"), "agent.log");

/** Support log next to the settings (AppData\Roaming\Dharam Kata Print Agent\agent.log). Never throws; keeps about 2 MB at most. */
export function logLine(line: string) {
  try {
    const p = logFilePath();
    if (existsSync(p) && statSync(p).size > MAX_BYTES) renameSync(p, p.replace(/\.log$/, ".old.log"));
    appendFileSync(p, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging must never break printing */
  }
}
