import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SwRegister } from "@/components/sw-register";

export const metadata: Metadata = {
  title: "Dharam Kata",
  description: "Weighbridge management: weighments, invoices, collections and printing. By The Valuation House.",
  manifest: "/manifest.webmanifest",
  applicationName: "Dharam Kata",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: { capable: true, title: "Dharam Kata", statusBarStyle: "default" },
  formatDetection: { telephone: false },
  other: { "mobile-web-app-capable": "yes", "apple-mobile-web-app-capable": "yes", "msapplication-config": "/browserconfig.xml", "msapplication-TileColor": "#0B2D4C" },
};
export const viewport: Viewport = { themeColor: "#0B2D4C", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* open the connection to the database early: the first data request then starts sooner */}
        {process.env.NEXT_PUBLIC_SUPABASE_URL && <link rel="preconnect" href={process.env.NEXT_PUBLIC_SUPABASE_URL} crossOrigin="anonymous" />}
      </head>
      <body className="min-h-screen font-sans antialiased">
        {children}
        <SwRegister />
      </body>
    </html>
  );
}
