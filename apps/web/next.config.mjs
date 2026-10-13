// one id per published build (Vercel: the commit); the app compares it with /api/version to know when a newer version exists
const BUILD_ID = process.env.VERCEL_GIT_COMMIT_SHA || process.env.BUILD_ID || String(Date.now());

/** @type {import('next').NextConfig} */
export default {
  generateBuildId: async () => BUILD_ID,
  env: { NEXT_PUBLIC_BUILD_ID: BUILD_ID },
  // a separate output folder lets a production build run next to the dev server without clobbering it
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  transpilePackages: ["@dk/domain", "@dk/print-template", "@dk/schemas"],
  serverExternalPackages: ["exceljs", "sharp"],
  poweredByHeader: false,
  // the stylesheet is small: inlining it removes a render-blocking request
  experimental: {
    inlineCss: true,
    // pages visited (or prefetched) in the last 30 s open instantly from the browser's cache instead of asking the server again
    staleTimes: { dynamic: 30, static: 180 },
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] },
    ];
  },
};
