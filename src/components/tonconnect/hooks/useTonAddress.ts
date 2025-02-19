import { CHAIN, toUserFriendlyAddress } from "@tonconnect/ui";
import { useTonWallet } from "./useTonWallet";
import { useMemo } from "react";

export function useTonAddress(userFriendly = true): string {
  const wallet = useTonWallet();
  return useMemo(() => {
    if (wallet) {
      return userFriendly
        ? toUserFriendlyAddress(
            wallet.account.address,
            wallet.account.chain === CHAIN.TESTNET
          )
        : wallet.account.address;
    } else {
      return "";
    }
  }, [wallet, userFriendly, wallet?.account.address, wallet?.account.chain]);
}
