# Performance, database and branding — how it is set up

## 1. Firm branding (no firm's logo is built into the product)
- The login page shows the neutral **Dharam Kata** mark (an inline SVG scale) and "Powered by The Valuation House".
- Each client firm has its own logo, set by the **platform administrator**: *Platform admin → the firm → Logo*.
  PNG, JPEG, WebP or a short animated **GIF** (up to 6 MB, 150 frames). It is resized to fit (max 640 × 220), converted to WebP (animation kept)
  and stored privately per firm. SVG is refused (scripts can hide in SVG).
- The logo appears **only inside that firm's own panel** (sidebar, drawer, mobile header). A firm without a logo shows a monogram and its name.
- Served by `/api/v1/brand/logo?organization_id=…&v=<version>`; only that firm's users (and platform admins) can fetch it. The URL carries the
  version, so browsers cache it for a year and a new upload shows up immediately.
- App icons (PWA, favicons, iOS, Windows tile, Print Agent) are made from the Valuation House mark: 72–512 px "any" icons, 192/512 "maskable" icons (mark inside the safe zone), 180 px Apple touch icon, favicon.ico (16/32/48) and a 150 px Windows tile. To change the mark, regenerate them from the new image (sharp: trim, centre on white, resize).

## 1b. Installable app (PWA)
- `manifest.webmanifest` (name, icons, shortcuts for New weighment / Open entries / Invoices, any orientation), a service worker (app shell + offline page; it never caches data) and an **Install app** button (login page and top bar).
- Chrome / Edge / Android: one-tap install. Safari (iPhone, iPad, Mac) and Firefox have no install prompt, so the button shows the exact steps for that browser. Firefox on a computer cannot install web apps.
- Checked with Chrome DevTools: manifest valid, no installability errors, service worker active, every icon loads.

## 2. Speed
How the app is built to be fast:
- The signed-in frame (who you are, your firm, its sites and billing unit) is rendered **on the server** from ONE database call (`app_bootstrap`), so the
  sidebar, header and page title are in the first HTML. The dashboard numbers come from ONE more call (`dashboard_summary`, summed inside the database, exact, no row limits).
- The sign-in page does not load the database client until someone starts typing.
- Critical CSS is inlined; images have explicit sizes; the logo is cached for a year; the ticket image is requested with high priority.
- Skeleton placeholders hold the space of content that arrives later, so nothing jumps (layout shift ≈ 0).
- `browserslist` targets current browsers only (no legacy polyfills).

Measuring (repeatable): build with `NEXT_DIST_DIR=.next-prod pnpm --filter @dk/web build`, start with `next start -p 3100`, then run Lighthouse 12 with
Chrome against each page (signed in as a test owner). Lighthouse is a Chrome tool: Firefox/Safari cannot be scored by it, so they were not scored.
Mobile numbers use Lighthouse's standard throttled profile (slow 4G, 4× slower CPU) and are always lower than desktop numbers.

## 3. Database (Supabase project "Dharam kata", Mumbai ap-south-1, PostgreSQL 17)
- Row-level security on every table; the isolation test `supabase/tests/rls_isolation.sql` passes (cross-firm reads/writes denied, anon denied).
- Advisors were run: trigger-only functions are no longer callable through the API; five foreign keys got indexes; the two overlapping `profiles` SELECT
  policies were merged into one. Remaining advisor notes are intentional (RPCs callable by signed-in users check permissions inside) or a
  dashboard-only setting (leaked-password protection, a Pro-plan Auth feature).
- Health check: `GET /api/health` (public, returns only `{ok, db_ms}`).

### Keeping the free-tier project from pausing
Supabase **free** projects pause after about a week without activity. Two independent keep-alives are included:
1. `apps/web/vercel.json` — a daily cron that calls `/api/health` (works once the site is deployed on Vercel).
2. `.github/workflows/keepalive.yml` — pings the database API every 2 days (add repository secrets `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`).

For a paid service use the **Supabase Pro plan**: it never auto-pauses, and adds daily backups, more connections (the free micro instance allows 60)
and leaked-password protection. Free tier has **no managed backups** — see `docs/BACKUP.md`.
