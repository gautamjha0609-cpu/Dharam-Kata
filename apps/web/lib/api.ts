import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { serviceClient, userClient } from "./supabase-server";

/** Predictable envelope: { data, error, requestId }. Never leaks stack traces or secrets (SRS section 9). */
export function ok<T>(data: T, status = 200) {
  return NextResponse.json({ data, error: null, requestId: crypto.randomUUID() }, { status });
}
export function fail(status: number, code: string, message: string) {
  return NextResponse.json({ data: null, error: { code, message }, requestId: crypto.randomUUID() }, { status });
}

export const PASSWORD_POLICY = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(72)
  .refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), "Password must contain letters and numbers");

export const LOGIN_ID = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,31}$/, "Login ID: 3-32 chars, lowercase letters, digits, . _ -");

/** Authenticated caller (cookie session). Returns null if not signed in. */
export async function currentUser() {
  const sb = await userClient();
  const { data } = await sb.auth.getUser();
  return data.user ? { id: data.user.id, sb } : null;
}

/** Best-effort per-instance limiter. Serverless instances do not share memory: real limits belong at the edge/DB. */
const hits = new Map<string, number[]>();
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return false; }
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return true;
}
export const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

/** Resolves an agent from `Authorization: Bearer <device token>`. The token is hashed server-side. */
export async function authenticateAgent(req: Request): Promise<string | null> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || token.length < 32 || token.length > 200) return null;
  const { data } = await serviceClient().rpc("agent_authenticate", { p_token: token });
  return (data as string | null) ?? null;
}

export function rpcErrorMessage(e: { message?: string } | null): string {
  const m = e?.message ?? "";
  if (/forbidden/.test(m)) return "You do not have permission to do this.";
  if (/duplicate key|unique/i.test(m)) return "That login ID or name is already in use.";
  return "The request could not be completed.";
}
