import { useEffect, useState } from "react";
import {
  ConnectedWallet,
  Wallet,
  WalletInfoWithOpenMethod,
} from "@tonconnect/ui";
import { useTonConnectUI } from "./useTonConnectUI";

export function useTonWallet():
  | Wallet
  | (Wallet & WalletInfoWithOpenMethod)
  | null {
  const [tonConnectUI] = useTonConnectUI();
  const [wallet, setWallet] = useState<
    Wallet | (Wallet & WalletInfoWithOpenMethod) | null
  >(tonConnectUI?.wallet || null);

  useEffect(() => {
    if (tonConnectUI) {
      setWallet(tonConnectUI.wallet);
      return tonConnectUI.onStatusChange((value: ConnectedWallet | null) => {
        setWallet(value);
      });
    }
  }, [tonConnectUI]);

  return wallet;
}
