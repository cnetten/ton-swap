"use client";
import { cn } from "@/lib/utils";
import { ArrowLeftRight } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import CustomTonConnectButton from "../ui/CustomTonConnectButton";
import { useTonConnectUI } from "../tonconnect/hooks/useTonConnectUI";
import { useState, useEffect } from "react";
import { TonClient } from "@ton/ton";
import { useTonAddress } from "../tonconnect/hooks/useTonAddress";
import { Address } from "@ton/core";

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export const Sidebar = ({ isOpen, onClose }: SidebarProps) => {
  const pathname = usePathname();
  const [tonConnectUI] = useTonConnectUI();
  const [balance, setBalance] = useState<string>("0");
  const userFriendlyAddress = useTonAddress();

  const navigation = [{ name: "Swap", href: "/", icon: ArrowLeftRight }];

  useEffect(() => {
    const fetchBalance = async () => {
      if (tonConnectUI.connected && userFriendlyAddress) {
        try {
          const client = new TonClient({
            endpoint: "https://toncenter.com/api/v2/jsonRPC",
          });
          const address = Address.parse(userFriendlyAddress);
          const balance = await client.getBalance(address);
          const formattedBalance = (Number(balance) / 1000000000).toFixed(2);
          setBalance(formattedBalance);
        } catch (error) {
          console.error("Error fetching balance:", error);
        }
      }
    };

    fetchBalance();
    const interval = setInterval(fetchBalance, 10000);

    return () => clearInterval(interval);
  }, [tonConnectUI.connected, userFriendlyAddress]);

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm md:hidden"
          onClick={onClose}
        />
      )}

      <div
        className={cn(
          "fixed top-14 z-50 w-64 border-r bg-background transition-transform duration-300 md:translate-x-0 flex flex-col h-[100vh]", // Changed height constraint
          isOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex-1 overflow-y-auto">
          <nav className="space-y-1 p-4">
            {navigation.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={cn(
                    "flex items-center space-x-3 rounded-lg px-3 py-2 text-sm transition-colors",
                    isActive
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:bg-secondary/50"
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  <span>{item.name}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="sticky bottom-0 bg-background border-t">
          <div className="p-4 flex flex-col gap-2">
            {tonConnectUI.connected && (
              <>
                <h3 className="text-sm font-medium text-muted-foreground">
                  Wallet Balance
                </h3>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span>{balance} TON</span>
                </div>
              </>
            )}
          </div>
          <div className="p-4 border-t flex flex-col gap-2">
            <CustomTonConnectButton />
          </div>
        </div>
      </div>
    </>
  );
};
