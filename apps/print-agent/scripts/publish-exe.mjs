// Copies the freshly built installers into "<repo>/exe software to share with clients":
//   v<version>_<date>_<time>/   a permanent folder for this version (installers + CHANGES.txt)
//   00_CURRENT/                 always the newest version (sorts first), replaced on every publish
// Usage: pnpm publish:exe "short note about what changed"
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const agent = join(here, "..");
const root = join(agent, "..", "..");
const out = join(root, "exe software to share with clients");
const version = JSON.parse(readFileSync(join(agent, "package.json"), "utf8")).version;
const release = join(agent, "release");
const installers = existsSync(release) ? readdirSync(release).filter((f) => f.endsWith(".exe") && f.includes(`-${version}`)) : [];
if (installers.length === 0) { console.error(`No installers for version ${version} in ${release}. Run "pnpm dist" first.`); process.exit(1); }

const ist = new Date(Date.now() + 5.5 * 3_600_000).toISOString(); // India time
const stamp = `${ist.slice(0, 10)}_${ist.slice(11, 16).replace(":", "-")}`;
const folder = join(out, `v${version}_${stamp}`);
const note = process.argv.slice(2).join(" ").trim() || "(no note)";
const text = `Dharam Kata Print Agent
Version : ${version}
Built   : ${ist.slice(0, 10)} ${ist.slice(11, 16)} (India time)
Website : https://dharam-kata.vercel.app

What changed
  ${note}

Which file to give to a client
  Dharam-Kata-Print-Agent-Setup-${version}-x64.exe   ->  normal 64-bit Windows PC (most PCs)
  Dharam-Kata-Print-Agent-Setup-${version}-ia32.exe  ->  old 32-bit Windows
  Dharam-Kata-Print-Agent-Setup-${version}-arm64.exe ->  Windows on ARM
  Dharam-Kata-Print-Agent-Setup-${version}.exe       ->  one big file that works on all of the above (installs the right one itself)

Install: run the file on the PC that is connected to the printer, then pair it with the code from the website (Settings -> Printing).
Unsigned installer: Windows SmartScreen may say "unknown publisher" -> More info -> Run anyway.
`;

mkdirSync(folder, { recursive: true });
for (const f of installers) cpSync(join(release, f), join(folder, f));
writeFileSync(join(folder, "CHANGES.txt"), text);

const current = join(out, "00_CURRENT");
rmSync(current, { recursive: true, force: true });
mkdirSync(current, { recursive: true });
for (const f of installers) cpSync(join(release, f), join(current, f));
writeFileSync(join(current, "CHANGES.txt"), text + `\n(This folder is always the newest version. The permanent copy is in: v${version}_${stamp})\n`);

console.log(`Saved ${installers.length} installers to:\n  ${folder}\n  ${current}`);
