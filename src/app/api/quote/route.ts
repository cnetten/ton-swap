import { NextResponse } from "next/server";
import { findSwapPathsParallel } from "./parallel-finder";
import { initializePoolService } from "../init";
import { PoolService } from "./PoolTracker";

// Initialize on first request
let initialized = false;

interface Pool {
  address: string;
  lt: string;
  totalSupply: string;
  type: string;
  tradeFee: string;
  assets: Array<{
    type: string;
    address?: string;
    metadata: any;
  }>;
  lastPrice: string;
  reserves: string[];
  stats: {
    fees: string[];
    volume: string[];
  };
}

function getTokenDecimals(tokenId: string, pools: Pool[]): number {
  if (tokenId === "native") return 9;

  for (const pool of pools) {
    const asset = pool.assets.find(
      (a) => a.address === tokenId || a.type === tokenId
    );
    if (asset?.metadata?.decimals !== undefined) {
      return asset.metadata.decimals;
    }
  }
  return 9;
}

function normalizeAmount(amount: string, decimals: number): string {
  return (Number(amount) / Math.pow(10, decimals)).toFixed(decimals);
}

export function buildPoolGraph(filteredPools: Pool[]) {
  const poolGraph = new Map<string, Map<string, number>>();
  const poolsByPair = new Map<string, Pool>();

  // Initialize the graph with empty maps for each token
  filteredPools.forEach((pool: Pool) => {
    if (!pool.assets || pool.assets.length !== 2) return;
    pool.assets.forEach((asset) => {
      const id = asset.address || asset.type;
      if (!poolGraph.has(id)) {
        poolGraph.set(id, new Map());
      }
    });
  });

  // Build connections
  filteredPools.forEach((pool: Pool) => {
    if (
      !pool.assets ||
      pool.assets.length !== 2 ||
      !pool.reserves ||
      pool.reserves.length !== 2
    )
      return;

    const [asset1, asset2] = pool.assets;
    if (!asset1 || !asset2) return;

    // Skip pools with zero or invalid reserves
    if (
      !pool.reserves[0] ||
      !pool.reserves[1] ||
      BigInt(pool.reserves[0]) <= BigInt(0) ||
      BigInt(pool.reserves[1]) <= BigInt(0)
    )
      return;

    const id1 = asset1.address || asset1.type;
    const id2 = asset2.address || asset2.type;

    const pairKey = [id1, id2].sort().join("-");
    poolsByPair.set(pairKey, pool);

    // Add bidirectional connections
    poolGraph.get(id1)?.set(id2, 1);
    poolGraph.get(id2)?.set(id1, 1);
  });

  console.log("Building graph completed. Nodes:", poolGraph.size);
  return { poolGraph, poolsByPair };
}

export const filterPoolsByLiquidity = (
  pools: Pool[],
  minReserve: number,
  slippageTolerance: number = 0.005
): Pool[] => {
  const maxTradeFee = 0.5; // Convert to percentage
  console.log(`Filtering pools with trade fee > ${maxTradeFee}%`);

  return pools.filter((pool) => {
    // Basic pool validation
    if (!pool?.assets?.length || !pool?.reserves?.length || !pool?.stats) {
      return false;
    }

    // Check trade fee against slippage tolerance
    const tradeFee = parseFloat(pool.tradeFee || "0");
    if (tradeFee > parseFloat(maxTradeFee)) {
      return false;
    }

    // Validate pool structure
    if (pool.assets.length !== 2 || pool.reserves.length !== 2) {
      return false;
    }

    // Validate assets
    for (const asset of pool.assets) {
      if (asset.type === "native") continue;
      if (!asset.metadata?.symbol || asset.metadata?.name?.includes("Stake")) {
        return false;
      }
    }

    // Validate and check reserves
    try {
      const [reserve1, reserve2] = pool.reserves.map((r) => parseFloat(r));
      if (
        isNaN(reserve1) ||
        isNaN(reserve2) ||
        reserve1 < minReserve ||
        reserve2 < minReserve
      ) {
        return false;
      }
    } catch {
      return false;
    }

    // Check trading activity
    const totalVolume = pool.stats.volume
      .map((v) => parseFloat(v) || 0)
      .reduce((a, b) => a + b, 0);

    if (totalVolume === 0) {
      return false;
    }

    return true;
  });
};

export async function POST(req: Request) {
  if (!initialized) {
    await initializePoolService();
    initialized = true;
    // Wait a bit for initial data
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  try {
    const { fromAddress, toAddress, amount, slippageTolerance } =
      await req.json();

    if (!fromAddress || !toAddress || !amount || isNaN(amount) || amount <= 0) {
      return NextResponse.json(
        { error: "Invalid or missing required parameters" },
        { status: 400 }
      );
    }

    // Convert TON pool address to 'native' type
    const actualFromAddress =
      fromAddress === "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c"
        ? "native"
        : fromAddress;
    const actualToAddress =
      toAddress === "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c"
        ? "native"
        : toAddress;

    // Convert amount to proper decimal representation (assuming 9 decimals)
    const amountNumber = Number(amount);
    const amountInteger = Math.floor(amountNumber * 1e9);
    const amountWithDecimals = BigInt(amountInteger).toString();

    // const poolProcessor = new PoolProcessor();
    const poolService = PoolService.getInstance();

    console.log("Fetching pools...");
    // const allPools = await poolProcessor.getAndProcessPools({
    //   minLiquidity: 1000000,
    //   maxTradeFee: 0.5,
    //   batchSize: 50,
    // });
    const allPools = await poolService.getPools();
    // Convert slippageTolerance to decimal (e.g., 0.5 -> 0.005)
    const slippageDecimal = (slippageTolerance || 0.5) / 100;
    console.log(`Using slippage tolerance: ${slippageDecimal * 100}%`);

    // Filter pools based on liquidity and slippage
    const filteredPools = filterPoolsByLiquidity(
      allPools,
      100000,
      slippageDecimal
    );
    console.log(
      `Fetched ${allPools.length} pools, filtered to ${filteredPools.length} based on liquidity and slippage`
    );

    // Build pool graph after filtering
    const { poolGraph, poolsByPair } = buildPoolGraph(filteredPools);
    // await refreshRelevantPools(
    //   poolGraph,
    //   poolsByPair,
    //   actualFromAddress,
    //   actualToAddress,
    //   poolService
    // );
    console.log("Finding swap paths...");
    // const swapPaths = findAllSwapPathsOptimized(
    //   poolGraph,
    //   poolsByPair,
    //   actualFromAddress,
    //   actualToAddress,
    //   amountWithDecimals
    // );
    const swapPaths = await findSwapPathsParallel(
      poolGraph,
      poolsByPair,
      actualFromAddress,
      actualToAddress,
      amountWithDecimals,
      4, // maxDepth
      1 // maxPaths
    );

    console.log(`Found ${swapPaths.length} valid paths`);

    if (swapPaths.length === 0) {
      return NextResponse.json({
        error: "No valid swap paths found",
        swapPaths: [],
      });
    }

    return NextResponse.json({
      swapPaths: swapPaths.map((path) => {
        const fromDecimals = getTokenDecimals(actualFromAddress, path.pools);
        const toDecimals = getTokenDecimals(actualToAddress, path.pools);

        return {
          path: path.path,
          pathReadable: path.pathReadable,
          outPutMint: toAddress,
          pools: path.pools,
          estimatedOutput: normalizeAmount(path.outputAmount, toDecimals),
          inputAmount: normalizeAmount(path.inputAmount, fromDecimals),
          minimumAmountOut:
            Number(normalizeAmount(path.outputAmount, toDecimals)) -
            Number(normalizeAmount(path.outputAmount, toDecimals)) *
              slippageDecimal,
          estimatedGasFees: 0,
          outPerIn: (
            Number(normalizeAmount(path.outputAmount, toDecimals)) /
            Number(normalizeAmount(path.inputAmount, fromDecimals))
          ).toFixed(9),
          pathDepth: path.pathDepth + 1,
        };
      }),
    });
  } catch (error: any) {
    console.error("Error in POST handler:", error);
    return NextResponse.json(
      {
        error:
          error?.message ||
          "An unexpected error occurred while requesting the swap quote",
        details: error?.stack,
      },
      { status: error?.status || 500 }
    );
  }
}
