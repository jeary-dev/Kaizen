import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { connection } from "next/server";
import "./globals.css";

// next/font downloads these at build time and serves them from this origin: no request ever goes
// to Google from a visitor's browser.
const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

const publicUrl = process.env.KAIZEN_PUBLIC_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(publicUrl),
  title: { default: "Kaizen · config editor for Minecraft servers", template: "%s · Kaizen" },
  description:
    "Edit your Minecraft server's plugin configs in the browser. End-to-end encrypted, secrets never leave your server, every change is backed up and can be undone.",
  applicationName: "Kaizen",
  referrer: "no-referrer",
  openGraph: {
    title: "Kaizen 改善",
    description: "A calm, end-to-end encrypted config editor for Minecraft servers.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0f0d0e",
  colorScheme: "dark",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Every page gets a fresh CSP nonce from the proxy, so nothing can be prerendered.
  await connection();
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
