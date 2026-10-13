import type { Config } from "tailwindcss";
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: { navy: { DEFAULT: "#0B2D4C", 700: "#12395e", 50: "#eef3f8" }, brand: { DEFAULT: "#19B957", dark: "#0e7a37", darker: "#0b6a2f", 50: "#e9f8ef" } },
      fontFamily: { sans: ["Inter", "system-ui", "Segoe UI", "Noto Sans Devanagari", "sans-serif"] },
    },
  },
  plugins: [],
} satisfies Config;
