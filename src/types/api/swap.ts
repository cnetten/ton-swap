type BlockchainAddress = {
  blockchain: number;
  address: string;
};

type QuoteParams = {
  swap: {
    routes: {
      steps: {
        offerAssetAddress: BlockchainAddress;
        askAssetAddress: BlockchainAddress;
        chunks: {
          protocol: string;
          offerAmount: string;
          askAmount: string;
          extraDataJson: string;
        }[];
        extraDataJson: string;
      }[];
      gasBudget: string;
      extraDataJson: string;
    }[];
  };
};

export type Quote = {
  quoteId: string;
  resolverId: string;
  resolverName: string;
  offerAssetAddress: BlockchainAddress;
  askAssetAddress: BlockchainAddress;
  offerUnits: string;
  askUnits: string;
  referrerFeeUnits: string;
  protocolFeeUnits: string;
  quoteTimestamp: number;
  tradeStartDeadline: number;
  params: QuoteParams;
};

export interface GetQuoteParams {
  fromAddress: string;
  toAddress: string;
  amount: string;
  slippageTolerance?: string;
}
