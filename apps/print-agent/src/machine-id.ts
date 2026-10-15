import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

/** Windows' own id of this installation (survives agent updates and reinstalls; changes only when Windows is reinstalled). */
function windowsMachineGuid(): Promise<string | null> {
  return new Promise((resolve) => {
    // full path to Windows' reg.exe (not another "reg" on PATH); /reg:64 so a 32-bit agent on 64-bit Windows reads the real MachineGuid
    const reg = join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "reg.exe");
    execFile(reg, ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"], { windowsHide: true, timeout: 5000 }, (err, out) => {
      const m = !err && /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/.exec(out);
      resolve(m ? m[1]!.toLowerCase() : null);
    });
  });
}

/**
 * Stable id of this PC, sent when pairing so that pairing the same PC again replaces its old entry (no duplicates).
 * Only a hash leaves the PC. `seed` is a stored random id, used when Windows' id cannot be read.
 */
export async function machineId(seed: () => string): Promise<string> {
  const raw = (await windowsMachineGuid()) ?? `seed:${seed()}`;
  return machineHash(raw);
}
export const machineHash = (raw: string) => createHash("sha256").update(`dharam-kata-print-agent:${raw}`).digest("hex");
export const newSeed = () => randomUUID();
