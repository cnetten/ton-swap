"use client";
import { ArrowUpDown, RefreshCw } from "lucide-react";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { useCallback, useEffect, useState } from "react";
import { useTonConnectUI } from "../tonconnect/hooks/useTonConnectUI";
import { useTheme } from "next-themes";

import TokenAmountInput from "./TokenAmountInput";
import { DEFAULT_TOKENS } from "./utils/const";
import { useQuote } from "@/hooks/useQuote";
import { Address, toNano } from "@ton/core";
import { useDebouncedCallback } from "use-debounce";
import { useTonAddress } from "../tonconnect/hooks/useTonAddress";
import {
  VaultJetton,
  Factory,
  MAINNET_FACTORY_ADDR,
  ReadinessStatus,
  JettonRoot,
} from "@dedust/sdk";
import { TonClient4 } from "@ton/ton";
import { StonApiClient } from "@ston-fi/api";

function safeAmountToBigInt(amountStr, decimals) {
  // First, ensure it's a string
  const str = String(amountStr);

  if (str.includes(".")) {
    // It's a formatted decimal value, we need to convert to integer units
    const amountNumber = parseFloat(str);
    const amountInteger = Math.floor(amountNumber * 10 ** decimals);
    return BigInt(amountInteger);
  } else {
    // It's already an integer value (no decimal point)
    return BigInt(str);
  }
}

export const SwapInterface = () => {
  const [tonConnectUI] = useTonConnectUI();
  const [isConnected, setIsConnected] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [isSwapping, setIsSwapping] = useState(false);
  const { theme } = useTheme();
  const { getQuote, isLoading, error } = useQuote();
  const userFriendlyAddress = useTonAddress();

  const [state, setState] = useState({
    fromToken: DEFAULT_TOKENS[0],
    toToken: DEFAULT_TOKENS[0],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rawSimulation: {} as any,
    fromAmount: "",
    toAmount: "",
    priceImpact: "0",
    minAskUnits: "",
    feePercent: "0",
    transaction: [],
    outPerIn: "0",
    swapRoute: "",
    protocol: "",
    receiveAtLeast: "",
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

  const debouncedGetQuote = useDebouncedCallback(async (amount: string) => {
    // Check initial conditions first
    if (
      !amount ||
      !state.fromToken.contractAddress ||
      !state.toToken.contractAddress
    ) {
      setState((prevState) => ({ ...prevState, toAmount: "" }));
      return;
    }

    try {
      const simulation = await getQuote({
        fromAddress: state.fromToken.contractAddress,
        toAddress: state.toToken.contractAddress,
        amount: amount,
        slippageTolerance: "0.005",
      });

      setState((prev) => ({
        ...prev,
        rawSimulation: simulation,
        toAmount: simulation?.swapPaths[0]?.estimatedOutput || "",
        swapRoute: simulation?.swapPaths[0]?.pathReadable,
        outPerIn: simulation?.swapPaths[0]?.outPerIn,
        receiveAtLeast: simulation?.swapPaths[0]?.minimumAmountOut,
        // priceImpact: simulation.priceImpact,
        // minAskUnits: simulation.minAskUnits,
        // feePercent: simulation.quote?.params?.swap?.routes[0]?.gasBudget,
        // transaction: simulation.transaction,
        protocol: simulation?.swapPaths[0]?.source,
      }));
    } catch (error) {
      console.error("Failed to simulate swap:", error);
      setState((prev) => ({
        ...prev,
        toAmount: "",
        swapRoute: "",
      }));
    }
  }, 500);

  const handleFromAmountChange = useCallback(
    (amount: string) => {
      setState((prev) => ({ ...prev, fromAmount: amount }));
      debouncedGetQuote(amount);
    },
    [debouncedGetQuote]
  );

  useEffect(() => {
    if (state.fromAmount) {
      handleFromAmountChange(state.fromAmount);
    }
    const stonfiClient = new StonApiClient();
    const pools = stonfiClient.getAsset(
      "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"
    );
    console.log(pools);
  }, [
    handleFromAmountChange,
    state.fromAmount,
    state.fromToken,
    state.toToken,
  ]);

  function safeAmountToBigInt(amountStr, decimals) {
    // First, ensure it's a string
    const str = String(amountStr);

    if (str.includes(".")) {
      // It's a formatted decimal value, we need to convert to integer units
      const amountNumber = parseFloat(str);
      const amountInteger = Math.floor(amountNumber * 10 ** decimals);
      return BigInt(amountInteger);
    } else {
      // It's already an integer value (no decimal point)
      return BigInt(str);
    }
  }
  const prepareTonConnectMultiHopSwap = async (tonConnectUI, swapPath) => {
    const tonClient = new TonClient4({
      endpoint: "https://mainnet-v4.tonhubapi.com",
    });

    try {
      console.log("Input swap path:", JSON.stringify(swapPath, null, 2));

      // Log critical values for debugging
      console.log("Input amount:", swapPath.inputAmount);
      console.log("Minimum output amount:", swapPath.minimumAmountOut);

      const factory = tonClient.open(
        Factory.createFromAddress(MAINNET_FACTORY_ADDR)
      );
      const firstPool = swapPath.pools[0];
      const firstToken = swapPath.path[0];
      const vault = tonClient.open(await factory.getNativeVault());

      if ((await vault.getReadinessStatus()) !== ReadinessStatus.READY) {
        throw new Error("Vault not ready");
      }

      // Get the decimals for the tokens in the swap
      const fromTokenDecimals =
        firstToken === "native"
          ? 9
          : swapPath.pools[0].assets.find(
              (a) => (a.address || a.type) === firstToken
            )?.metadata?.decimals || 9;

      const toTokenDecimals =
        swapPath.outPutMint === "native"
          ? 9
          : swapPath.pools[swapPath.pools.length - 1].assets.find(
              (a) => (a.address || a.type) === swapPath.outPutMint
            )?.metadata?.decimals || 9;

      console.log(
        `Token decimals - From: ${fromTokenDecimals}, To: ${toTokenDecimals}`
      );

      // THE FIX: Handle different token types and formats properly
      let amountIn, minimumOutput;

      if (firstToken === "native") {
        // For native TON, use toNano to handle conversion from human-readable
        if (
          typeof swapPath.inputAmount === "string" &&
          swapPath.inputAmount.includes(".")
        ) {
          amountIn = toNano(swapPath.inputAmount);
        } else {
          // If it's already in nanoTON format (no decimal point)
          amountIn = BigInt(swapPath.inputAmount);
        }

        if (
          typeof swapPath.minimumAmountOut === "string" &&
          swapPath.minimumAmountOut.includes(".")
        ) {
          minimumOutput = toNano(swapPath.minimumAmountOut);
        } else {
          minimumOutput = BigInt(swapPath.minimumAmountOut);
        }
      } else {
        // For other tokens, handle both formats (with or without decimal points)
        amountIn = safeAmountToBigInt(swapPath.inputAmount, fromTokenDecimals);
        minimumOutput = safeAmountToBigInt(
          swapPath.minimumAmountOut,
          toTokenDecimals
        );
      }

      console.log(
        `Converted amounts - Input: ${amountIn}, Minimum output: ${minimumOutput}`
      );

      // Create nested pool configuration
      const buildSwapConfig = (index = 0) => {
        if (index > swapPath.pools.length - 1) return undefined;

        return {
          poolAddress: Address.parse(swapPath.pools[index].address),
          limit:
            index === swapPath.pools.length - 1 ? minimumOutput : undefined,
          next: buildSwapConfig(index + 1),
        };
      };

      let returnSwap;

      if (firstToken === "native") {
        returnSwap = await vault.sendSwap(
          {
            send: async (args) => {
              await tonConnectUI.sendTransaction({
                messages: [
                  {
                    address: args.to.toString(),
                    amount: args.value.toString(),
                    payload: args?.body?.toBoc().toString("base64"),
                  },
                ],
              });
            },
          },
          {
            amount: amountIn,
            poolAddress: Address.parse(firstPool.address),
            ...buildSwapConfig(),
          }
        );
      } else {
        const scaleVault = tonClient.open(
          await factory.getJettonVault(Address.parse(firstToken))
        );

        const root = tonClient.open(
          JettonRoot.createFromAddress(Address.parse(firstToken))
        );

        const wallet = tonClient.open(
          await root.getWallet(Address.parse(userFriendlyAddress))
        );

        returnSwap = wallet.sendTransfer(
          {
            send: async (args) => {
              await tonConnectUI.sendTransaction({
                messages: [
                  {
                    address: args.to.toString(),
                    amount: args.value.toString(),
                    payload: args?.body?.toBoc().toString("base64"),
                  },
                ],
              });
            },
          },
          toNano(0.3), // Gas fee in TON
          {
            amount: amountIn,
            destination: scaleVault.address,
            responseAddress: Address.parse(userFriendlyAddress),
            forwardAmount: toNano("0.2"), // Gas fee in TON
            forwardPayload: VaultJetton.createSwapPayload({
              poolAddress: Address.parse(firstPool.address),
              ...buildSwapConfig(),
            }),
          }
        );
      }

      return returnSwap;
    } catch (error) {
      console.error("Error preparing swap:", {
        message: error.message,
        stack: error.stack,
        swapPath: JSON.stringify(swapPath, null, 2),
      });
      throw error;
    }
  };

  const handleSwap = async () => {
    if (!tonConnectUI.connected) {
      await tonConnectUI.openModal();
      return;
    }

    try {
      setIsSwapping(true);

      if (!state.rawSimulation?.swapPaths?.[0]) {
        throw new Error("No valid swap path found");
      }

      const swapPath = state.rawSimulation.swapPaths[0];

      // Validate path
      if (!swapPath.pools?.length) {
        throw new Error("No pools in swap path");
      }

      console.log("Starting swap:", {
        path: swapPath.pathReadable,
        inputAmount: swapPath.inputAmount,
        minimumAmountOut: swapPath.minimumAmountOut,
        pools: swapPath.pools.map((p) => ({
          address: p.address,
        })),
      });

      const result = await prepareTonConnectMultiHopSwap(
        tonConnectUI,
        swapPath
      );
      console.log("Swap initiated:", result);
    } catch (error) {
      console.error("Swap failed:", error.message);
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
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  if (state.fromAmount) {
                    debouncedGetQuote(state.fromAmount);
                  }
                }}
                disabled={!state.fromAmount}
                className="text-gray-500 hover:text-gray-700"
              >
                <RefreshCw
                  className={`h-5 w-5 ${isLoading ? "animate-spin" : ""}`}
                />
              </Button>
            </div>

            <TokenAmountInput
              label="Pay"
              token={state.fromToken}
              amount={state.fromAmount}
              balance={state.fromToken?.balance}
              onChange={handleFromAmountChange}
              onSelectToken={(token) => {
                setState((prev) => ({ ...prev, fromToken: token }));
              }}
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
                    Route
                  </span>
                  <span
                    className={
                      theme === "dark" ? "text-gray-300" : "text-gray-700"
                    }
                  >
                    {state.swapRoute}
                  </span>
                </div>
                {/* <div className="flex justify-between text-sm">
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
                </div> */}
                <div className="flex justify-between text-sm">
                  <span
                    className={
                      theme === "dark" ? "text-gray-400" : "text-gray-500"
                    }
                  >
                    Receive at least
                  </span>
                  <span
                    className={
                      theme === "dark" ? "text-gray-300" : "text-gray-700"
                    }
                  >
                    {state.receiveAtLeast} {state.toToken.meta.symbol}
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
                    1 {state.fromToken.meta.symbol} = {state.outPerIn}{" "}
                    {state.toToken.meta.symbol}
                  </span>
                </div>

                {/* <div className="flex justify-between text-sm">
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
                </div> */}
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
                !state.fromAmount ||
                (!state.toAmount && isConnected) ||
                !state.fromToken ||
                !state.fromToken.contractAddress ||
                !state.toToken ||
                !state.toToken.contractAddress ||
                !!error ||
                isLoading
              }
            >
              {error || !state.rawSimulation?.swapPaths?.[0]
                ? "Failed to find quote"
                : isSwapping
                ? "Swapping..."
                : !isConnected
                ? "Connect Wallet"
                : isLoading
                ? "Loading..."
                : "Swap"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default SwapInterface;
