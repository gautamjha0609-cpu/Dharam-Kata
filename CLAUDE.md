# Project rules (read first)

## Print Agent installers (`apps/print-agent`): every new version, every time
When the Print Agent changes, or the owner asks for "the exe", do ALL of this without being told again:
1. Raise `version` in `apps/print-agent/package.json` (never reuse a number that is already shared).
2. Run `pnpm --filter @dk/print-agent release:exe "what changed"`. It runs typecheck + tests, builds x64 / ia32 / arm64 / all-in-one installers,
   runs the real-installer test matrix (`scripts/test-installer.ps1`: fresh install, reinstall, install while running, uninstall + reinstall, folder
   deleted by hand, missing/failing old uninstaller, stale shortcuts + startup entry + old folder, deleted program file, user settings kept, all-in-one),
   and only if everything passes saves the files to `C:\Dharam Kata\exe software to share with clients\` as `v<version>_<date>_<time>\` (permanent copy)
   and `00_CURRENT\` (newest, sorts first).
3. NEW REPLACES OLD (owner decision, 2026-10-14): the installer closes and fully removes every earlier version (folders, shortcuts, start-up and uninstall entries, never via an old uninstaller) and installs in under a minute. Pairing and settings live in one shared folder, so updating needs no re-pairing.
4. The installer must keep working whatever an old install left behind: `build/installer.nsh` closes the running agent, ignores a broken old uninstaller,
   always recreates both shortcuts, fixes the start-with-Windows entry and removes old program folders. Do not remove those hooks. If a new situation
   shows up (a client message such as "missing shortcut"), add it as a scenario to `scripts/test-installer.ps1` FIRST, make it fail, then fix.
5. Never leave a client-shareable file that has not passed the matrix. Tell the owner which Windows types could NOT be tested here (ia32 / arm64).
6. Never commit the installers (the folder is git-ignored). Installers are unsigned: SmartScreen "More info -> Run anyway" is expected.

## Web
- Platform admin lives at the secret path in `apps/web/lib/admin-path.ts`; keep the repo private.
- Database changes go in `supabase/migrations/` AND are applied to the Supabase project (Vercel does not run migrations).
