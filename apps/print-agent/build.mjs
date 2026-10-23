import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
await build({
  entryPoints: { main: "src/main.ts", preload: "src/preload.ts", "scale-preload": "src/scale-preload.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["electron"],
  sourcemap: false,
  // Website address baked into the installer: set DK_SERVER_URL when building (HTTPS in production).
  define: { "process.env.DK_SERVER_URL": JSON.stringify(process.env.DK_SERVER_URL ?? "") },
  logLevel: "info",
});
cpSync("ui", "dist/ui", { recursive: true });
