// Installer configuration. The version is part of the names (program, folder, uninstall entry); the installer REMOVES every earlier version completely
// (build/installer.nsh), so a PC only ever has the newest one. Pairing and settings stay in %APPDATA%Dharam Kata Print Agent for all versions.
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
