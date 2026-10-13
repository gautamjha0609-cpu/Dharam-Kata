# Assumptions, risks and what is NOT done

## Owner decisions applied
- The amount of an entry is a flat figure typed by the operator (not rate × weight). It is entered at both visits; the LAST one is the sale amount (closing if closed, else opening). The weight unit (kg/tonne) setting only affects how weights are shown. Payments are append-only: a changed amount adds a payment or reversal row for the difference.
- Excel ticket template is imported into the layout designer (labels → fields, merged cells/widths → mm boxes). Text sizes are fitted per value (largest size that fits between min/max pt, with a legibility floor warning); invoices whose text cannot fit are **refused by the agent** rather than printed truncated.
- Vercel + Supabase only; no Cloudflare, no backup vendor (SRS A8).

## Not verified / not done yet
- **Physical dot-matrix alignment.** The "Vinayak Pre-printed Ticket 170×95" preset positions were estimated from the photo. Calibrate X/Y per printer and approve on real paper. Dot-matrix driver support for the 170×95 mm form size must be checked on the actual model/driver.
- **Print Agent has been built but not run against a real printer or the deployed site.** "Sent to Windows print queue" ≠ paper printed; the UI says so.
- Installer is **unsigned** (Windows SmartScreen will warn). Auto-update is not implemented: update by installing a newer setup `.exe`.
- Browser smoke test on iPhone Safari / Android not yet performed. PWA = installable shell only; **no offline invoicing** (by design).
- Built and tested (browser, production build, real Supabase project, throwaway data since deleted): platform admin, firm creation, forced password change, owner/operator/accounts/remote-site roles, parties, two-price entry, invoices, cash/credit, collections, cancel, reprint, Excel invoice register, suspension, agent pairing/print/restart/revoke.
- Not yet built: tenant logo upload + compression (A4), usage/quota dashboard, platform audit viewer, per-printer template override UI, export-to-xlsx of layouts, debtor-statement/other report types, e2e (Playwright) suite, GitHub CI.
- Print Agent was tested against this PC's Windows printers only (OneNote virtual printer = silent success path). A real dot-matrix has NOT been tested.
- Session revocation on user disable: membership disable blocks all data access immediately (RLS), but the Auth session token itself is not force-expired.
- API rate limiting is best-effort in-memory (serverless instances do not share it). Add edge/DB limits before public launch. Supabase Auth has its own login rate limits.
- Supabase advisor warnings about `SECURITY DEFINER` functions callable by `authenticated` are intentional: those RPCs are the API and each checks permission/tenant internally. Agent RPCs are `service_role` only.

## Hosting / data-loss risk (SRS A8, 3.3–3.4)
- Vercel Hobby is non-commercial; selling the service needs a paid plan.
- Supabase Free: 500 MB DB, pauses after inactivity, **no managed backups**. Without a backup service, accidental deletion, account loss or provider incident can mean permanent data loss. Do not promise durability/uptime. Take manual `pg_dump` exports regularly and test a restore.

## Security notes
- Tenant isolation: RLS on every table, `organization_id` on every row, composite FKs pin child org = parent org. Tested with two tenants (see `supabase/tests`).
- The service-role key lives only in server env (`apps/web/.env.local` / Vercel env). Never in the browser or the agent.
- Agent credential is a random 256-bit token, stored hashed server-side and DPAPI-encrypted on the PC.
- The publishable key in `.env.local` is meant to be public.

## Added after the printing research
- Admin-only credentials are enforced in the database (see README). Platform admin manages owners; owners/admins manage their users. An owner/admin can reset their own password through the admin route (they are an admin).
- Printer-specific layouts are supported in the designer and resolved the same way on the website preview and on the server. Printer status is read from Windows and shown in Settings.
- Not implemented from the research: raw ESC/P text mode, bidirectional printer-status beyond Windows flags, per-model compatibility matrix (needs real printers), logo images on blank-paper slips.

## Weighing order, headings and fonts (latest changes)
- A vehicle may be weighed loaded-first OR empty-first. The operator enters a FIRST and a SECOND weight; the heavier is stored as Loaded (gross), the lighter as Empty (tare). Equal weights are refused. The time and any manual-time reason travel with their own weight. The price entered at the second weighing still wins over the first.
- Receipt headings (e.g. "Vehicle no." / "वाहन नं.") can print in English or Hindi, chosen with one bar in the designer; each heading can be edited. The Hindi wording follows the supplied Excel template.
- Hindi text uses the "Nirmala UI" font (installed with Windows 10/11). "Mangal" is no longer installed by default on Windows 11 and renders Hindi incorrectly, so it is not used. Printing Hindi on the print PC needs Nirmala UI there too.
- Canon imageCLASS MF3010 (laser) is in the printer list. Its environment keeps the SAME 170 x 95 mm slip size. Whether this printer accepts such a small custom paper size must be confirmed with a test print; it cannot take continuous forms or make carbon copies.
- The supplied blank Vinayak ticket image (1600 x 839 px) is wider than 170 x 95 mm (ratio 1.91 vs 1.79), so the preview stretches it slightly; field positions drawn over it are approximate. Calibrate on paper.

- **Opening and closing slips.** Every invoice exists from its first weighing (stage `open`, number issued, opening slip printed with the first weight under the Loaded box headed "First weight"). Closing the entry completes the same invoice (stage `closed`, immutable afterwards) and prints a second slip with the same number. A new opening for a vehicle that still has an open entry cancels the old one (reason "Replaced by a new opening"). Reports list open entries too, using their opening amount.
- **Form follows the layout.** The Weighment form asks only for fields that are on the receipt layout; "must fill in" is a per-field flag in the layout (plus the firm's extra fields). Fields removed from the layout stay in a history list used by the "Add a field" menu; new extra fields (up to 8) are created there. Each field can print its heading in its own language.
- **Users are created and managed only by the platform administrator.** `/api/v1/users` and `/api/v1/users/action` return 403 for everyone else (firm owner, admin, operator); the Settings page no longer has a Users form. The service-role key stays on the server.
- **"Paid now" can never exceed the amount.** Enforced in `open_entry` / `close_entry` (error `invalid_amount_paid`), not only in the form.
- **Collections.** A bill can be paid in several instalments; outstanding = amount − payments, computed from the append-only payment rows. `post_collection` locks the invoice, refuses more than the outstanding amount and is idempotent per dialog (`idempotency_key`).
- **Vehicle dues.** Checking a vehicle also lists its closed, unpaid bills (`find_vehicle_dues`): total on top, bill-by-bill list collapsed. They are informational and are never added to the new weighment. Open (not yet closed) entries are not counted as dues.
