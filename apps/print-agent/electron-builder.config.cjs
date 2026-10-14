// Installer configuration. EVERY VERSION HAS ITS OWN IDENTITY so versions live side by side:
// installing a new version never closes, replaces or uninstalls an older one that a client is still using.
//   app id / uninstall entry : in.thevaluationhouse.dharamkata.printagent.v<version>
//   install folder           : %LOCALAPPDATA%\Programs\dharam-kata-print-agent-<version>
//   program, shortcuts       : "Dharam Kata Print Agent <version>"
//   settings, pairing, log   : %APPDATA%\Dharam Kata Print Agent <version>   (so the new version is paired on its own; the old keeps working)
const { version } = require("./package.json");

const productName = `Dharam Kata Print Agent ${version}`;

module.exports = {
  appId: `in.thevaluationhouse.dharamkata.printagent.v${version.replace(/\./g, "-")}`,
  productName,
  extraMetadata: { name: `dharam-kata-print-agent-${version}`, productName },
  directories: { output: "release", buildResources: "build" },
  files: ["dist/**", "ui/**", "package.json"],
  asar: true,
  win: {
    target: [{ target: "nsis", arch: ["x64", "ia32", "arm64"] }],
    icon: "build/icon.ico",
    signAndEditExecutable: false,
    legalTrademarks: "The Valuation House",
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    runAfterFinish: true,
    shortcutName: productName,
    installerIcon: "build/icon.ico",
    uninstallerIcon: "build/icon.ico",
    installerHeaderIcon: "build/icon.ico",
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
    artifactName: "Dharam-Kata-Print-Agent-Setup-${version}-${arch}.${ext}",
    include: "build/installer.nsh",
  },
  afterPack: "after-pack.cjs",
};
