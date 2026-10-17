import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC = [/^\/login$/, /^\/robots\.txt$/, /^\/api\/health$/, /^\/api\/version$/, /^\/api\/v1\/auth\/login$/, /^\/api\/v1\/auth\/admin-open$/,/^\/api\/v1\/agent\//, /^\/offline\.html$/, /^\/sw\.js$/, /^\/manifest\.webmanifest$/, /^\/brand\//, /^\/icon-/, /^\/apple-touch-icon/, /^\/favicon/, /^\/mstile-/, /^\/browserconfig\.xml$/];

export async function middleware(req: NextRequest) {
  let res = NextResponse.next({ request: req });
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookieOptions: { maxAge: 60 * 60 * 24 * 365, sameSite: "lax", path: "/" },
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => req.cookies.set(name, value));
        res = NextResponse.next({ request: req });
        list.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      },
    },
  });
  // The session cookie is read locally; the auth server is contacted only when the access token has expired (to renew it).
  // This is only the door check: every page query is checked again by the database (RLS) and every API route re-verifies the user with getUser().
  const { data: s } = await supabase.auth.getSession();
  const data = { user: s.session ? true : null };
  const path = req.nextUrl.pathname;
  if (data.user && path === "/login") { // already signed in: straight to the main page
    const url = req.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }
  if (!data.user && !PUBLIC.some((re) => re.test(path))) {
    if (path.startsWith("/api/")) return NextResponse.json({ data: null, error: { code: "unauthenticated" } }, { status: 401 });
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
