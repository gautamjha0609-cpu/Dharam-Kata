// ONE command for every new Print Agent version:  pnpm --filter @dk/print-agent release:exe "what changed"
//   1. refuses to run if this version number was already published (bump "version" in package.json first)
//   2. agent tests + typecheck
//   3. builds the installers for every Windows type (x64, ia32, arm64 and the all-in-one file)
//   4. runs the REAL installer on this PC through the whole install/uninstall/reinstall test matrix (scripts/test-installer.ps1). Any failure stops here
//   5. saves the installers in "exe software to share with clients": v<version>_<date>_<time>/ (permanent) and 00_CURRENT/ (newest)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agent = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(agent, "..", "..");
const version = JSON.parse(readFileSync(join(agent, "package.json"), "utf8")).version;
const note = process.argv.slice(2).join(" ").trim();
const shared = join(root, "exe software to share with clients");

const run = (title, cmd, args, env = {}, shell = false) => {
  console.log(`\n=== ${title} ===`);
  const r = spawnSync(cmd, args, { cwd: agent, stdio: "inherit", shell, env: { ...process.env, ...env } });
  if (r.status !== 0) { console.error(`\nSTOPPED: "${title}" failed. Nothing was published.`); process.exit(r.status ?? 1); }
};

if (!note) { console.error('Write what changed:  pnpm --filter @dk/print-agent release:exe "short note"'); process.exit(1); }
if (existsSync(shared) && readdirSync(shared).some((d) => d.startsWith(`v${version}_`))) {
  console.error(`Version ${version} is already in "${shared}". Raise "version" in apps/print-agent/package.json first, so every shared file has its own version.`); process.exit(1);
}
run("Agent typecheck", "pnpm", ["typecheck"], {}, true); // pnpm is a .cmd file on Windows: it needs a shell; the steps below pass their arguments directly (no shell, no quoting problems)
run("Agent tests", "pnpm", ["test"], {}, true);
rmSync(join(agent, "release"), { recursive: true, force: true }); // never mix installers of earlier builds with this one
run("Build installers (x64, ia32, arm64, all-in-one)", "pnpm", ["dist"], { DK_SERVER_URL: process.env.DK_SERVER_URL ?? "https://dharam-kata.vercel.app", CSC_IDENTITY_AUTO_DISCOVERY: "false" }, true);
// the newest EARLIER version in the shared folder plays "the version a client is still using": it must stay untouched by the new install
const cmp = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0; };
const folders = existsSync(shared) ? readdirSync(shared) : [];
const earlier = folders.map((d) => ({ d, m: /^v(\d+\.\d+\.\d+)_/.exec(d) })).filter((x) => x.m && cmp(x.m[1], version) < 0).sort((a, b) => cmp(b.m[1], a.m[1]))[0];
const oldInstaller = earlier ? join(shared, earlier.d, `Dharam-Kata-Print-Agent-Setup-${earlier.m[1]}-x64.exe`) : "";
run("Installer test matrix on this PC", "powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/test-installer.ps1", "-Version", version,
  "-Installer", join(agent, "release", `Dharam-Kata-Print-Agent-Setup-${version}-x64.exe`), "-AllInOne", join(agent, "release", `Dharam-Kata-Print-Agent-Setup-${version}.exe`),
  ...(oldInstaller && existsSync(oldInstaller) ? ["-OldInstaller", oldInstaller, "-OldVersion", earlier.m[1]] : [])]);
run("Save in the shared folder", "node", ["scripts/publish-exe.mjs", note]);
console.log(`\nDONE. Version ${version} is in: ${shared}`);
