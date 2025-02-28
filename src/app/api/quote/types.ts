// app/api/quote/types.ts

export interface Pool {
  address: string;
  lt: string;
  totalSupply: string;
  type: string;
  tradeFee: string;
  assets: Array<{
    type: string;
    address?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metadata: any;
  }>;
  lastPrice: string;
  reserves: string[];
  stats: {
    fees: string[];
    volume: string[];
  };
  source?: string;
}

export interface PathWithCost {
  path: string[];
  pathReadable: string;
  pools: Pool[];
  estimatedOutput: string;
  inputAmount: string;
  outputAmount: string;
  outPerIn: string;
  pathDepth: number;
}

export interface WorkerData {
  startNodes: string[];
  targetNode: string;
  inputAmount: string;
  maxDepth: number;
  graph: { [key: string]: { [key: string]: number } };
  poolsByPair: { [key: string]: Pool };
  visited: string[];
}
