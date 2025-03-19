/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { findSwapPathsParallel } from "./parallel-finder";
import { PoolService } from "./PoolTracker";
import { findBestMultiRoute, formatMultiRoutePath } from "./multi-route-finder";

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

let cachedGraph = null;
let cachedGraphTimestamp = 0;

function buildPoolGraph(filteredPools: Pool[]) {
  const poolGraph = new Map<string, Map<string, number>>();
  const poolsByPair = new Map<string, Pool>();

  const now = Date.now();
  if (cachedGraph && now - cachedGraphTimestamp < 60000) {
    // 1 minute cache
    return cachedGraph;
  }
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

  cachedGraph = { poolGraph, poolsByPair };
  cachedGraphTimestamp = now;
  return cachedGraph;
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
  bestStonfiV1Path: PathWithCost | null;
  bestStonfiV2Path: PathWithCost | null;
  allFilteredPools: Pool[];
}> {
  const poolService = PoolService.getInstance();
  const tracker = poolService.getTracker();

  // Directly use in-memory cache first
  let dedustPools = tracker.redisCacheData.get("dedust") || [];
  let stonfiPools = tracker.redisCacheData.get("stonfi") || [];

  console.log(
    `Found ${dedustPools.length} DeDust pools and ${stonfiPools.length} StonFi pools from memory cache`
  );

  // If memory cache is empty, fall back to getPoolsBySource
  if (dedustPools.length === 0 || stonfiPools.length === 0) {
    [dedustPools, stonfiPools] = await Promise.all([
      poolService.getPoolsBySource("dedust", true),
      poolService.getPoolsBySource("stonfi", true),
    ]);
  }

  console.log(
    `After fallback: ${dedustPools.length} DeDust pools and ${stonfiPools.length} StonFi pools`
  );

  // Process pools by source - use a lower minimum liquidity for more options
  const minLiquidity = 100000;

  // Filter pools for each source
  const filteredDedustPools = tracker.filterPoolsByLiquidity(
    "dedust",
    minLiquidity,
    0.5
  );

  const filteredStonfiPoolsV1 = tracker.filterPoolsByLiquidity(
    "stonfi",
    minLiquidity,
    0.5,
    "v1"
  );

  const filteredStonfiPoolsV2 = tracker.filterPoolsByLiquidity(
    "stonfi",
    minLiquidity,
    0.5,
    "v2"
  );

  console.log(
    `After filtering: ${filteredDedustPools.length} DeDust pools, ${filteredStonfiPoolsV1.length} StonFi V1 pools and ${filteredStonfiPoolsV2.length} StonFi V2 pools`
  );

  let bestDedustPath: any | null = null;
  let bestStonfiV1Path: any | null = null;
  let bestStonfiV2Path: any | null = null;

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
  if (filteredStonfiPoolsV1.length > 0) {
    const { poolGraph: stonfiGraph, poolsByPair: stonfiPoolsByPair } =
      buildPoolGraph(filteredStonfiPoolsV1);

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
    const stonfiPaths = await findSwapPathsParallel(
      stonfiGraph,
      stonfiPoolsByPair,
      stonFiFromAdress,
      stonFiToAddress,
      amountWithDecimals,
      4, // maxDepth
      1, // maxPaths
      "stonfi"
    );

    if (stonfiPaths.length > 0) {
      bestStonfiV1Path = { ...stonfiPaths[0], source: "stonfi" };
      console.log(
        `Found best StonFi path with output: ${bestStonfiV1Path.outputAmount}`
      );
    }
  }

  if (filteredStonfiPoolsV2.length > 0) {
    const { poolGraph: stonfiGraph, poolsByPair: stonfiPoolsByPair } =
      buildPoolGraph(filteredStonfiPoolsV2);

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
    const stonfiPaths = await findSwapPathsParallel(
      stonfiGraph,
      stonfiPoolsByPair,
      stonFiFromAdress,
      stonFiToAddress,
      amountWithDecimals,
      4, // maxDepth
      1, // maxPaths
      "stonfi"
    );

    if (stonfiPaths.length > 0) {
      bestStonfiV2Path = { ...stonfiPaths[0], source: "stonfi" };
      console.log(
        `Found best StonFi path with output: ${bestStonfiV2Path.outputAmount}`
      );
    }
  }

  // Combine all filtered pools for reference
  const allFilteredPools = [
    ...filteredDedustPools,
    ...filteredStonfiPoolsV1,
    ...filteredStonfiPoolsV2,
  ];

  const result = {
    bestDedustPath,
    bestStonfiV1Path,
    bestStonfiV2Path,
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

export async function POST(req: Request) {
  if (!initialized) {
    await initializePoolService();
    initialized = true;
  }

  const startTime = performance.now();

  try {
    const {
      fromAddress,
      toAddress,
      amount,
      slippageTolerance,
      forceRefresh,
      disableMultiRoute,
    } = await req.json();

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
        const quickDedustData = await tracker.getFromRedis("quick:dedust");
        // Don't use quick data for StonFi to ensure we get all pools

        if (quickDedustData) {
          dedustPools = JSON.parse(
            typeof quickDedustData === "string"
              ? quickDedustData
              : JSON.stringify(quickDedustData)
          );
          tracker.redisCacheData.set("dedust", dedustPools);
        }

        // Always get full StonFi pools
        const fullStonfiPools = await poolService.getPoolsBySource(
          "stonfi",
          false
        );
        if (fullStonfiPools && fullStonfiPools.length > 0) {
          stonfiPools = fullStonfiPools;
          tracker.redisCacheData.set("stonfi", stonfiPools);
          console.log(`Loaded ${stonfiPools.length} full StonFi pools`);
        }

        allPools = [...dedustPools, ...stonfiPools];
      } catch (error) {
        console.error("Error loading pool data:", error);
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
      try {
        // First check memory cache directly (fastest)
        const memoryCacheKey = `${actualFromAddress}-${actualToAddress}-${amountWithDecimals}`;
        let cachedPath = null;

        if (tracker.pathCache.has(memoryCacheKey)) {
          const expiry = tracker.pathCacheExpiry.get(memoryCacheKey) || 0;

          // Check if still valid
          if (expiry > Date.now()) {
            cachedPath = tracker.pathCache.get(memoryCacheKey);
            console.log(`Memory cache hit for path ${memoryCacheKey}`);
          }
        }

        // If not found in memory, try Redis
        if (!cachedPath) {
          cachedPath = await tracker.getPathFromCache(
            actualFromAddress,
            actualToAddress,
            amountWithDecimals
          );
        }

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
      } catch (error) {
        console.error("Error checking cache:", error);
        // Continue with path finding even if cache check fails
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
    const slippageDecimal = slippageTolerance || 0.005;

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
      setTimeout(() => reject(new Error("Path finding timed out")), 20000);
    });

    // Parameters for multi-route functionality
    const MIN_AMOUNT_FOR_MULTI_ROUTE = "1000000000"; // 1 TON in nanoTON
    const MIN_IMPROVEMENT_PERCENT = 3; // Require at least 3% improvement

    // Find paths for each protocol
    const {
      bestDedustPath,
      bestStonfiV1Path,
      bestStonfiV2Path,
      allFilteredPools,
    } = (await Promise.race([pathFindingPromise, timeoutPromise])) as {
      bestDedustPath: PathWithCost | null;
      bestStonfiV1Path: PathWithCost | null;
      bestStonfiV2Path: PathWithCost | null;
      allFilteredPools: Pool[];
    };

    // Get token decimals for formatting outputs
    const toDecimals = getTokenDecimals(actualToAddress, allFilteredPools);

    // Check if multi-route should be enabled
    const enableMultiRoute = !disableMultiRoute;

    // Find multi-route options if enabled
    const multiRouteResult = enableMultiRoute
      ? findBestMultiRoute(
          bestDedustPath,
          bestStonfiV1Path,
          bestStonfiV2Path,
          preciseAmountWithDecimals,
          MIN_IMPROVEMENT_PERCENT,
          MIN_AMOUNT_FOR_MULTI_ROUTE
        )
      : {
          useMultiRoute: false,
          bestSinglePath: null,
          multiRoute: {
            paths: [],
            percentages: [],
            outputs: [],
            totalOutput: "0",
          },
        };

    // Format the response based on whether we're using multi-route or single path
    let result;

    if (multiRouteResult.useMultiRoute) {
      // Handle multi-route response
      const multiRoutePaths = multiRouteResult.multiRoute.paths
        .map((path, index) => {
          if (!path) return null;

          const percentage = multiRouteResult.multiRoute.percentages[index];
          const outputAmount = multiRouteResult.multiRoute.outputs[index];
          const inputPercentage = percentage / 100;

          // Calculate input amount for this path
          const pathInputAmount = BigInt(
            Math.floor(Number(preciseAmountWithDecimals) * inputPercentage)
          ).toString();

          return {
            ...path,
            path: path.path,
            pathReadable: path.pathReadable,
            outPutMint: actualToAddress,
            pools: path.pools,
            inputAmount: normalizeAmount(pathInputAmount, actualFromDecimals),
            estimatedOutput: normalizeAmount(outputAmount, toDecimals),
            minimumAmountOut:
              Number(normalizeAmount(outputAmount, toDecimals)) -
              Number(normalizeAmount(outputAmount, toDecimals)) *
                slippageDecimal,
            estimatedGasFees: 0,
            outPerIn: (
              Number(normalizeAmount(outputAmount, toDecimals)) /
              (Number(normalizeAmount(pathInputAmount, actualFromDecimals)) ||
                1)
            ).toFixed(9),
            pathDepth: path.pathDepth,
            source: path.source,
            percentage: percentage,
          };
        })
        .filter(Boolean);

      // Create human-readable description of the multi-route
      const multiRouteReadable = formatMultiRoutePath(
        multiRouteResult.multiRoute.paths,
        multiRouteResult.multiRoute.percentages
      );

      result = {
        swapPaths: multiRoutePaths,
        isMultiRoute: true,
        multiRouteInfo: {
          percentages: multiRouteResult.multiRoute.percentages,
          totalOutput: normalizeAmount(
            multiRouteResult.multiRoute.totalOutput,
            toDecimals
          ),
          pathReadable: multiRouteReadable,
        },
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
          stonfiV1: bestStonfiV1Path
            ? {
                outputAmount: normalizeAmount(
                  bestStonfiV1Path.outputAmount,
                  toDecimals
                ),
                pathDepth: bestStonfiV1Path.pathDepth,
              }
            : null,
          stonfiV2: bestStonfiV2Path
            ? {
                outputAmount: normalizeAmount(
                  bestStonfiV2Path.outputAmount,
                  toDecimals
                ),
                pathDepth: bestStonfiV2Path.pathDepth,
              }
            : null,
          bestExchange: "multi-route",
          requestTimeMs: 0, // Will be updated before response
        },
      };
    } else {
      // Use the best single path (whether DeDust multi-hop or direct)
      const bestPath = [bestDedustPath, bestStonfiV1Path, bestStonfiV2Path]
        .filter(Boolean)
        .reduce((best, current) => {
          if (!best) return current;
          if (!current) return best;

          return BigInt(current.outputAmount) > BigInt(best.outputAmount)
            ? current
            : best;
        }, null);

      if (!bestPath) {
        return NextResponse.json({
          error: "No valid swap paths found",
          swapPaths: [],
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
            stonfiV1: bestStonfiV1Path
              ? {
                  outputAmount: normalizeAmount(
                    bestStonfiV1Path.outputAmount,
                    toDecimals
                  ),
                  pathDepth: bestStonfiV1Path.pathDepth,
                }
              : null,
            stonfiV2: bestStonfiV2Path
              ? {
                  outputAmount: normalizeAmount(
                    bestStonfiV2Path.outputAmount,
                    toDecimals
                  ),
                  pathDepth: bestStonfiV2Path.pathDepth,
                }
              : null,
          },
        });
      }

      // Format the result
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
        pathDepth: bestPath.pathDepth,
        source: bestPath.source,
      };

      result = {
        swapPaths: [formattedPath],
        isMultiRoute: false,
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
          stonfiV1: bestStonfiV1Path
            ? {
                outputAmount: normalizeAmount(
                  bestStonfiV1Path.outputAmount,
                  toDecimals
                ),
                pathDepth: bestStonfiV1Path.pathDepth,
              }
            : null,
          stonfiV2: bestStonfiV2Path
            ? {
                outputAmount: normalizeAmount(
                  bestStonfiV2Path.outputAmount,
                  toDecimals
                ),
                pathDepth: bestStonfiV2Path.pathDepth,
              }
            : null,
          bestExchange: bestPath.source,
          requestTimeMs: 0, // Will be updated below
        },
      };
    }

    // Calculate request time
    const endTime = performance.now();
    const requestTime = Math.round(endTime - startTime);
    result.exchangeComparison.requestTimeMs = requestTime;

    // Cache the result for future requests
    await poolService.cachePathResult(
      actualFromAddress,
      actualToAddress,
      preciseAmountWithDecimals,
      result
    );

    return NextResponse.json(result);
  } catch (error: any) {
    console.error("Error in POST handler:", error);
    const endTime = performance.now();

    if (global.gc) {
      setTimeout(() => {
        try {
          global.gc();
        } catch (e) {
          console.log("GC error:", e);
        }
      }, 100);
    }

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
