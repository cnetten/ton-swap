"use client";
import { ArrowUpDown } from "lucide-react";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { useCallback, useEffect, useState } from "react";
import { useTonConnectUI } from "../tonconnect/hooks/useTonConnectUI";
import { useTheme } from "next-themes";

import TokenAmountInput from "./TokenAmountInput";
import { DEFAULT_TOKENS } from "./utils/const";
import { useQuote } from "@/hooks/useQuote";
import { fromNano } from "@ton/core";

export const SwapInterface = () => {
  const [tonConnectUI] = useTonConnectUI();
  const [isConnected, setIsConnected] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [isSwapping, setIsSwapping] = useState(false);
  const { theme } = useTheme();
  const { getQuote, isLoading, error } = useQuote();

  const [state, setState] = useState({
    fromToken: DEFAULT_TOKENS[0],
    toToken: DEFAULT_TOKENS[1],
    fromAmount: "",
    toAmount: "",
    priceImpact: "0",
    minAskUnits: "",
    feePercent: "0",
    transaction: [],
    protocol: "",
  });

  useEffect(() => {
    const unsubscribe = tonConnectUI.onStatusChange((wallet) => {
      if (wallet) {
        setIsConnected(true);
        setAddress(wallet.account.address);
      } else {
        setIsConnected(false);
        setAddress(null);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [tonConnectUI]);

  const handleFromAmountChange = useCallback(
    async (amount: string) => {
      setState((prev) => ({ ...prev, fromAmount: amount }));
      if (amount && state.fromToken && state.toToken) {
        try {
          const simulation = await getQuote({
            fromAddress: state.fromToken.contractAddress,
            toAddress: state.toToken.contractAddress,
            amount: amount,
            slippageTolerance: "0.5",
          });

          setState((prev) => ({
            ...prev,
            toAmount: simulation.quote.askUnits,
            priceImpact: simulation.priceImpact,
            minAskUnits: simulation.minAskUnits,
            feePercent: simulation.quote?.params?.swap?.routes[0]?.gasBudget,
            transaction: simulation.transaction,
            protocol:
              simulation.quote?.params?.swap?.routes[0]?.steps[0]?.chunks[0]
                ?.protocol,
          }));
        } catch (error) {
          console.error("Failed to simulate swap:", error);
        }
      } else {
        setState((prev) => ({ ...prev, toAmount: "" }));
      }
    },
    [state.fromToken, state.toToken]
  );

  useEffect(() => {
    if (state.fromAmount) {
      handleFromAmountChange(state.fromAmount);
    }
  }, [
    handleFromAmountChange,
    state.fromAmount,
    state.fromToken,
    state.toToken,
  ]);

  const handleSwap = async () => {
    if (!isConnected) {
      await tonConnectUI.openModal();
      return;
    }

    setIsSwapping(true);
    try {
      const transaction = {
        validUntil: Math.floor(Date.now() / 1000) + 60 * 20,
        messages: state.transaction,
      };

      await tonConnectUI.sendTransaction(transaction);
      setState((prev) => ({ ...prev, fromAmount: "", toAmount: "" }));
    } catch (error) {
      console.error("Swap failed:", error);
    } finally {
      setIsSwapping(false);
    }
  };

  const switchTokens = () => {
    setState((prev) => ({
      ...prev,
      fromToken: prev.toToken,
      toToken: prev.fromToken,
      fromAmount: "",
      toAmount: "",
    }));
  };

  return (
    <div className="flex justify-center items-center">
      <Card
        className={`w-full max-w-md p-4 ${
          theme === "dark" ? "bg-zinc-800" : ""
        }`}
      >
        <CardContent>
          <div className="space-y-4">
            <div className="flex justify-between items-center mb-6">
              <div className="text-xl font-bold">Swap</div>
            </div>

            <TokenAmountInput
              label="Pay"
              token={state.fromToken}
              amount={state.fromAmount}
              balance={state.fromToken?.balance}
              onChange={handleFromAmountChange}
              onSelectToken={(token) =>
                setState((prev) => ({ ...prev, fromToken: token }))
              }
              walletAddress={address ?? undefined}
              currentTokenAddress={state.toToken?.address}
            />

            <div className="flex justify-center -my-2">
              <Button
                variant="ghost"
                size="icon"
                className="rounded-full shadow-md"
                onClick={switchTokens}
              >
                <ArrowUpDown className="h-6 w-6" />
              </Button>
            </div>

            <TokenAmountInput
              label="Receive"
              token={state.toToken}
              amount={isLoading || error ? "0" : state.toAmount}
              fromAmount={state.fromAmount}
              balance={state.toToken?.balance}
              onChange={() => {}}
              onSelectToken={(token) =>
                setState((prev) => ({ ...prev, toToken: token }))
              }
              readonly
              fromTokenPrice={state.fromToken?.dexPriceUsd}
              walletAddress={address ?? undefined}
              currentTokenAddress={state.fromToken?.address}
            />

            {state.fromAmount && state.toAmount && !isLoading && !error && (
              <div
                className={`p-3 rounded-lg space-y-1 ${
                  theme === "dark" ? "bg-zinc-900" : "bg-gray-50"
                }`}
              >
                <div className="flex justify-between text-sm">
                  <span
                    className={
                      theme === "dark" ? "text-gray-400" : "text-gray-500"
                    }
                  >
                    Price Impact
                  </span>
                  <span
                    className={
                      theme === "dark" ? "text-gray-300" : "text-gray-700"
                    }
                  >
                    {state.priceImpact}%
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span
                    className={
                      theme === "dark" ? "text-gray-400" : "text-gray-500"
                    }
                  >
                    Rate
                  </span>
                  <span
                    className={
                      theme === "dark" ? "text-gray-300" : "text-gray-700"
                    }
                  >
                    1 {state.fromToken.meta.symbol} ={" "}
                    {(
                      parseFloat(state.toAmount) / parseFloat(state.fromAmount)
                    ).toFixed(6)}{" "}
                    {state.toToken.meta.symbol}
                  </span>
                </div>

                <div className="flex justify-between text-sm">
                  <span
                    className={
                      theme === "dark" ? "text-gray-400" : "text-gray-500"
                    }
                  >
                    Gas Fee Budget
                  </span>
                  <span
                    className={
                      theme === "dark" ? "text-gray-300" : "text-gray-700"
                    }
                  >
                    {fromNano(state.feePercent)}
                    {" TON"}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span
                    className={
                      theme === "dark" ? "text-gray-400" : "text-gray-500"
                    }
                  >
                    Protocol
                  </span>
                  <span
                    className={
                      theme === "dark" ? "text-gray-300" : "text-gray-700"
                    }
                  >
                    {state.protocol}
                  </span>
                </div>
              </div>
            )}

            <Button
              className={`w-full text-white ${
                theme === "dark"
                  ? "bg-zinc-900 hover:bg-white hover:text-zinc-900"
                  : "bg-white text-gray-500 hover:bg-zinc-50"
              }`}
              onClick={handleSwap}
              disabled={
                isSwapping ||
                (!state.fromAmount && !state.toAmount && isConnected) ||
                !!error ||
                isLoading
              }
            >
              {error
                ? "Failed to find quote"
                : isSwapping
                ? "Swapping..."
                : !isConnected
                ? "Connect Wallet"
                : "Swap"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default SwapInterface;
