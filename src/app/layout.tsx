import type { Metadata, Viewport } from "next";
import "./globals.css";
import { RegisterServiceWorker } from "@/components/pwa/register-sw";

export const metadata: Metadata = {
  title: { default: "Athlete OS", template: "%s · Athlete OS" },
  description: "Ton système d'entraînement adaptatif.",
  applicationName: "Athlete OS",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Athlete OS" },
  formatDetection: { telephone: false },
  icons: { apple: "/icons/icon-192.png" },
};

export const viewport: Viewport = {
  themeColor: "#0b0d10",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <body className="min-h-dvh">
        {children}
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
