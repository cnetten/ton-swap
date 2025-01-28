import React, { useEffect, useState } from "react";
import Image from "next/image";
import { StonApiClient } from "@ston-fi/api";
import { useTheme } from "next-themes";
import { Input } from "@/components/ui/input";
import { AssetTag } from "@ston-fi/api";
import { Button } from "@/components/ui/button";
import { DialogTitle } from "@/components/ui/dialog";
import { Token } from "@/types/token";

interface TokenSelectorProps {
  onSelect: (token: Token) => void;
  walletAddress?: string;
  currentTokenAddress?: string;
}

export const TokenSelector: React.FC<TokenSelectorProps> = ({
  onSelect,
  walletAddress,
  currentTokenAddress,
}) => {
  const { theme } = useTheme();
  const [tokens, setTokens] = useState<Token[]>([]);
  const [filteredTokens, setFilteredTokens] = useState<Token[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchSwappableTokens = async () => {
      try {
        const client = new StonApiClient();

        const searchedAssets = await client.searchAssets({
          searchString: "",
          condition: `${AssetTag.LiquidityVeryHigh} | ${AssetTag.LiquidityHigh} | ${AssetTag.Popular}`,
          walletAddress: walletAddress,
        });

        const availableTokens = searchedAssets;

        setTokens(availableTokens);
        setFilteredTokens(availableTokens);
      } catch (error) {
        console.error("Error fetching swappable tokens:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchSwappableTokens();
  }, [walletAddress, currentTokenAddress]);

  useEffect(() => {
    if (searchQuery && tokens?.length > 0) {
      const filtered = tokens.filter((token) => {
        if (!token?.meta) return false;

        return (
          token.meta.symbol
            ?.toLowerCase()
            .includes(searchQuery.toLowerCase()) ||
          token.meta.displayName
            ?.toLowerCase()
            .includes(searchQuery.toLowerCase()) ||
          token.contractAddress
            ?.toLowerCase()
            .includes(searchQuery.toLowerCase())
        );
      });
      setFilteredTokens(filtered);
    } else {
      setFilteredTokens(tokens || []);
    }
  }, [searchQuery, tokens]);

  return (
    <div className="w-full">
      <DialogTitle className="text-xl font-bold m-0"></DialogTitle>
      <div className="space-y-4">
        <Input
          type="text"
          placeholder="Search by name or paste address"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full"
        />

        <div className="max-h-96 overflow-y-auto space-y-2">
          {isLoading ? (
            <div className="text-center py-4">Loading tokens...</div>
          ) : filteredTokens.length > 0 ? (
            filteredTokens.map((token) => {
              return (
                <Button
                  key={token.contractAddress}
                  variant="ghost"
                  className={`w-full justify-between items-center p-3 h-auto ${
                    theme === "dark" ? "hover:bg-zinc-800" : "hover:bg-gray-100"
                  }`}
                  onClick={() => onSelect(token)}
                >
                  {token?.meta?.imageUrl && (
                    <Image
                      src={token.meta.imageUrl}
                      alt={token.meta.symbol ? token.meta.symbol : ""}
                      width={32}
                      height={32}
                      className="rounded-full mr-4"
                    />
                  )}

                  <div className="w-full flex flex-col items-start">
                    <span className="w-max font-semibold">
                      {token?.meta?.symbol ? token.meta.symbol : ""}
                    </span>
                    <span className="text-sm text-gray-500">
                      {token?.meta?.displayName ? token.meta.displayName : ""}
                    </span>
                  </div>
                  {token.dexPriceUsd && (
                    <span className="w-max text-sm text-gray-500">
                      ${parseFloat(token.dexPriceUsd).toFixed(6)}
                    </span>
                  )}
                </Button>
              );
            })
          ) : (
            <div className="text-center py-4">No tokens found</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TokenSelector;
