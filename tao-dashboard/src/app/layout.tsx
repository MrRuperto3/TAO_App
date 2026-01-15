import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TAO Dashboard",
  description: "Read-only Bittensor (TAO) portfolio + subnet dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased text-gray-200`}
      >
        {/* Global Background (matches /subnets) */}
        <div className="fixed inset-0 -z-10">
          {/* Base dark gradient */}
          <div className="absolute inset-0 bg-gradient-to-b from-black via-slate-950 to-black" />

          {/* Strong aurora colors */}
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_15%,rgba(56,189,248,0.28),transparent_45%),radial-gradient(circle_at_85%_20%,rgba(168,85,247,0.28),transparent_45%),radial-gradient(circle_at_50%_85%,rgba(34,197,94,0.22),transparent_50%),radial-gradient(circle_at_70%_60%,rgba(251,146,60,0.18),transparent_45%)]" />

          {/* Subtle grid for depth */}
          <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:48px_48px] opacity-40" />
        </div>

        {children}
      </body>
    </html>
  );
}
