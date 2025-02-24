/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
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
  source?: string; // Track source of the pool (dedust/stonfi)
}

interface PathWithCost {
  path: string[];
  pathReadable: string;
  pools: Pool[];
  outputAmount: string;
  estimatedOutput: string;
  inputAmount: string;
  minimumAmountOut: number;
  estimatedGasFees: number;
  outPerIn: string;
  pathDepth: number;
  outPutMint: string;
  source?: string; // Source exchange (dedust/stonfi)
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

    // Check trading activity - only if it's DeDust pools as StonFi might not have this data structure
    if (pool.source === "dedust" || !pool.source) {
      const totalVolume = pool.stats.volume
        .map((v) => parseFloat(v) || 0)
        .reduce((a, b) => a + b, 0);

      if (totalVolume === 0) {
        return false;
      }
    }

    return true;
  });
};

// Process and find best paths for each exchange source separately
async function findBestPathsBySource(
  fromAddress: string,
  toAddress: string,
  amountWithDecimals: string,
  slippageDecimal: number
): Promise<{
  bestDedustPath: PathWithCost | null;
  bestStonfiPath: PathWithCost | null;
  allFilteredPools: Pool[];
}> {
  const poolService = PoolService.getInstance();
  console.log("Fetching pools from all sources...");

  // Get pools from different sources
  const dedustPools = await poolService.getPoolsBySource("dedust");
  const stonfiPools = await poolService.getPoolsBySource("stonfi");

  console.log(
    `Found ${dedustPools.length} DeDust pools and ${stonfiPools.length} StonFi pools`
  );

  // Process pools by source
  const minLiquidity = 100000;

  // Filter pools for each source
  const filteredDedustPools = filterPoolsByLiquidity(
    dedustPools,
    minLiquidity,
    slippageDecimal
  );
  const filteredStonfiPools = filterPoolsByLiquidity(
    stonfiPools,
    minLiquidity,
    slippageDecimal
  );

  console.log(
    `After filtering: ${filteredDedustPools.length} DeDust pools and ${filteredStonfiPools.length} StonFi pools`
  );

  let bestDedustPath: PathWithCost | null = null;
  let bestStonfiPath: PathWithCost | null = null;

  // Find best path for DeDust pools
  if (filteredDedustPools.length > 0) {
    const { poolGraph: dedustGraph, poolsByPair: dedustPoolsByPair } =
      buildPoolGraph(filteredDedustPools);

    console.log("Finding swap paths for DeDust pools...");
    const dedustPaths = await findSwapPathsParallel(
      dedustGraph,
      dedustPoolsByPair,
      fromAddress,
      toAddress,
      amountWithDecimals,
      4, // maxDepth
      1 // maxPaths
    );

    if (dedustPaths.length > 0) {
      bestDedustPath = { ...dedustPaths[0], source: "dedust" };
      console.log(
        `Found best DeDust path with output: ${bestDedustPath.outputAmount}`
      );
    }
  }

  // Find best path for StonFi pools
  if (filteredStonfiPools.length > 0) {
    const { poolGraph: stonfiGraph, poolsByPair: stonfiPoolsByPair } =
      buildPoolGraph(filteredStonfiPools);

    console.log("Finding swap paths for StonFi pools...");
    const stonfiPaths = await findSwapPathsParallel(
      stonfiGraph,
      stonfiPoolsByPair,
      fromAddress,
      toAddress,
      amountWithDecimals,
      4, // maxDepth
      1 // maxPaths
    );

    if (stonfiPaths.length > 0) {
      bestStonfiPath = { ...stonfiPaths[0], source: "stonfi" };
      console.log(
        `Found best StonFi path with output: ${bestStonfiPath.outputAmount}`
      );
    }
  }

  // Combine all filtered pools for reference
  const allFilteredPools = [...filteredDedustPools, ...filteredStonfiPools];

  return { bestDedustPath, bestStonfiPath, allFilteredPools };
}

// Compare and select the best path overall
function selectBestPath(
  dedustPath: PathWithCost | null,
  stonfiPath: PathWithCost | null
): PathWithCost | null {
  if (!dedustPath && !stonfiPath) {
    return null;
  }

  if (!dedustPath) return stonfiPath;
  if (!stonfiPath) return dedustPath;

  // Compare output amounts to determine which is better
  const dedustOutput = BigInt(dedustPath.outputAmount);
  const stonfiOutput = BigInt(stonfiPath.outputAmount);

  console.log(
    `Comparing outputs - DeDust: ${dedustOutput}, StonFi: ${stonfiOutput}`
  );

  return dedustOutput >= stonfiOutput ? dedustPath : stonfiPath;
}

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

    // Convert slippageTolerance to decimal (e.g., 0.5 -> 0.005)
    const slippageDecimal = (slippageTolerance || 0.5) / 100;
    console.log(`Using slippage tolerance: ${slippageDecimal * 100}%`);

    // Find best paths for each exchange separately
    const { bestDedustPath, bestStonfiPath, allFilteredPools } =
      await findBestPathsBySource(
        actualFromAddress,
        actualToAddress,
        amountWithDecimals,
        slippageDecimal
      );

    // Select the best path overall
    const bestPath = selectBestPath(bestDedustPath, bestStonfiPath);

    if (!bestPath) {
      return NextResponse.json({
        error: "No valid swap paths found",
        swapPaths: [],
        exchangeComparison: {
          dedust: bestDedustPath
            ? {
                outputAmount: bestDedustPath.outputAmount,
                pathDepth: bestDedustPath.pathDepth,
              }
            : null,
          stonfi: bestStonfiPath
            ? {
                outputAmount: bestStonfiPath.outputAmount,
                pathDepth: bestStonfiPath.pathDepth,
              }
            : null,
        },
      });
    }

    // Format the result
    const fromDecimals = getTokenDecimals(actualFromAddress, bestPath.pools);
    const toDecimals = getTokenDecimals(actualToAddress, bestPath.pools);

    const formattedPath = {
      path: bestPath.path,
      pathReadable: bestPath.pathReadable,
      outPutMint: toAddress,
      pools: bestPath.pools,
      estimatedOutput: normalizeAmount(bestPath.outputAmount, toDecimals),
      inputAmount: normalizeAmount(bestPath.inputAmount, fromDecimals),
      minimumAmountOut:
        Number(normalizeAmount(bestPath.outputAmount, toDecimals)) -
        Number(normalizeAmount(bestPath.outputAmount, toDecimals)) *
          slippageDecimal,
      estimatedGasFees: 0,
      outPerIn: (
        Number(normalizeAmount(bestPath.outputAmount, toDecimals)) /
        Number(normalizeAmount(bestPath.inputAmount, fromDecimals))
      ).toFixed(9),
      pathDepth: bestPath.pathDepth + 1,
      source: bestPath.source, // Include the source in the result
    };

    return NextResponse.json({
      swapPaths: [formattedPath],
      exchangeComparison: {
        dedust: bestDedustPath
          ? {
              outputAmount: normalizeAmount(
                bestDedustPath.outputAmount,
                toDecimals
              ),
              pathDepth: bestDedustPath.pathDepth,
            }
          : null,
        stonfi: bestStonfiPath
          ? {
              outputAmount: normalizeAmount(
                bestStonfiPath.outputAmount,
                toDecimals
              ),
              pathDepth: bestStonfiPath.pathDepth,
            }
          : null,
        bestExchange: bestPath.source,
      },
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
