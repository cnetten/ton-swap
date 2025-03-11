import { ClientProvider } from "@/components/providers/ClientProvider";
import { Layout } from "@/components/layout/Layout";
import { Inter } from "next/font/google";
import "./globals.css";
import { Analytics } from "@vercel/analytics/react";
import { LogoStyles } from "@/components/brand/NohvaLogo";
const inter = Inter({ subsets: ["latin"] });

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <LogoStyles />
        <ClientProvider>
          <Analytics />
          <Layout>{children}</Layout>
        </ClientProvider>
      </body>
    </html>
  );
}
