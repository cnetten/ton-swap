import { Token } from "@/types/token";
import { fromNano, toNano } from "@ton/core";

export const calculatePrice = (token: Token, label: string, amount: string) => {
  if (!token?.dexPriceUsd) return null;
  const tokenPrice = Number(token.dexPriceUsd);
  console.log(token);
  const inputAmount = parseFloat(amount);

  if (label === "Pay") {
    if (!amount || inputAmount === 0) {
      return tokenPrice.toFixed(2);
    }
    return (tokenPrice * inputAmount).toFixed(2);
  } else if (label === "Receive") {
    if (!amount || inputAmount === 0) {
      return tokenPrice;
    }
    return (Number(tokenPrice) * Number(amount)).toFixed(2);
  }

  return tokenPrice.toFixed(2);
};

export function calculatePriceImpact(
  initialPrice: number,
  finalPrice: number
): number {
  if (initialPrice <= 0) {
    throw new Error("Initial price must be greater than 0");
  }

  const priceImpact = ((initialPrice - finalPrice) / initialPrice) * 100;
  return priceImpact;
}

export function calculateInitialSwapOutput(
  inputAmount: string,
  pool: any,
  inputTokenId: string,
  outputTokenId: string
): string {
  try {
    // Convert input amount to nano
    const inputTokenIndex = pool.assets.findIndex(
      (asset) => (asset.address || asset.type) === inputTokenId
    );
    const outputTokenIndex = pool.assets.findIndex(
      (asset) => (asset.address || asset.type) === outputTokenId
    );

    if (inputTokenIndex === -1 || outputTokenIndex === -1) {
      console.error("Token not found in pool", {
        inputTokenId,
        outputTokenId,
        poolAssets: pool.assets,
      });
      return "0";
    }

    const inputTokenDecimals =
      pool.assets[inputTokenIndex].metadata?.decimals || 9;
    const outputTokenDecimals =
      pool.assets[outputTokenIndex].metadata?.decimals || 9;

    // Convert to nano using toNano
    const inputAmountBN = toNano(inputAmount);

    const inputReserve = pool.reserves[inputTokenIndex];
    const outputReserve = pool.reserves[outputTokenIndex];

    if (!inputReserve || !outputReserve) {
      console.error("Invalid reserves", { inputReserve, outputReserve });
      return "0";
    }

    const inputReserveBN = BigInt(inputReserve);
    const outputReserveBN = BigInt(outputReserve);
    const feeBPS = BigInt(Math.floor(parseFloat(pool.tradeFee) * 100));
    const BPS_DENOMINATOR = BigInt(10000);

    const inputAmountWithFee =
      (inputAmountBN * (BPS_DENOMINATOR - feeBPS)) / BPS_DENOMINATOR;

    const numerator = outputReserveBN * inputAmountWithFee;
    const denominator = inputReserveBN + inputAmountWithFee;

    const outputAmount = numerator / denominator;

    // Convert back from nano to decimal
    const formattedOutput = fromNano(outputAmount);

    return formattedOutput;
  } catch (error) {
    console.error("Error in swap output calculation:", error);
    return "0";
  }
}
