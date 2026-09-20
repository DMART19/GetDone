import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { PwaRuntime } from "@/components/pwa-runtime";
import "./globals.css";
import "./ufo-fidelity.css";
import "./ufo-states.css";

export const metadata: Metadata = {
  title: "GetDone UFO v2",
  description: "GetDone owner control surface",
  applicationName: "GetDone",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "GetDone",
    statusBarStyle: "black-translucent"
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#020914"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <PwaRuntime />
        {children}
      </body>
    </html>
  );
}
