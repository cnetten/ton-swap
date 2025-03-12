/* eslint-disable @typescript-eslint/no-explicit-any */
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
    const fetchTokens = async () => {
      try {
        // Fetch tokens from STON API
        const client = new StonApiClient();
        const searchedAssets = await client.searchAssets({
          searchString: "",
          condition: `${AssetTag.LiquidityHigh} | ${AssetTag.Popular}`,
          walletAddress: walletAddress,
        });

        // Fetch tokens from DeDust API
        const deDustAssets = await getDeDustAssets();

        // Convert DeDust assets to Token format
        const deDustTokens = deDustAssets.map((asset: any) => {
          return {
            contractAddress: asset.type === "native" ? "TON" : asset.address,
            meta: {
              symbol: asset.symbol,
              displayName: asset.name,
              imageUrl: asset.image,
              decimals: asset.decimals,
            },
            // Optional price information if available
            dexPriceUsd: null,
          };
        });

        // Merge tokens, avoiding duplicates by checking contractAddress
        const mergedTokens = [...searchedAssets];

        deDustTokens.forEach((deDustToken) => {
          const exists = mergedTokens.some(
            (token) => token.contractAddress === deDustToken.contractAddress
          );

          if (!exists) {
            mergedTokens.push(deDustToken);
          }
        });

        setTokens(mergedTokens);
        setFilteredTokens(mergedTokens);
      } catch (error) {
        console.error("Error fetching tokens:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchTokens();
  }, [walletAddress, currentTokenAddress]);

  const getDeDustAssets = async () => {
    try {
      const url = "https://api.dedust.io/v2/assets";
      const response = await fetch(url);
      const assets = await response.json();
      return assets;
    } catch (error) {
      console.error("Error fetching DeDust assets:", error);
      return [];
    }
  };

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
                  className={`w-full flex items-center p-3 h-auto ${
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
                      className="rounded-full flex-shrink-0"
                    />
                  )}

                  <div className="flex-grow mx-4 min-w-0">
                    <div className="font-semibold truncate">
                      {token?.meta?.symbol ? token.meta.symbol : ""}
                    </div>
                    <div className="text-sm text-gray-500 truncate">
                      {token?.meta?.displayName ? token.meta.displayName : ""}
                    </div>
                  </div>

                  {token.dexPriceUsd && (
                    <div className="text-sm text-gray-500 flex-shrink-0">
                      ${parseFloat(token.dexPriceUsd).toFixed(4)}
                    </div>
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
