import { createBrowserClient } from "@supabase/ssr";

let client: ReturnType<typeof createBrowserClient> | undefined;

/** Browser client: publishable key + the user's session. Every table read is protected by RLS. */
export function supabase() {
  // the session is kept in a long-lived cookie (1 year; the access token renews itself), so people are not asked to sign in again and again
  client ??= createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookieOptions: { maxAge: 60 * 60 * 24 * 365, sameSite: "lax", path: "/" } });
  return client;
}

export { loginIdToEmail, LOGIN_ID_RE } from "./login-id";
