# Dharam Kata — Weighbridge SaaS

Multi-tenant weighbridge management, powered by The Valuation House. Every client firm gets its own isolated workspace with its own logo
(set by the platform admin under **Platform admin → Logo**); no firm's branding is built into the product. Vinayak is the first demo client.
Authoritative spec: `Documnet/Vinayak_WMS_SaaS_SRS_v1.1.docx`.

| Part | Path | What it is |
|---|---|---|
| Website + PWA | `apps/web` | Next.js (App Router), installable on iPhone/Android, responsive |
| Windows Print Agent | `apps/print-agent` | Electron tray app, silent printing to the Windows dot-matrix printer → `.exe` installer |
| Backend | `supabase/migrations` | Postgres schema, RLS, transactional RPCs (Supabase project **Dharam kata**) |
| Domain rules | `packages/domain` | Net weight, unit-fixed pricing (kg or tonne), invoice numbers |
| Invoice area / layout engine | `packages/print-template` | Layout JSON schema, text-fit engine, renderer, Excel import |

## First-time setup

1. `pnpm install`
2. Put your Supabase **service_role** key in `apps/web/.env.local` (`SUPABASE_SERVICE_ROLE_KEY=`). Server-only; never commit it.
3. Create the first platform admin (password comes from your environment, is never stored):
   ```powershell
   cd apps/web
   $env:NEXT_PUBLIC_SUPABASE_URL="https://qgiskpkgdtufiglsxvfd.supabase.co"
   $env:SUPABASE_SERVICE_ROLE_KEY="<service role key>"
   $env:ADMIN_LOGIN="valuation"; $env:ADMIN_PASSWORD="<12+ char strong password>"
   node scripts/bootstrap-platform-admin.mjs
   ```
4. `pnpm --filter @dk/web dev` → http://localhost:3000, sign in, create a client firm (Platform admin page).
5. Sign in as the firm owner → Settings: set billing unit, invoice series, receipt layout, pair a printer PC.

## Build the Windows installer

```powershell
cd apps/print-agent
$env:DK_SERVER_URL="https://<your deployed website>"   # HTTPS in production
pnpm dist        # -> release/Dharam Kata Print Agent Setup 0.1.0.exe
```

## Checks
`pnpm test` (domain, print-template, agent core) · `pnpm typecheck` · `pnpm --filter @dk/web build`.
Database tests: `supabase/tests/*.sql` (run in the Supabase SQL editor; success = only the final `*_TESTS_OK` rollback message).

## Logins and passwords (admin-only)
Only an administrator sets or changes a login ID or password: the platform admin for firm owners, the firm owner/admin for their own users (Settings → Users). Users have no way to change their own, in the app **or** through Supabase's public auth API (a database trigger on `auth.users` rejects any password/email change that an admin action has not just authorised).

## Day-to-day flow
Operator (one form, two visits): type the vehicle number → **Check vehicle**. A new vehicle is **opened** (first weight + amount → invoice number issued → *opening slip* prints). When the same vehicle comes back, the check finds the open entry and a pop-up asks **Close this entry** or **New weighment**. Closing takes the second weight (the heavier weight is automatically *Loaded*, the lighter *Empty*) and the final amount, and prints a *closing slip with the same invoice number*. "New weighment" cancels the old open entry (its number is retired, payments reversed) and issues a new number. The **amount** is a flat figure typed by the operator (no rate × weight); the **last amount entered** is the sale amount used in reports and the Excel backup.

## Honest limits (read before go-live)
See `docs/ASSUMPTIONS_AND_RISKS.md`.
