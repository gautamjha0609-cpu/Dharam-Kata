// After electron-builder has copied Electron into the output folder:
//  1. trim the installer (Chromium ships ~55 language files; the agent needs English + Hindi for Windows dialogs)
//  2. stamp OUR icon and details on the .exe (electron-builder skips this when code-signing tools are not used),
//     so the desktop shortcut, Start menu and Explorer show the logo instead of the Electron atom.
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const dir = path.join(context.appOutDir, "locales");
  if (fs.existsSync(dir)) {
    const keep = new Set(["en-US.pak", "en-GB.pak", "hi.pak"]);
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".pak") && !keep.has(f)) fs.rmSync(path.join(dir, f));
  }
  if (context.electronPlatformName !== "win32") return;
  const mod = await import("rcedit");
  const rcedit = typeof mod.default === "function" ? mod.default : mod.default?.rcedit ?? mod.rcedit;
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const version = context.packager.appInfo.version;
  await rcedit(exe, {
    icon: path.join(context.packager.projectDir, "build", "icon.ico"),
    "file-version": version,
    "product-version": version,
    "version-string": {
      ProductName: context.packager.appInfo.productName,
      FileDescription: context.packager.appInfo.productName,
      CompanyName: "The Valuation House",
      LegalCopyright: "The Valuation House",
      OriginalFilename: `${context.packager.appInfo.productFilename}.exe`,
    },
  });
};
