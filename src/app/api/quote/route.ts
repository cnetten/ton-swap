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

  // OPTIMIZATION: Check cache first with faster validation
  const cacheKey = `path:${fromAddress}-${toAddress}-${amountWithDecimals}`;
  const cachedData = await tracker.redis.get(cacheKey);

  if (cachedData) {
    try {
      // Parse cached result
      const cachedResult =
        typeof cachedData === "string" ? JSON.parse(cachedData) : cachedData;

      // Check if the cached result has a timestamp
      const pathCacheTime = cachedResult.timestamp || 0;
      const now = Date.now();
      const cacheAge = now - pathCacheTime;

      // If cache is recent (less than 30 seconds), use it without further checks
      if (cacheAge < 30000) {
        console.log(`Using recent cached path result (${cacheAge}ms old)`);
        return cachedResult;
      }

      // For older cache, verify against pool updates
      const [lastDedustUpdate, lastStonfiUpdate] = await Promise.all([
        tracker.redis.get(`lastUpdate:dedust`),
        tracker.redis.get(`lastUpdate:stonfi`),
      ]);

      // Parse timestamps for comparison
      const dedustTimestamp = parseRedisTimestamp(lastDedustUpdate);
      const stonfiTimestamp = parseRedisTimestamp(lastStonfiUpdate);

      // Get the most recent update time
      const latestUpdateTime = Math.max(dedustTimestamp, stonfiTimestamp);

      // Only use cache if it's newer than the last pool update
      if (pathCacheTime > latestUpdateTime) {
        console.log(
          `Using validated cached path (cache: ${new Date(
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
    } catch (error) {
      console.error(`Error parsing cached result:`, error);
      // Continue if parsing fails
    }
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

  const result = {
    bestDedustPath,
    bestStonfiPath,
    allFilteredPools,
    timestamp: Date.now(), // Add timestamp to result
  };

  // Cache the result for future requests
  poolService.cachePathResult(
    fromAddress,
    toAddress,
    amountWithDecimals,
    result
  );

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

    // OPTIMIZATION: Use in-memory cache for faster token decimal lookups
    let dedustPools = tracker.redisCacheData.get("dedust") || [];
    let stonfiPools = tracker.redisCacheData.get("stonfi") || [];

    // Combine pools for the initial decimals lookup
    let allPools = [...dedustPools, ...stonfiPools];

    // If memory cache is empty, quickly check if we have the "quick" data in Redis
    if (allPools.length === 0) {
      try {
        const quickDedustData = await tracker.redis.get("quick:dedust");
        const quickStonfiData = await tracker.redis.get("quick:stonfi");

        if (quickDedustData) {
          dedustPools = JSON.parse(
            typeof quickDedustData === "string"
              ? quickDedustData
              : JSON.stringify(quickDedustData)
          );
          tracker.redisCacheData.set("dedust", dedustPools);
        }

        if (quickStonfiData) {
          stonfiPools = JSON.parse(
            typeof quickStonfiData === "string"
              ? quickStonfiData
              : JSON.stringify(quickStonfiData)
          );
          tracker.redisCacheData.set("stonfi", stonfiPools);
        }

        allPools = [...dedustPools, ...stonfiPools];
      } catch (error) {
        console.error("Error loading quick data from Redis:", error);
      }
    }

    // If we still have no pools, fall back to full Redis load
    if (allPools.length === 0) {
      // Only load from Redis if memory cache is empty
      [dedustPools, stonfiPools] = await Promise.all([
        poolService.getPoolsBySource("dedust", true), // skipUpdate=true to avoid delays
        poolService.getPoolsBySource("stonfi", true),
      ]);

      allPools = [...dedustPools, ...stonfiPools];
    }

    // Calculate amount with decimals for path finding
    // Default to 9 decimals until we can determine the actual decimals
    const fromDecimals = getTokenDecimals(actualFromAddress, allPools);
    const amountNumber = Number(amount);
    const amountInteger = Math.floor(amountNumber * 10 ** fromDecimals);
    const amountWithDecimals = BigInt(amountInteger).toString();

    // Try to get cached path if not forcing refresh
    if (!forceRefresh) {
      const cachedPath = await tracker.getPathFromCache(
        actualFromAddress,
        actualToAddress,
        amountWithDecimals
      );

      if (cachedPath) {
        console.log("Using cached path result");
        const endTime = performance.now();
        const requestTime = Math.round(endTime - startTime);

        // Add request time to the response
        return NextResponse.json({
          ...cachedPath,
          requestTimeMs: requestTime,
          fromCache: true,
        });
      }
    }

    // No cached result or force refresh requested - continue with normal flow
    if (forceRefresh) {
      console.log("Force refreshing pools before quote");
      tracker.redisCacheData.clear();
      // Only perform update if explicitly requested
      await tracker.performFastUpdate();

      // Reload pools after update
      [dedustPools, stonfiPools] = await Promise.all([
        poolService.getPoolsBySource("dedust", true),
        poolService.getPoolsBySource("stonfi", true),
      ]);

      allPools = [...dedustPools, ...stonfiPools];
    }

    // OPTIMIZATION: If we have fewer than 10 pools total, something is wrong
    // Try a fast update but don't wait for it to complete
    if (allPools.length < 10) {
      console.log("Not enough pools loaded, triggering background fast update");
      // Don't await - let it happen in the background
      tracker
        .performFastUpdate()
        .catch((err) => console.error("Background update error:", err));
    }

    // Get accurate fromDecimals based on available pools
    const actualFromDecimals = getTokenDecimals(actualFromAddress, allPools);
    const preciseAmountInteger = Math.floor(
      amountNumber * 10 ** actualFromDecimals
    );
    const preciseAmountWithDecimals = BigInt(preciseAmountInteger).toString();

    // Convert slippageTolerance to decimal
    const slippageDecimal = (slippageTolerance || 0.5) / 100;

    // OPTIMIZATION: Use a timeout for the path finding to avoid long-running functions
    // This helps prevent Vercel function timeouts
    const pathFindingPromise = findBestPathsBySource(
      actualFromAddress,
      actualToAddress,
      preciseAmountWithDecimals,
      slippageDecimal
    );

    // Set a reasonable timeout for path finding (8 seconds)
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Path finding timed out")), 8000);
    });

    // Race between path finding and timeout
    const { bestDedustPath, bestStonfiPath, allFilteredPools } =
      (await Promise.race([pathFindingPromise, timeoutPromise])) as any;

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
    const toDecimals = getTokenDecimals(actualToAddress, bestPath.pools);

    const formattedPath = {
      path: bestPath.path,
      pathReadable: bestPath.pathReadable,
      outPutMint: toAddress,
      pools: bestPath.pools,
      estimatedOutput: normalizeAmount(bestPath.outputAmount, toDecimals),
      inputAmount: normalizeAmount(bestPath.inputAmount, actualFromDecimals),
      minimumAmountOut:
        Number(normalizeAmount(bestPath.outputAmount, toDecimals)) -
        Number(normalizeAmount(bestPath.outputAmount, toDecimals)) *
          slippageDecimal,
      estimatedGasFees: 0,
      outPerIn: (
        Number(normalizeAmount(bestPath.outputAmount, toDecimals)) /
        Number(normalizeAmount(bestPath.inputAmount, actualFromDecimals))
      ).toFixed(9),
      pathDepth: bestPath.pathDepth + 1,
      source: bestPath.source,
    };

    const endTime = performance.now();
    const requestTime = Math.round(endTime - startTime);
    console.log(`Request processed in ${requestTime}ms`);

    const result = {
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
    };

    // Cache the path in the background
    poolService
      .cachePathResult(
        actualFromAddress,
        actualToAddress,
        preciseAmountWithDecimals,
        result
      )
      .catch((err) => console.error("Error caching path:", err));

    return NextResponse.json(result);
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
