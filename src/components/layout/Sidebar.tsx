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
import Image from "next/image";

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export const Sidebar = ({ isOpen, onClose }: SidebarProps) => {
  const pathname = usePathname();
  const [tonConnectUI] = useTonConnectUI();
  const [balance, setBalance] = useState<string>("0");
  const [jettonBalances, setJettonBalances] = useState<any>([]);
  const userFriendlyAddress = useTonAddress();

  const navigation = [{ name: "Swap", href: "/", icon: ArrowLeftRight }];
  console.log(jettonBalances);
  useEffect(() => {
    const fetchBalance = async () => {
      if (tonConnectUI.connected && userFriendlyAddress) {
        try {
          const [accountResponse, jettonsResponse] = await Promise.all([
            fetch(`https://tonapi.io/v2/accounts/${userFriendlyAddress}`),
            fetch(
              `https://tonapi.io/v2/accounts/${userFriendlyAddress}/jettons`
            ),
          ]);

          const accountData = await accountResponse.json();
          const jettonsData = await jettonsResponse.json();

          if (accountData && accountData.balance) {
            const formattedBalance = (
              Number(accountData.balance) / 1000000000
            ).toFixed(2);
            setBalance(formattedBalance);
          }

          if (jettonsData && jettonsData.balances) {
            const balances = jettonsData.balances.map((item) => {
              return {
                symbol: item.jetton.symbol || "Unknown Token",
                balance: (
                  Number(item.balance) /
                  10 ** (item.jetton.decimals || 9)
                ).toFixed(2),
                jettonAddress: item.jetton.address,
                image: item.jetton.image,
              };
            });
            setJettonBalances(balances);
          }
        } catch (error) {
          console.error("Error fetching balances:", error);
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
                  <Image
                    src={
                      "https://asset.ston.fi/img/EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c/ee9fb21d17bc8d75c2a5f7b5f5f62d2bacec6b128f58b63cb841e98f7b74c4fc"
                    }
                    width={20}
                    height={20}
                    alt={"TON"}
                    className="rounded-full w-4 h-4"
                  />
                  <span>{balance} TON</span>
                </div>
                {jettonBalances.map((item) => (
                  <div
                    key={item.jettonAddress}
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                  >
                    <Image
                      src={item.image}
                      width={20}
                      height={20}
                      alt={item.symbol}
                      className="rounded-full w-4 h-4"
                    />
                    <span>
                      {item.balance} {item.symbol}
                    </span>
                  </div>
                ))}
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
