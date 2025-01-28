import { Token } from "@/types/token";

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
