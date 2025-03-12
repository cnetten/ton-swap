/* eslint-disable @typescript-eslint/no-explicit-any */
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
import { DEX, pTON } from "@ston-fi/sdk";
import MultiRouteInfo from "./MultiRouteInfo";

// Helper function to convert token amount with decimals
function convertTokenAmount(humanReadableAmount, decimals) {
  return BigInt(
    Math.floor(Number(humanReadableAmount) * 10 ** decimals)
  ).toString();
}

// This function detects if we're dealing with a multi-hop swap
const isMultiHopSwap = (swapPath) => {
  return swapPath.path.length > 2 || swapPath.pools.length > 1;
};

export const SwapInterface = () => {
  const [tonConnectUI] = useTonConnectUI();
  const [isConnected, setIsConnected] = useState(tonConnectUI.connected);
  const [address, setAddress] = useState(
    tonConnectUI.wallet?.account.address || null
  );
  const [isSwapping, setIsSwapping] = useState(false);
  const { theme } = useTheme();
  const { getQuote, isLoading, error } = useQuote();
  const userFriendlyAddress = useTonAddress();

  const [state, setState] = useState({
    fromToken: DEFAULT_TOKENS[0],
    toToken: DEFAULT_TOKENS[0],
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
    isMultiRoute: false,
    multiRouteInfo: null,
    swapPaths: [],
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

      const hasValidPath =
        simulation &&
        simulation.swapPaths &&
        Array.isArray(simulation.swapPaths) &&
        simulation.swapPaths.length > 0;

      // Check if this is a multi-route response
      const isMultiRoute = hasValidPath && simulation.isMultiRoute === true;

      let protocol;
      let swapRoute;
      let receiveAtLeast;
      let outPerIn;
      let toAmount;

      if (isMultiRoute) {
        protocol = "Multi-Route";
        swapRoute = simulation.multiRouteInfo.pathReadable;
        toAmount = simulation.multiRouteInfo.totalOutput;

        // Calculate weighted average of minimumAmountOut
        receiveAtLeast = simulation.swapPaths
          .reduce((total, path) => {
            return total + path.minimumAmountOut * (path.percentage / 100);
          }, 0)
          .toString();

        // Use total output / total input for outPerIn
        const totalInput = Number(amount);
        outPerIn = (Number(toAmount) / totalInput).toFixed(9);
      } else if (hasValidPath) {
        // Single path logic
        if (simulation.swapPaths[0]?.source === "dedust") {
          protocol = "DeDust";
        } else if (simulation.swapPaths[0]?.source === "stonfi") {
          const version = simulation?.swapPaths[0]?.pools[0]?.version;
          protocol = version === "v1" ? "StonFi_v1" : "StonFi_v2";
        } else {
          protocol = simulation.swapPaths[0]?.source;
        }

        swapRoute = simulation.swapPaths[0]?.pathReadable || "";
        toAmount = simulation.swapPaths[0]?.estimatedOutput || "";
        receiveAtLeast = simulation.swapPaths[0]?.minimumAmountOut || "0";
        outPerIn = simulation.swapPaths[0]?.outPerIn || "0";
      } else {
        // No valid paths
        protocol = "";
        swapRoute = "";
        toAmount = "";
        receiveAtLeast = "0";
        outPerIn = "0";
      }

      setState((prev) => ({
        ...prev,
        rawSimulation: simulation || {},
        toAmount: toAmount,
        swapRoute: swapRoute,
        outPerIn: outPerIn,
        receiveAtLeast: receiveAtLeast,
        protocol: protocol,
        // Add multi-route information
        isMultiRoute: isMultiRoute,
        multiRouteInfo: isMultiRoute ? simulation.multiRouteInfo : null,
        swapPaths: hasValidPath ? simulation.swapPaths : [],
      }));
    } catch (error) {
      console.error("Failed to simulate swap:", error);
      setState((prev) => ({
        ...prev,
        toAmount: "",
        swapRoute: "",
        outPerIn: "0",
        receiveAtLeast: "0",
        protocol: "",
        isMultiRoute: false,
        multiRouteInfo: null,
        swapPaths: [],
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
  }, [
    handleFromAmountChange,
    state.fromAmount,
    state.fromToken,
    state.toToken,
  ]);

  // Prepare DeDust transaction (existing implementation)
  const prepareTonConnectMultiHopSwap = async (tonConnectUI, swapPath) => {
    const tonClient = new TonClient4({
      endpoint: "https://mainnet-v4.tonhubapi.com",
    });

    try {
      const factory = tonClient.open(
        Factory.createFromAddress(MAINNET_FACTORY_ADDR)
      );
      const firstPool = swapPath.pools[0];
      const firstToken = swapPath.path[0];
      // Get the native vault
      const vault = tonClient.open(await factory.getNativeVault());

      if ((await vault.getReadinessStatus()) !== ReadinessStatus.READY) {
        throw new Error("Vault not ready");
      }
      const fromDecimals =
        firstToken === "native"
          ? 9
          : swapPath.pools[0].assets.find(
              (a) => (a.address || a.type) === firstToken
            )?.metadata?.decimals || 9;
      // Calculate amounts
      let amountIn;
      if (firstToken === "native") {
        // For native TON, use toNano (which applies 10^9)
        amountIn = toNano(swapPath.inputAmount);
      } else {
        // For other tokens, use their specific decimals
        amountIn = convertTokenAmount(swapPath.inputAmount, fromDecimals);
      }
      const minimumOutput = toNano(swapPath.minimumAmountOut);

      // Create nested pool configuration
      const buildSwapConfig = (index = 0) => {
        if (index > swapPath.pools.length - 1) return undefined;
        return {
          poolAddress: Address.parse(swapPath.pools[index].address),
          limit:
            index === swapPath.pools.length ? toNano(minimumOutput) : undefined,
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
          toNano(0.3),
          {
            amount: amountIn,
            destination: scaleVault.address,
            responseAddress: Address.parse(userFriendlyAddress), // return gas to user
            forwardAmount: toNano("0.2"),
            forwardPayload: VaultJetton.createSwapPayload({
              poolAddress: Address.parse(firstPool.address),
              ...buildSwapConfig(),
            }),
          }
        );
      }

      return returnSwap;
    } catch (error) {
      console.error("Error preparing DeDust swap:", {
        message: error.message,
        stack: error.stack,
        swapPath: JSON.stringify(swapPath, null, 2),
      });
      throw error;
    }
  };

  // Prepare StonFi swap transaction - SINGLE HOP ONLY
  const prepareStonFiSwap = async (tonConnectUI, swapPath, version = "v1") => {
    try {
      // Check if this is a multi-hop swap
      const multiHop = isMultiHopSwap(swapPath);

      if (multiHop) {
        console.log(
          "Multi-hop swaps are not supported for StonFi at this time"
        );
        throw new Error(
          "Multi-hop swaps are not supported for StonFi at this time"
        );
      }

      const tonClient = new TonClient4({
        endpoint: "https://mainnet-v4.tonhubapi.com",
      });

      // Properly handle native TON token which might be represented as an address or "native"
      let fromToken = swapPath.path[0];
      let toToken = swapPath.path[swapPath.path.length - 1];

      // Normalize token addresses - check for TON native address
      const TON_ADDRESS = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
      if (fromToken === TON_ADDRESS) {
        fromToken = "native";
      }

      if (toToken === TON_ADDRESS) {
        toToken = "native";
      }

      // Get decimals for the from token
      const fromDecimals =
        fromToken === "native"
          ? 9
          : swapPath.pools[0].assets.find(
              (a) => (a.address || a.type) === fromToken
            )?.metadata?.decimals || 9;

      // Calculate input amount with correct decimals
      let inputAmount;
      if (fromToken === "native") {
        inputAmount = toNano(swapPath.inputAmount);
      } else {
        inputAmount = convertTokenAmount(swapPath.inputAmount, fromDecimals);
      }

      // Calculate minimum output amount (using proper decimals)
      const toDecimals =
        toToken === "native"
          ? 9
          : swapPath.pools[0].assets.find(
              (a) => (a.address || a.type) === toToken
            )?.metadata?.decimals || 9;

      const minAskAmount = convertTokenAmount(
        swapPath.minimumAmountOut,
        toDecimals
      );

      // Log important parameters for debugging
      console.log("Swap parameters:", {
        version,
        fromToken: fromToken === "native" ? "TON" : fromToken,
        toToken: toToken === "native" ? "TON" : toToken,
        inputAmount: inputAmount.toString(),
        minAskAmount: minAskAmount.toString(),
        userAddress: userFriendlyAddress,
      });

      // StonFi v1 handling - using the SDK as documented
      if (version === "v1") {
        console.log("Creating StonFi v1 router");
        const router = tonClient.open(new DEX.v1.Router());
        const proxyTon = new pTON.v1();

        // Generate transaction parameters based on swap type
        let txParams;

        if (fromToken === "native" && toToken !== "native") {
          // TON to Jetton swap
          console.log("Preparing v1 TON to Jetton swap");

          txParams = await router.getSwapTonToJettonTxParams({
            userWalletAddress: userFriendlyAddress,
            proxyTon: proxyTon,
            offerAmount: inputAmount.toString(),
            askJettonAddress: toToken,
            minAskAmount: minAskAmount.toString(),
            queryId: Date.now(),
          });
        } else if (fromToken !== "native" && toToken === "native") {
          // Jetton to TON swap
          console.log("Preparing v1 Jetton to TON swap");

          txParams = await router.getSwapJettonToTonTxParams({
            userWalletAddress: userFriendlyAddress,
            offerJettonAddress: fromToken,
            offerAmount: inputAmount.toString(),
            proxyTon: proxyTon,
            minAskAmount: minAskAmount.toString(),
            queryId: Date.now(),
          });
        } else if (fromToken !== "native" && toToken !== "native") {
          // Jetton to Jetton swap
          console.log("Preparing v1 Jetton to Jetton swap");

          txParams = await router.getSwapJettonToJettonTxParams({
            userWalletAddress: userFriendlyAddress,
            offerJettonAddress: fromToken,
            offerAmount: inputAmount.toString(),
            askJettonAddress: toToken,
            minAskAmount: minAskAmount.toString(),
            queryId: Date.now(),
          });
        } else {
          throw new Error("Invalid swap path: Both tokens are native TON");
        }

        console.log("v1 transaction parameters:", {
          to: txParams.to.toString(),
          value: txParams.value.toString(),
          hasBody: !!txParams.body,
        });

        // Send the transaction
        try {
          let payload = null;
          if (txParams.body && typeof txParams.body.toBoc === "function") {
            payload = txParams.body.toBoc().toString("base64");
          }

          await tonConnectUI.sendTransaction({
            validUntil: Date.now() + 5 * 60 * 1000,
            messages: [
              {
                address: txParams.to.toString(),
                amount: txParams.value.toString(),
                payload: payload,
              },
            ],
          });

          return true;
        } catch (error) {
          console.error("v1 transaction error:", error);
          throw error;
        }
      }
      // StonFi v2 handling (which is actually v2.1)
      else if (version === "v2") {
        // For v2.1, we need to use the specific router address
        const routerAddress =
          "kQALh-JBBIKK7gr0o4AVf9JZnEsFndqO0qTCyT-D-yBsWk0v"; // Mainnet Router v2.1.0
        const router = tonClient.open(DEX.v2_1.Router.create(routerAddress));

        // Create proxyTon for v2.1
        const proxyTonAddress =
          "kQACS30DNoUQ7NfApPvzh7eBmSZ9L4ygJ-lkNWtba8TQT-Px"; // Mainnet pTON v2.1.0
        const proxyTon = pTON.v2_1.create(proxyTonAddress);

        // Generate transaction parameters based on swap type
        let txParams;

        if (fromToken === "native" && toToken !== "native") {
          // TON to Jetton swap
          console.log("Preparing v2.1 TON to Jetton swap");

          txParams = await router.getSwapTonToJettonTxParams({
            userWalletAddress: userFriendlyAddress,
            proxyTon: proxyTon,
            offerAmount: inputAmount.toString(),
            askJettonAddress: toToken,
            minAskAmount: minAskAmount.toString(),
            queryId: Date.now(),
          });
        } else if (fromToken !== "native" && toToken === "native") {
          // Jetton to TON swap
          console.log("Preparing v2.1 Jetton to TON swap");

          txParams = await router.getSwapJettonToTonTxParams({
            userWalletAddress: userFriendlyAddress,
            offerJettonAddress: fromToken,
            offerAmount: inputAmount.toString(),
            proxyTon: proxyTon,
            minAskAmount: minAskAmount.toString(),
            queryId: Date.now(),
          });
        } else if (fromToken !== "native" && toToken !== "native") {
          // Jetton to Jetton swap
          console.log("Preparing v2.1 Jetton to Jetton swap");

          txParams = await router.getSwapJettonToJettonTxParams({
            userWalletAddress: userFriendlyAddress,
            offerJettonAddress: fromToken,
            offerAmount: inputAmount.toString(),
            askJettonAddress: toToken,
            minAskAmount: minAskAmount.toString(),
            queryId: Date.now(),
          });
        } else {
          throw new Error("Invalid swap path: Both tokens are native TON");
        }

        console.log("v2.1 transaction parameters:", {
          to: txParams.to.toString(),
          value: txParams.value.toString(),
          hasBody: !!txParams.body,
        });

        // Send the transaction
        try {
          let payload = null;
          if (txParams.body && typeof txParams.body.toBoc === "function") {
            payload = txParams.body.toBoc().toString("base64");
          }

          await tonConnectUI.sendTransaction({
            validUntil: Date.now() + 5 * 60 * 1000,
            messages: [
              {
                address: txParams.to.toString(),
                amount: txParams.value.toString(),
                payload: payload,
              },
            ],
          });

          return true;
        } catch (error) {
          console.error("v2.1 transaction error:", error);
          throw error;
        }
      } else {
        throw new Error(`Unsupported StonFi version: ${version}`);
      }
    } catch (error) {
      console.error("Error preparing StonFi swap:", error);
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

      // Check if this is a multi-hop swap
      const multiHop = isMultiHopSwap(swapPath);

      // For StonFi, reject multi-hop swaps
      if (state.protocol === "stonfi" && multiHop) {
        throw new Error(
          "Multi-hop swaps are not supported for StonFi at this time"
        );
      }

      // Log swap details for debugging
      console.log("Executing swap:", {
        protocol: state.protocol,
        multiHop,
        pathLength: swapPath.path.length,
        poolsCount: swapPath.pools.length,
        route: state.swapRoute,
      });

      // Choose the appropriate swap function based on the protocol
      if (state.protocol === "DeDust") {
        console.log("Using DeDust for swap");
        await prepareTonConnectMultiHopSwap(tonConnectUI, swapPath);
      } else if (
        state.protocol === "StonFi_v1" ||
        state.protocol === "StonFi_v2"
      ) {
        // Check if it's v1 or v2.1 based on pool data
        const poolInfo = swapPath.pools[0];

        // Log the pool info to help debugging
        console.log("StonFi pool info:", {
          address: poolInfo?.address,
          version: poolInfo?.version,
          source: poolInfo?.source,
        });

        // Determine version (v2 is actually v2.1)
        let version = "v1";
        if (poolInfo?.version && poolInfo.version.startsWith("v2")) {
          version = "v2"; // We'll treat all v2.x as v2.1 internally
        }

        console.log(`Using StonFi ${version} for swap`);
        await prepareStonFiSwap(tonConnectUI, swapPath, version);
      } else if (state.protocol === "Multi-Route") {
        console.log("Executing multi-route swap...");

        // Get the paths from the simulation
        const paths = state.swapPaths;
        if (!paths || paths.length < 2) {
          throw new Error("Invalid multi-route configuration");
        }

        // Execute each path in the multi-route
        for (let i = 0; i < paths.length; i++) {
          const path = paths[i];
          const pathPercentage = path.percentage;
          console.log(
            `Executing path ${i + 1}: ${path.source} (${pathPercentage}%)`
          );

          // Calculate input amount for this path
          const pathInputAmount = (
            Number(state.fromAmount) *
            (pathPercentage / 100)
          ).toString();
          console.log(`Path input amount: ${pathInputAmount}`);

          // Create a modified path with adjusted amounts
          const adjustedPath = {
            ...path,
            inputAmount: pathInputAmount,
          };

          // Use the appropriate protocol handler based on the path source
          if (path.source === "dedust") {
            await prepareTonConnectMultiHopSwap(tonConnectUI, adjustedPath);
          } else if (path.source.includes("stonfi")) {
            const version = path.source.includes("v1") ? "v1" : "v2";
            await prepareStonFiSwap(tonConnectUI, adjustedPath, version);
          } else {
            console.error("Unknown protocol in multi-route path:", path.source);
            throw new Error(`Unknown protocol in multi-route: ${path.source}`);
          }
        }
      } else {
        console.error("Unknown protocol:", state.protocol);
        throw new Error("Unknown protocol: " + state.protocol);
      }
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
              <>
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
                {state.isMultiRoute && (
                  <MultiRouteInfo
                    isMultiRoute={state.isMultiRoute}
                    swapPaths={state.swapPaths}
                    multiRouteInfo={state.multiRouteInfo}
                  />
                )}
              </>
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
              {isSwapping
                ? "Swapping..."
                : !isConnected
                ? "Connect Wallet"
                : !state.fromAmount
                ? "Enter Amount"
                : error || !state.rawSimulation?.swapPaths?.[0]
                ? "Failed to find quote"
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
