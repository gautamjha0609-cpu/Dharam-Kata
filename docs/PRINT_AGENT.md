# Dharam Kata Print Agent (Windows)

The small program that runs on the PC next to the printer. It collects print jobs from the website and sends them to the Windows printer silently.

## Which installer
Files are in `apps/print-agent/release/` after `pnpm --filter dharam-kata-print-agent dist`:
| File | For |
|---|---|
| `Dharam-Kata-Print-Agent-Setup-<version>-x64.exe` | normal 64-bit Windows PCs (almost all) |
| `…-ia32.exe` | 32-bit Windows 10 |
| `…-arm64.exe` | Windows on ARM (Surface Pro X, Snapdragon laptops) |
| `Dharam-Kata-Print-Agent-Setup-<version>.exe` | one big file that picks the right one by itself |

**Windows 10 and Windows 11 only.** The engine inside (Electron 33) does not run on Windows 7 / 8 / 8.1; those PCs need Windows 10 or the print agent cannot be used there.

The website address is baked in at build time: `DK_SERVER_URL=https://<your site> pnpm --filter dharam-kata-print-agent dist` (HTTPS in production; `http://localhost:3000` is for testing only).

## What was made fast and safe
- Starts in under a second; about 130 MB of memory while idle (the Excel library loads only when the first backup file is written).
- No GPU use (hardware acceleration off): fewer problems on old or unusual PCs.
- Uses Chromium's network stack, so it follows the PC's **proxy settings and Windows certificates** (office networks).
- When the server cannot be reached it backs off (5 s → up to 1 min) instead of knocking every 5 seconds, and recovers by itself.
- One agent per PC; a second launch just brings the first window forward. Closing the window keeps it in the tray; "Quit" is in the tray menu.
- Starts with Windows (hidden in the tray once paired). Uninstalling removes that start-up entry.
- Any crash or error is written to `%APPDATA%\Dharam Kata Print Agent\agent.log` (about 2 MB at most); tray menu → "Show the log file".
- The window shows only its own page (no pop-ups, no navigation, no permissions). The device password is stored with Windows DPAPI.

## Known limits
- The installer is **not code-signed**, so Windows SmartScreen may say "unknown publisher" (More info → Run anyway). Signing needs a paid certificate.
- There is no automatic update yet: install the new setup over the old one.
- "Sent to Windows print queue" means Windows accepted the job; it cannot prove paper came out.
