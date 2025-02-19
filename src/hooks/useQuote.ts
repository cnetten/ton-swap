import { GetQuoteParams } from "@/types/api/swap";
import { useState } from "react";

export const useQuote = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getQuote = async ({
    fromAddress,
    toAddress,
    amount,
    slippageTolerance = "0.005", // Default 0.5% slippage tolerance
  }: GetQuoteParams) => {
    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch("/api/quote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fromAddress,
          toAddress,
          amount,
          slippageTolerance,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to simulate swap");
      }

      const quote = await response.json();
      return quote;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to simulate swap");
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  return {
    getQuote,
    isLoading,
    error,
  };
};
