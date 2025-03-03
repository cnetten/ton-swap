/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { findSwapPathsParallel } from "./parallel-finder";
import { PoolService } from "./PoolTracker";

// Initialize on first request
let initialized = false;

// Define a constant for the fast update interval
const FAST_UPDATE_INTERVAL = 3000; // 3 seconds
const FULL_UPDATE_INTERVAL = 60000; // 60 seconds

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

function buildPoolGraph(filteredPools: Pool[]) {
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

// Initialize PoolService
async function initializePoolService(): Promise<void> {
  const poolService = PoolService.getInstance();
  await poolService.initialize();
  console.log("PoolService initialized");
}

function parseRedisTimestamp(redisValue: any): number {
  if (!redisValue) return 0;

  if (typeof redisValue === "number") {
    return redisValue;
  }

  if (typeof redisValue === "string") {
    const parsed = parseInt(redisValue);
    return isNaN(parsed) ? 0 : parsed;
  }

  return 0;
}

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
  const tracker = poolService.getTracker();

  // Check cache first for this exact swap
  const cachedResult = await poolService.getPathFromCache(
    fromAddress,
    toAddress,
    amountWithDecimals
  );

  if (cachedResult) {
    // Since we're in a serverless environment, we need better cache validation
    // Get the latest update timestamps from Redis
    const [lastDedustUpdate, lastStonfiUpdate] = await Promise.all([
      tracker.redis.get("lastUpdate:dedust"),
      tracker.redis.get("lastUpdate:stonfi"),
    ]);

    // Parse timestamps to ensure proper comparison
    const pathCacheTime = cachedResult.timestamp || 0;
    const dedustTimestamp = parseRedisTimestamp(lastDedustUpdate);
    const stonfiTimestamp = parseRedisTimestamp(lastStonfiUpdate);

    // Get the most recent update time
    const latestUpdateTime = Math.max(dedustTimestamp, stonfiTimestamp);

    // Only use cache if it's newer than the last pool update
    if (pathCacheTime > latestUpdateTime) {
      console.log(
        `Using cached path result (cache: ${new Date(
          pathCacheTime
        ).toISOString()}, last update: ${new Date(
          latestUpdateTime
        ).toISOString()})`
      );
      return cachedResult;
    }

    console.log(
      `Cache invalidated - cache time: ${new Date(
        pathCacheTime
      ).toISOString()}, latest update: ${new Date(
        latestUpdateTime
      ).toISOString()}`
    );
  }

  console.log("Fetching pools from all sources...");

  // Get pools from different sources - use skipUpdate=true to avoid delays
  const [dedustPools, stonfiPools] = await Promise.all([
    poolService.getPoolsBySource("dedust", true),
    poolService.getPoolsBySource("stonfi", true),
  ]);

  console.log(
    `Found ${dedustPools.length} DeDust pools and ${stonfiPools.length} StonFi pools`
  );

  // Process pools by source - use a lower minimum liquidity for more options
  const minLiquidity = 100000;

  // Filter pools for each source
  const filteredDedustPools = tracker.filterPoolsByLiquidity(
    "dedust",
    minLiquidity,
    0.5
  );

  const filteredStonfiPools = tracker.filterPoolsByLiquidity(
    "stonfi",
    minLiquidity,
    0.5
  );

  console.log(
    `After filtering: ${filteredDedustPools.length} DeDust pools and ${filteredStonfiPools.length} StonFi pools`
  );

  let bestDedustPath: any | null = null;
  let bestStonfiPath: any | null = null;

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

  // Find best path for StonFi pools (only if enough pools are available)
  if (filteredStonfiPools.length > 0) {
    const { poolGraph: stonfiGraph, poolsByPair: stonfiPoolsByPair } =
      buildPoolGraph(filteredStonfiPools);

    console.log(`StonFi graph has ${stonfiGraph.size} nodes`);

    const stonFiFromAdress =
      fromAddress === "native"
        ? "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c"
        : fromAddress;
    const stonFiToAddress =
      toAddress === "native"
        ? "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c"
        : toAddress;

    console.log("Finding swap paths for StonFi pools...");
    // const stonfiPaths = await findSwapPathsParallel(
    //   stonfiGraph,
    //   stonfiPoolsByPair,
    //   stonFiFromAdress,
    //   stonFiToAddress,
    //   amountWithDecimals,
    //   4, // maxDepth
    //   1, // maxPaths
    //   "stonfi"
    // );

    const stonfiPaths = [];

    if (stonfiPaths.length > 0) {
      bestStonfiPath = { ...stonfiPaths[0], source: "stonfi" };
      console.log(
        `Found best StonFi path with output: ${bestStonfiPath.outputAmount}`
      );
    }
  }

  // Combine all filtered pools for reference
  const allFilteredPools = [...filteredDedustPools, ...filteredStonfiPools];

  const result = { bestDedustPath, bestStonfiPath, allFilteredPools };

  // Cache the result for future requests
  poolService.cachePathResult(fromAddress, toAddress, amountWithDecimals, {
    ...result,
    timestamp: Date.now(),
  });

  return result;
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
  }

  const startTime = performance.now();

  try {
    const { fromAddress, toAddress, amount, slippageTolerance, forceRefresh } =
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

    const poolService = PoolService.getInstance();
    const tracker = poolService.getTracker();

    if (forceRefresh) {
      console.log("Force refreshing pools before quote");
      const tracker = poolService.getTracker();
      await tracker.performFastUpdate();
    }
    // Always pass skipUpdate=true to avoid triggering updates during quote requests
    const [dedustPools, stonfiPools] = await Promise.all([
      poolService.getPoolsBySource("dedust", true),
      poolService.getPoolsBySource("stonfi", true),
    ]);

    // Combine all pools for decimals lookup
    const allPools = [...dedustPools, ...stonfiPools];

    // Get fromDecimals before finding paths
    const fromDecimals = getTokenDecimals(actualFromAddress, allPools);
    const amountNumber = Number(amount);
    const amountInteger = Math.floor(amountNumber * 10 ** fromDecimals);
    console.log(amountInteger);
    const amountWithDecimals = BigInt(amountInteger).toString();

    // Convert slippageTolerance to decimal (e.g., 0.5 -> 0.005)
    const slippageDecimal = (slippageTolerance || 0.5) / 100;
    console.log(`Using slippage tolerance: ${slippageDecimal * 100}%`);

    // Find best paths for each exchange separately - this will use skipUpdate=true internally
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
        }, // Include the source in the result
      });
    }

    // Format the result
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

    const endTime = performance.now();
    const requestTime = Math.round(endTime - startTime);
    console.log(`Request processed in ${requestTime}ms`);

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
        requestTimeMs: requestTime,
      },
    });
  } catch (error: any) {
    console.error("Error in POST handler:", error);
    const endTime = performance.now();

    return NextResponse.json(
      {
        error:
          error?.message ||
          "An unexpected error occurred while requesting the swap quote",
        details: error?.stack,
        requestTimeMs: Math.round(endTime - startTime),
      },
      {
        status: error?.status || 500,
        headers: {
          "Cache-Control": "no-store, max-age=0, must-revalidate",
          Pragma: "no-cache",
          Expires: "0",
        },
      }
    );
  }
}
