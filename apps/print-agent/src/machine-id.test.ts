import { describe, expect, it } from "vitest";
import { machineHash, machineId } from "./machine-id";

describe("machine id", () => {
  it("is a sha-256 hex string and never the raw Windows id", () => {
    expect(machineHash("4738dc63-e60e-4c14-b654-28d62036ec1d")).toMatch(/^[0-9a-f]{64}$/);
    expect(machineHash("a")).not.toBe(machineHash("b"));
  });
  // 0.1.5 shipped with a broken registry path and always fell back to a random id: on Windows the real id must be read
  it.runIf(process.platform === "win32")("reads Windows' MachineGuid (no fallback) and is stable", async () => {
    let fallback = false;
    const a = await machineId(() => { fallback = true; return "seed"; });
    const b = await machineId(() => "seed");
    expect(fallback).toBe(false);
    expect(a).toBe(b);
  });
});
