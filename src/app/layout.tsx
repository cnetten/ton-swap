import { ClientProvider } from "@/components/providers/ClientProvider";
import { Layout } from "@/components/layout/Layout";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <ClientProvider>
          <Layout>{children}</Layout>
        </ClientProvider>
      </body>
    </html>
  );
}
