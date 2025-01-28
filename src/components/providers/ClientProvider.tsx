"use client";
import { TonConnectUIProvider } from "../tonconnect/index"; // Change to @tonconnect/ui-react
import { ThemeProvider } from "next-themes"; // Change to next-themes
import { ReactNode, useEffect, useState } from "react";

interface ClientProviderProps {
  children: ReactNode;
}

export function ClientProvider({ children }: ClientProviderProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <TonConnectUIProvider manifestUrl="https://wondrous-penguin-instantly.ngrok-free.app/tonconnect-manifest.json">
        {children}
      </TonConnectUIProvider>
    </ThemeProvider>
  );
}
