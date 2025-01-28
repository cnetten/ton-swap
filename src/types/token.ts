export interface Token {
  contractAddress: string;
  kind: "Ton" | "Wton" | "Jetton";
  balance?: string;
  dexPriceUsd?: string;
  meta?: {
    decimals?: number;
    symbol?: string;
    displayName?: string;
    imageUrl?: string;
    customPayloadApiUri?: string;
  };
}
