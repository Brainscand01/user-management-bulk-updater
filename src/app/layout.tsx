import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
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
  title: "UM Bulk Updater",
  description: "Bulk User Management Tool - Create, Update, and Shift Assignment",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-slate-50 text-slate-900">
        {children}
        <Script
          src="https://ignition-command-centre.vercel.app/sdk/ignition-monitor.js"
          data-api-key={process.env.NEXT_PUBLIC_MONITOR_KEY}
          data-endpoint="https://ignition-command-centre.vercel.app"
          data-bug-reporter="true"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}
