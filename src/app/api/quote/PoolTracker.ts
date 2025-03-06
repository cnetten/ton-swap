/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { TonClient4, Address } from "@ton/ton";
import { EventEmitter } from "events";
import { DeDustClient } from "@dedust/sdk";
import { StonApiClient } from "@ston-fi/api";
import { Redis } from "@upstash/redis";
import { fetchWithRetry } from "./utils/utils";
import { DEX } from "@ston-fi/sdk";

// Pool data interfaces remain unchanged
interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
}

interface TokenAsset {
  type: string;
  address?: string;
  metadata: TokenMetadata;
}

interface Pool {
  address: string;
  lt: string;
  totalSupply: string;
  type: string;
  tradeFee: string;
  assets: TokenAsset[];
  lastPrice: any;
  reserves: string[];
  stats: {
    fees: string[];
    volume: string[];
  };
  source?: string;
  version?: string;
  lastUpdateTimestamp?: number;
  volatility?: number; // Added for tracking pool volatility
}

// Interfaces for external pools remain unchanged
interface StonFiPool {
  address: string;
  apy_1d: string;
  apy_30d: string;
  apy_7d: string;
  collectedToken0ProtocolFee: string;
  collectedToken1ProtocolFee: string;
  deprecated: boolean;
  lpAccountAddress: string;
  lpBalance: string;
  lpFee: string;
  lpPriceUsd: string;
  lpTotalSupply: string;
  lpTotalSupplyUsd: string;
  lpWalletAddress: string;
  popularity_index: number;
  protocolFee: string;
  protocolFeeAddress: string;
  ref_fee: string;
  reserve0: string;
  reserve1: string;
  router_address: string;
  token0Address: string;
  token0Balance: string;
  token1Address: string;
  token1Balance: string;
}

interface DeDustPool {
  address: string;
  lt: string;
  totalSupply: string;
  type: string;
  tradeFee: string;
  assets: TokenAsset[];
  lastPrice: any;
  reserves: string[];
  stats: {
    fees: string[];
    volume: string[];
  };
}

class PoolTracker extends EventEmitter {
  private tonClient: TonClient4;
  private poolAddresses: Set<string>;
  private isTracking: boolean = false;

  // Update intervals
  private readonly FAST_UPDATE_INTERVAL = 3000; // 3 seconds between fast updates
  private readonly FULL_UPDATE_INTERVAL = 60000; // 60 seconds between full updates
  private trackingIntervals: NodeJS.Timeout[] = [];

  // Redis and cache management
  public redis: Redis;
  public redisCacheData: Map<string, Pool[]> = new Map();

  // OPTIMIZATION: Tiered cache with hot and cold pools
  private hotPoolsCache: Map<string, Pool> = new Map(); // High-traffic pools
  private readonly HOT_POOLS_KEY = "hot:pools"; // Redis key for hot pools list
  private readonly HOT_POOLS_MAX = 100; // Maximum number of hot pools

  // OPTIMIZATION: Adaptive chunk sizes based on pool importance
  private readonly HIGH_VOLUME_CHUNK_SIZE = 100; // Smaller chunks for frequently accessed pools
  private readonly LOW_VOLUME_CHUNK_SIZE = 300; // Larger chunks for less frequently accessed pools
  private readonly DEFAULT_CHUNK_SIZE = 200; // Default chunk size
  private readonly CHUNK_KEY_PREFIX = "pools:chunk:";

  // Flag keys
  private readonly UPDATE_IN_PROGRESS_KEY = "updateInProgress";

  // Path cache management
  public pathCache = new Map<string, any>();
  public pathCacheExpiry = new Map<string, number>();
  private readonly PATH_CACHE_TTL = 30000; // 30 seconds TTL for path cache

  // Pool volatility tracking for adaptive TTL
  private poolVolatility = new Map<string, number>();
  private readonly VOLATILITY_THRESHOLD_HIGH = 0.1; // 10% change
  private readonly VOLATILITY_THRESHOLD_MEDIUM = 0.05; // 5% change

  // API clients for direct calls
  private dedustClient: DeDustClient;
  private stonfiClient: StonApiClient;

  //Stonfi router addresses
  private StonfiV1 = DEX.v1.Router.address;

  // Define for TypeScript
  public performFastUpdate: () => Promise<void>;
  public performFullUpdate: () => Promise<void>;

  // Memory properties
  private memoryUpdateInterval: NodeJS.Timeout | null = null;
  private redisPersistInterval: NodeJS.Timeout | null = null;
  private readonly MEMORY_UPDATE_SECONDS = 5;
  private readonly REDIS_PERSIST_MINUTES = 5;
  constructor(
    private readonly tonEndpoint: string = "https://mainnet-v4.tonhubapi.com"
  ) {
    super();
    this.tonClient = new TonClient4({ endpoint: tonEndpoint });
    this.poolAddresses = new Set();

    // Initialize Redis client with Upstash
    this.redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL || "",
      token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
    });

    // Initialize API clients
    this.dedustClient = new DeDustClient({
      endpointUrl: "https://api.dedust.io",
    });
    this.stonfiClient = new StonApiClient();

    // Initialize these methods with no-ops, they'll be properly defined in startTracking
    this.performFastUpdate = async () => {};
    this.performFullUpdate = async () => {};

    // Initialize hot pools cache
    this.initializeHotPoolsCache().catch((err) =>
      console.error("Error initializing hot pools cache:", err)
    );
  }

  // OPTIMIZATION: Initialize hot pools cache
  private async initializeHotPoolsCache(): Promise<void> {
    try {
      const hotPoolsData = await this.redis.get(this.HOT_POOLS_KEY);
      if (hotPoolsData) {
        const hotPools =
          typeof hotPoolsData === "string"
            ? JSON.parse(hotPoolsData)
            : hotPoolsData;

        if (Array.isArray(hotPools)) {
          // Load hot pools into memory
          this.hotPoolsCache.clear();
          for (const pool of hotPools) {
            this.hotPoolsCache.set(pool.address, pool);
          }
          console.log(
            `Loaded ${this.hotPoolsCache.size} hot pools into memory cache`
          );
        }
      }
    } catch (error) {
      console.error("Error initializing hot pools cache:", error);
    }
  }

  // OPTIMIZATION: Update hot pools cache with frequently accessed pools
  private async updateHotPoolsCache(): Promise<void> {
    try {
      // Get current hot pools
      const currentHotPools = Array.from(this.hotPoolsCache.values());

      // Get high volume pools from each source
      const dedustPools = this.redisCacheData.get("dedust") || [];
      const stonfiPools = this.redisCacheData.get("stonfi") || [];

      // Find high volume pools (simplified approach - in production you'd use more metrics)
      const highVolumePools = [...dedustPools, ...stonfiPools]
        .filter((pool) => this.isHighVolumePool(pool))
        .slice(0, this.HOT_POOLS_MAX);

      if (highVolumePools.length > 0) {
        // Update memory cache
        this.hotPoolsCache.clear();
        for (const pool of highVolumePools) {
          this.hotPoolsCache.set(pool.address, pool);
        }

        // Update Redis
        await this.redis.set(
          this.HOT_POOLS_KEY,
          JSON.stringify(highVolumePools),
          { ex: 3600 } // 1 hour expiry
        );

        console.log(
          `Updated hot pools cache with ${highVolumePools.length} pools`
        );
      }
    } catch (error) {
      console.error("Error updating hot pools cache:", error);
    }
  }

  // OPTIMIZATION: Check if a pool is high volume
  private isHighVolumePool(pool: Pool): boolean {
    if (!pool.stats?.volume) return false;

    // Calculate total volume
    const totalVolume = pool.stats.volume.reduce((sum, vol) => {
      return sum + (parseFloat(vol) || 0);
    }, 0);

    // Check pool reserves
    const hasHighReserves =
      pool.reserves &&
      pool.reserves.length === 2 &&
      parseFloat(pool.reserves[0]) > 1000000 &&
      parseFloat(pool.reserves[1]) > 1000000;

    // Is high volume if total volume > 10000 and has high reserves
    return totalVolume > 10000 && hasHighReserves;
  }

  // OPTIMIZATION: Determine chunk size based on pool importance
  private getChunkSize(source: string, pools: Pool[]): number {
    // For high volume sources or pools with frequent updates, use smaller chunks
    if (source === "dedust" && this.isHighUpdateFrequencySource(source)) {
      return this.HIGH_VOLUME_CHUNK_SIZE;
    }

    // For low volume sources or pools with infrequent updates, use larger chunks
    if (this.isLowUpdateFrequencySource(source)) {
      return this.LOW_VOLUME_CHUNK_SIZE;
    }

    // Default chunk size
    return this.DEFAULT_CHUNK_SIZE;
  }

  // Helper to check if source has high update frequency
  private isHighUpdateFrequencySource(source: string): boolean {
    // In a real implementation, you would track update frequency metrics
    // For now, just assume dedust is high frequency
    return source === "dedust";
  }

  // Helper to check if source has low update frequency
  private isLowUpdateFrequencySource(source: string): boolean {
    // In a real implementation, you would track update frequency metrics
    // For now, just assume stonfi has lower update frequency
    return source === "stonfi";
  }

  // OPTIMIZATION: Get TTL based on pool volatility
  private getPoolTTL(pool: Pool): number {
    const volatility = this.poolVolatility.get(pool.address) || 0;

    if (volatility > this.VOLATILITY_THRESHOLD_HIGH) {
      return 60; // 1 minute for highly volatile pools
    } else if (volatility > this.VOLATILITY_THRESHOLD_MEDIUM) {
      return 300; // 5 minutes for medium volatility
    } else {
      return 1800; // 30 minutes for stable pools
    }
  }

  // OPTIMIZATION: Update pool volatility based on reserve changes
  private updatePoolVolatility(
    pool: Pool,
    previousPool: Pool | undefined
  ): void {
    if (
      !previousPool ||
      !pool.reserves ||
      !previousPool.reserves ||
      pool.reserves.length !== 2 ||
      previousPool.reserves.length !== 2
    ) {
      return;
    }

    try {
      // Calculate percent change in reserves
      const reserve0Change = Math.abs(
        (parseFloat(pool.reserves[0]) - parseFloat(previousPool.reserves[0])) /
          parseFloat(previousPool.reserves[0])
      );

      const reserve1Change = Math.abs(
        (parseFloat(pool.reserves[1]) - parseFloat(previousPool.reserves[1])) /
          parseFloat(previousPool.reserves[1])
      );

      // Use maximum change as volatility indicator
      const volatility = Math.max(reserve0Change, reserve1Change);

      // Update volatility tracking
      this.poolVolatility.set(pool.address, volatility);

      // Also store volatility in the pool object
      pool.volatility = volatility;
    } catch (error) {
      // Ignore errors in volatility calculation
    }
  }

  private async shouldRefreshPools(source: string): Promise<boolean> {
    try {
      // Check when this source was last updated
      const lastUpdateKey = `lastUpdate:${source}`;
      const lastUpdateData = await this.redis.get(lastUpdateKey);

      if (!lastUpdateData) {
        // No record of update, should refresh
        return true;
      }

      const lastUpdate =
        typeof lastUpdateData === "string"
          ? parseInt(lastUpdateData)
          : typeof lastUpdateData === "number"
          ? lastUpdateData
          : 0;

      const now = Date.now();
      // If data is older than 2 minutes, refresh
      return now - lastUpdate > 120000;
    } catch (error) {
      console.error(`Error checking if ${source} pools need refresh:`, error);
      // On error, assume refresh is needed
      return true;
    }
  }

  // OPTIMIZATION: Enhanced quick response data storage
  public async storeQuickResponseData(
    source: string,
    pools: Pool[]
  ): Promise<void> {
    try {
      // OPTIMIZATION: Create smaller, optimized version focused on essential data
      const minimalPools = pools.map((pool) => ({
        address: pool.address,
        reserves: pool.reserves,
        assets: pool.assets.map((asset) => ({
          type: asset.type,
          address: asset.address,
          metadata: {
            decimals: asset.metadata.decimals,
            symbol: asset.metadata.symbol,
          },
        })),
        tradeFee: pool.tradeFee,
        source: pool.source,
        lastUpdateTimestamp: Date.now(),
      }));

      // Serialize the data
      const jsonData = JSON.stringify(minimalPools);

      // OPTIMIZATION: Use pipelining for multiple related Redis operations
      const pipeline = this.redis.pipeline();

      // Check if the data exceeds Upstash's 1MB limit (use 900KB to be safe)
      const MAX_REDIS_SIZE = 900000; // ~900KB

      if (jsonData.length <= MAX_REDIS_SIZE) {
        // If small enough, store directly with a short TTL
        pipeline.set(`quick:${source}`, jsonData, { ex: 300 });

        // Add a short expiry timestamp
        pipeline.set(`quick:${source}:timestamp`, Date.now().toString(), {
          ex: 300,
        });

        await pipeline.exec();
        console.log(
          `Stored ${minimalPools.length} quick access pools for ${source}`
        );
      } else {
        // If too large, store in chunks
        console.log(
          `Quick data for ${source} is ${(
            jsonData.length /
            1024 /
            1024
          ).toFixed(2)}MB, chunking...`
        );

        // Calculate how many chunks we need - smaller chunks for quicker access
        const numChunks = Math.ceil(minimalPools.length / 100); // ~100 pools per chunk for quick data

        // Store metadata
        pipeline.set(
          `quick:${source}:meta`,
          JSON.stringify({
            totalPools: minimalPools.length,
            chunks: numChunks,
            timestamp: Date.now(),
          }),
          { ex: 300 }
        );

        // Execute pipeline first for metadata
        await pipeline.exec();

        // Create a new pipeline for chunks
        const chunksPipeline = this.redis.pipeline();

        // Store each chunk
        for (let i = 0; i < numChunks; i++) {
          const chunkStart = i * 100;
          const chunkEnd = Math.min((i + 1) * 100, minimalPools.length);
          const chunk = minimalPools.slice(chunkStart, chunkEnd);

          chunksPipeline.set(
            `quick:${source}:chunk:${i}`,
            JSON.stringify(chunk),
            { ex: 300 }
          );
        }

        // Execute chunks pipeline
        await chunksPipeline.exec();

        console.log(
          `Stored ${minimalPools.length} quick access pools for ${source} in ${numChunks} chunks`
        );
      }
    } catch (error) {
      console.error(`Error storing quick response data for ${source}:`, error);

      // OPTIMIZATION: Enhanced fallback with better error handling
      if (error.toString().includes("max request size exceeded")) {
        try {
          console.log(
            `Attempting to store ultra-minimal data for ${source}...`
          );

          // Create an ultra-minimal version with just essential data
          // Focus on the most important pools first
          const topPools = pools
            .slice(0, 500) // Limit to 500 most important pools
            .sort((a, b) => {
              // Sort by estimated volume/liquidity
              const aVolume = a.stats?.volume
                ? a.stats.volume.reduce(
                    (sum, vol) => sum + (parseFloat(vol) || 0),
                    0
                  )
                : 0;
              const bVolume = b.stats?.volume
                ? b.stats.volume.reduce(
                    (sum, vol) => sum + (parseFloat(vol) || 0),
                    0
                  )
                : 0;
              return bVolume - aVolume;
            });

          const ultraMinimalPools = topPools.map((pool) => ({
            address: pool.address,
            reserves: pool.reserves,
            source: pool.source,
            // Only include minimal asset info
            assets: pool.assets
              ? [
                  {
                    type: pool.assets[0]?.type,
                    address: pool.assets[0]?.address,
                  },
                  {
                    type: pool.assets[1]?.type,
                    address: pool.assets[1]?.address,
                  },
                ]
              : [],
          }));

          await this.redis.set(
            `quick:${source}:minimal`,
            JSON.stringify(ultraMinimalPools),
            { ex: 300 }
          );
          console.log(
            `Stored ${ultraMinimalPools.length} ultra-minimal pools for ${source}`
          );
        } catch (fallbackError) {
          console.error(
            `Failed to store even minimal data for ${source}:`,
            fallbackError
          );
        }
      }
    }
  }

  // OPTIMIZATION: Enhanced path result caching with compression
  public async cachePathResult(
    fromAddress: string,
    toAddress: string,
    amount: string,
    result: any
  ): Promise<void> {
    try {
      const cacheKey = `path:${fromAddress}-${toAddress}-${amount}`;

      // OPTIMIZATION: Determine TTL based on token volatility
      const ttl = this.getPathCacheTTL(fromAddress, toAddress);

      // OPTIMIZATION: Add timestamp for validation
      const resultWithMeta = {
        ...result,
        timestamp: Date.now(),
        fromAddress,
        toAddress,
        amount,
      };

      // Serialize the data
      const jsonData = JSON.stringify(resultWithMeta);

      // For large objects, consider compression or storing only essential fields
      if (jsonData.length > 50000) {
        // Create compressed version with only essential fields
        const compressedResult = {
          swapPaths:
            result.swapPaths?.map((path: any) => ({
              path: path.path,
              estimatedOutput: path.estimatedOutput,
              inputAmount: path.inputAmount,
              minimumAmountOut: path.minimumAmountOut,
              outPerIn: path.outPerIn,
              pathDepth: path.pathDepth,
              source: path.source,
            })) || [],
          exchangeComparison: result.exchangeComparison,
          timestamp: Date.now(),
        };

        // Store compressed version
        await this.redis.set(cacheKey, JSON.stringify(compressedResult), {
          ex: ttl,
        });
        console.log(
          `Cached compressed path result for ${cacheKey} (TTL: ${ttl}s)`
        );
      } else {
        // Store the full result for smaller payloads
        await this.redis.set(cacheKey, jsonData, { ex: ttl });
        console.log(`Cached path result for ${cacheKey} (TTL: ${ttl}s)`);
      }

      // Also update in-memory cache for even faster access
      this.pathCache.set(
        `${fromAddress}-${toAddress}-${amount}`,
        resultWithMeta
      );
      this.pathCacheExpiry.set(
        `${fromAddress}-${toAddress}-${amount}`,
        Date.now() + ttl * 1000
      );

      // OPTIMIZATION: Track frequently requested paths for prioritized updates
      this.trackFrequentPath(fromAddress, toAddress);
    } catch (error) {
      console.error("Error caching path result in Redis:", error);

      // Fall back to in-memory cache only
      this.pathCache.set(`${fromAddress}-${toAddress}-${amount}`, {
        ...result,
        timestamp: Date.now(),
      });
      this.pathCacheExpiry.set(
        `${fromAddress}-${toAddress}-${amount}`,
        Date.now() + 30000
      );
    }
  }

  // OPTIMIZATION: Track frequently requested paths
  private async trackFrequentPath(
    fromAddress: string,
    toAddress: string
  ): Promise<void> {
    try {
      const pathKey = [fromAddress, toAddress].sort().join("-");

      // Update the sorted set of frequent paths with timestamp as score
      await this.redis.zadd("frequentPaths", {
        score: Date.now(),
        member: pathKey,
      });

      // Keep the set trimmed to most recent 100 paths
      await this.redis.zremrangebyrank("frequentPaths", 0, -101);
    } catch (error) {
      // Non-critical operation, just log the error
      console.error("Error tracking frequent path:", error);
    }
  }

  // OPTIMIZATION: Get appropriate TTL for path cache based on token volatility
  private getPathCacheTTL(fromAddress: string, toAddress: string): number {
    try {
      // Check if either token is in high volatility list
      const isHighVolatility =
        this.isHighVolatilityToken(fromAddress) ||
        this.isHighVolatilityToken(toAddress);

      if (isHighVolatility) {
        return 10; // 10 seconds for high volatility paths
      }

      // Check if path includes native TON token (often more stable)
      const includesNative =
        fromAddress === "native" ||
        toAddress === "native" ||
        fromAddress === "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c" ||
        toAddress === "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";

      if (includesNative) {
        return 60; // 60 seconds for paths with native token
      }

      // Default TTL
      return 30; // 30 seconds for normal paths
    } catch (error) {
      // On error, use default TTL
      return 30;
    }
  }

  // Helper to check if token has high volatility
  private isHighVolatilityToken(tokenAddress: string): boolean {
    // In production, maintain a list of high volatility tokens based on price action
    // For this implementation, just use a placeholder
    const highVolatilityTokens = new Set([
      // Add addresses of known volatile tokens here
    ]);

    return highVolatilityTokens.has(tokenAddress);
  }

  // OPTIMIZATION: Enhanced path cache retrieval with validation
  public async getPathFromCache(
    fromAddress: string,
    toAddress: string,
    amount: string
  ): Promise<any | null> {
    try {
      // First try memory cache for fastest access
      const memoryCacheKey = `${fromAddress}-${toAddress}-${amount}`;

      if (this.pathCache.has(memoryCacheKey)) {
        const expiry = this.pathCacheExpiry.get(memoryCacheKey) || 0;

        // Check if still valid
        if (expiry > Date.now()) {
          // Memory cache hit
          return this.pathCache.get(memoryCacheKey);
        } else {
          // Expired, remove from memory
          this.pathCache.delete(memoryCacheKey);
          this.pathCacheExpiry.delete(memoryCacheKey);
        }
      }

      // Try Redis cache
      const cacheKey = `path:${fromAddress}-${toAddress}-${amount}`;
      const cachedData = await this.redis.get(cacheKey);

      if (!cachedData) {
        return null;
      }

      // Parse the cached result
      const cachedResult =
        typeof cachedData === "string" ? JSON.parse(cachedData) : cachedData;

      // Validate the result
      if (!cachedResult.timestamp) {
        console.log(`Invalid cache entry for ${cacheKey}, missing timestamp`);
        return null;
      }

      // Check if cache is still valid
      const now = Date.now();
      const cacheAge = now - cachedResult.timestamp;

      // OPTIMIZATION: Apply dynamic cache validation based on volatility
      const maxAge = this.getPathCacheTTL(fromAddress, toAddress) * 1000;

      if (cacheAge > maxAge) {
        console.log(
          `Cache expired for ${cacheKey}, age: ${cacheAge}ms, max: ${maxAge}ms`
        );
        return null;
      }

      // Update memory cache for future fast access
      this.pathCache.set(memoryCacheKey, cachedResult);
      this.pathCacheExpiry.set(memoryCacheKey, now + maxAge);

      return cachedResult;
    } catch (error) {
      console.error("Error retrieving path from Redis cache:", error);
      return null;
    }
  }

  // Add a method to check if data has actually changed
  private async hasDataChanged(
    source: string,
    newPools: Pool[]
  ): Promise<boolean> {
    try {
      // Get the current timestamp
      const now = Date.now();

      // First check the lastUpdate timestamp
      const lastUpdateKey = `lastUpdate:${source}`;
      const lastUpdateData = await this.redis.get(lastUpdateKey);

      let lastUpdateValue: number | null = null;
      if (typeof lastUpdateData === "string") {
        lastUpdateValue = parseInt(lastUpdateData);
      } else if (typeof lastUpdateData === "number") {
        lastUpdateValue = lastUpdateData;
      }

      // Force update if no previous update or if it's been more than 15 seconds
      if (lastUpdateValue === null || now - lastUpdateValue > 15000) {
        console.log(
          `Forcing update for ${source}: ${
            lastUpdateValue
              ? `last update was ${now - lastUpdateValue}ms ago`
              : "no previous update"
          }`
        );
        return true;
      }

      // If last update was very recent (within 2 seconds), avoid duplicate updates
      if (lastUpdateValue && now - lastUpdateValue < 2000) {
        console.log(
          `Skipping Redis update for ${source}, last update was ${
            now - lastUpdateValue
          }ms ago`
        );
        return false;
      }

      // OPTIMIZATION: Force update every 30 seconds regardless of detected changes
      if (lastUpdateValue && now - lastUpdateValue > 30000) {
        console.log(`Forcing update for ${source} after 30 seconds`);
        return true;
      }

      // OPTIMIZATION: Enhanced change detection with better pool sampling
      // Get metadata to access existing pools
      const metadataKey = `pools:meta:${source}`;
      const metadataData = await this.redis.get(metadataKey);

      if (!metadataData) {
        return true;
      }

      // Parse metadata
      const metadata =
        typeof metadataData === "string"
          ? JSON.parse(metadataData)
          : metadataData;

      if (!metadata || !metadata.chunks) {
        return true;
      }

      // OPTIMIZATION: Get both high-volume pools and recently changed pools
      const firstChunkKey = `${this.CHUNK_KEY_PREFIX}${source}:0`;
      const firstChunkData = await this.redis.get(firstChunkKey);

      if (!firstChunkData) {
        return true;
      }

      const firstChunk =
        typeof firstChunkData === "string"
          ? JSON.parse(firstChunkData)
          : firstChunkData;

      // Create map of existing high-volume pools
      const existingPoolMap = new Map<string, Pool>();
      for (const pool of firstChunk) {
        existingPoolMap.set(pool.address, pool);
      }

      // OPTIMIZATION: Also check hot pools from memory cache
      for (const [address, pool] of this.hotPoolsCache.entries()) {
        if (pool.source === source) {
          existingPoolMap.set(address, pool);
        }
      }

      // Check recently changed pools from Redis
      const recentlyChangedKey = `recentlyChanged:${source}`;
      const recentlyChangedPoolsData = await this.redis.get(recentlyChangedKey);

      if (recentlyChangedPoolsData) {
        const recentlyChangedPools =
          typeof recentlyChangedPoolsData === "string"
            ? JSON.parse(recentlyChangedPoolsData)
            : recentlyChangedPoolsData;

        // Fetch these pools
        for (const poolAddress of recentlyChangedPools) {
          // For simplicity, just check in the first chunk
          const pool = firstChunk.find((p: Pool) => p.address === poolAddress);
          if (pool) {
            existingPoolMap.set(pool.address, pool);
          }
        }
      }

      // OPTIMIZATION: Check for significant changes
      let changesFound = 0;
      let significantChanges = 0;
      const recentlyChanged: string[] = [];

      for (const newPool of newPools) {
        if (!newPool || !newPool.address) continue;

        const existingPool = existingPoolMap.get(newPool.address);
        if (!existingPool) continue;

        if (newPool.reserves && existingPool.reserves) {
          if (newPool.reserves.join(",") !== existingPool.reserves.join(",")) {
            changesFound++;
            recentlyChanged.push(newPool.address);

            // OPTIMIZATION: Calculate percent change to detect significant changes
            try {
              const reserve0New = parseFloat(newPool.reserves[0]);
              const reserve0Old = parseFloat(existingPool.reserves[0]);
              const reserve1New = parseFloat(newPool.reserves[1]);
              const reserve1Old = parseFloat(existingPool.reserves[1]);

              // Calculate percent changes
              const change0 = Math.abs(
                (reserve0New - reserve0Old) / reserve0Old
              );
              const change1 = Math.abs(
                (reserve1New - reserve1Old) / reserve1Old
              );

              // If change is significant (>1%), count it
              if (change0 > 0.01 || change1 > 0.01) {
                significantChanges++;

                // Update volatility tracking for this pool
                this.updatePoolVolatility(newPool, existingPool);

                console.log(
                  `Significant reserve change for pool ${newPool.address}: [${
                    existingPool.reserves
                  }] -> [${newPool.reserves}], change: ${(
                    Math.max(change0, change1) * 100
                  ).toFixed(2)}%`
                );
              }
            } catch (error) {
              // Ignore calculation errors and continue
            }

            // If we find enough changes, update immediately
            if (changesFound >= 3 || significantChanges >= 1) {
              break;
            }
          }
        }
      }

      // OPTIMIZATION: Store the recently changed pools with pipeline
      if (recentlyChanged.length > 0) {
        await this.redis.set(
          recentlyChangedKey,
          JSON.stringify(recentlyChanged),
          { ex: 300 } // 5 minute expiry
        );
      }

      // Update if any significant changes found or enough minor changes
      return significantChanges > 0 || changesFound > 5;
    } catch (error) {
      console.error(`Error checking if data changed for ${source}:`, error);
      // If error occurred, assume data changed to be safe
      return true;
    }
  }

  private async isUpdateInProgress(type: string): Promise<boolean> {
    try {
      const flagKey = `update:${type}:inProgress`;
      const flag = await this.redis.get(flagKey);

      if (flag === "true") {
        // Check if the flag is stale (older than 5 minutes)
        const startTimeKey = `update:${type}:startTime`;
        const startTimeStr = await this.redis.get(startTimeKey);
        let startTime = 0;
        if (startTimeStr !== null) {
          if (typeof startTimeStr === "string") {
            startTime = parseInt(startTimeStr);
          } else if (typeof startTimeStr === "number") {
            startTime = startTimeStr;
          }
        }
        const now = Date.now();

        // If the update has been running for more than 5 minutes, consider it stale
        if (now - startTime > 300000) {
          console.log(
            `Force resetting stuck ${type} update flag after 5 minutes`
          );

          // OPTIMIZATION: Use pipeline for related operations
          const pipeline = this.redis.pipeline();
          pipeline.del(flagKey);
          pipeline.del(startTimeKey);
          await pipeline.exec();

          return false;
        }
        return true;
      }
      return false;
    } catch (error) {
      console.error(`Error checking ${type} update status:`, error);
      return false;
    }
  }

  private async setUpdateInProgress(
    type: string,
    inProgress: boolean
  ): Promise<void> {
    try {
      const flagKey = `update:${type}:inProgress`;
      const startTimeKey = `update:${type}:startTime`;

      // OPTIMIZATION: Use pipeline for atomic operations
      const pipeline = this.redis.pipeline();

      if (inProgress) {
        // Set flag with 10 minute expiry as a safeguard
        pipeline.set(flagKey, "true", { ex: 600 });
        pipeline.set(startTimeKey, Date.now().toString(), { ex: 600 });
      } else {
        // Clear the flags
        pipeline.del(flagKey);
        pipeline.del(startTimeKey);
      }

      await pipeline.exec();
    } catch (error) {
      console.error(`Error setting ${type} update status:`, error);
    }
  }

  // OPTIMIZATION: Enhanced pool storage with chunking and compression
  private async storePoolsInChunks(
    source: string,
    pools: Pool[]
  ): Promise<void> {
    try {
      // OPTIMIZATION: First check if data has actually changed
      const hasChanged = await this.hasDataChanged(source, pools);

      if (!hasChanged) {
        // Data hasn't changed, just update in-memory cache and return
        this.redisCacheData.set(source, pools);
        return;
      }

      // OPTIMIZATION: Determine optimal chunk size based on source
      const chunkSize = this.getChunkSize(source, pools);

      // OPTIMIZATION: Sort pools by importance before chunking
      // This ensures important pools are in the first chunks for faster access
      const sortedPools = [...pools].sort((a, b) => {
        // Prioritize by volume if available
        if (a.stats?.volume && b.stats?.volume) {
          const aVolume = a.stats.volume.reduce(
            (sum, vol) => sum + (parseFloat(vol) || 0),
            0
          );
          const bVolume = b.stats.volume.reduce(
            (sum, vol) => sum + (parseFloat(vol) || 0),
            0
          );
          return bVolume - aVolume; // Higher volume first
        }
        return 0;
      });

      // Create chunks with optimal size
      const chunks: Pool[][] = [];
      for (let i = 0; i < sortedPools.length; i += chunkSize) {
        chunks.push(sortedPools.slice(i, i + chunkSize));
      }

      console.log(
        `Storing ${pools.length} pools in ${chunks.length} chunks for ${source} (chunk size: ${chunkSize})`
      );

      // OPTIMIZATION: Use pipelining for metadata and first chunk
      const metadataPipeline = this.redis.pipeline();

      // Store metadata about chunks
      const metadataKey = `pools:meta:${source}`;
      metadataPipeline.set(
        metadataKey,
        JSON.stringify({
          totalPools: pools.length,
          chunks: chunks.length,
          lastUpdate: Date.now(),
        }),
        { ex: 3600 }
      );

      // Store first chunk directly in pipeline (most important pools)
      if (chunks.length > 0) {
        const firstChunkKey = `${this.CHUNK_KEY_PREFIX}${source}:0`;
        metadataPipeline.set(firstChunkKey, JSON.stringify(chunks[0]), {
          ex: 3600,
        });
      }

      // Update last update timestamp
      metadataPipeline.set(`lastUpdate:${source}`, Date.now(), { ex: 3600 });

      // Execute metadata pipeline first
      await metadataPipeline.exec();

      // OPTIMIZATION: Store remaining chunks in batches to avoid overwhelming Redis
      const BATCH_SIZE = 5; // Store 5 chunks at a time
      for (let i = 1; i < chunks.length; i += BATCH_SIZE) {
        const batchPipeline = this.redis.pipeline();

        // Add chunk storage commands to pipeline
        for (let j = 0; j < BATCH_SIZE && i + j < chunks.length; j++) {
          const chunkIndex = i + j;
          const chunkKey = `${this.CHUNK_KEY_PREFIX}${source}:${chunkIndex}`;

          // OPTIMIZATION: Apply compression for large chunks
          const chunk = chunks[chunkIndex];
          const jsonData = JSON.stringify(chunk);

          if (jsonData.length > 500000) {
            // For very large chunks, store minimal version
            const compressedChunk = chunk.map((pool) => ({
              address: pool.address,
              reserves: pool.reserves,
              assets: pool.assets.map((asset) => ({
                type: asset.type,
                address: asset.address,
                metadata: {
                  decimals: asset.metadata.decimals,
                  symbol: asset.metadata.symbol,
                },
              })),
              tradeFee: pool.tradeFee,
              source: pool.source,
              lastUpdateTimestamp: pool.lastUpdateTimestamp,
            }));

            batchPipeline.set(chunkKey, JSON.stringify(compressedChunk), {
              ex: 3600,
            });
          } else {
            // Normal storage for regular chunks
            batchPipeline.set(chunkKey, jsonData, { ex: 3600 });
          }
        }

        // Execute batch pipeline
        await batchPipeline.exec();
      }

      // Also update our in-memory cache
      this.redisCacheData.set(source, pools);

      // OPTIMIZATION: Update hot pools cache in the background
      this.updateHotPoolsCache().catch((err) =>
        console.error("Error updating hot pools cache:", err)
      );

      console.log(
        `Successfully stored ${pools.length} pools in ${chunks.length} chunks for ${source}`
      );
    } catch (error) {
      console.error(`Error storing chunked pools for ${source}:`, error);
      throw error;
    }
  }

  public async performMemoryOnlyUpdate(): Promise<void> {
    try {
      const now = Date.now();
      console.log(
        `[Memory-Only] Starting update at ${new Date(now).toISOString()}`
      );

      // Track if any significant changes are detected
      let significantChangesDetected = false;
      const changedPoolAddresses: string[] = [];
      const changedTokens = new Set<string>();

      // Helper to ensure pool objects have all required properties
      const ensureCompletePool = (pool: any): Pool => {
        return {
          ...pool,
          lt: pool.lt || "0",
          totalSupply: pool.totalSupply || "0",
          lastPrice: pool.lastPrice || { value: "0" },
          stats: pool.stats || { fees: ["0", "0"], volume: ["0", "0"] },
        };
      };

      // Use shorter timeouts for faster response (2 seconds instead of normal 10)
      const dedustPromise = Promise.race([
        this.dedustClient.getPools().catch((err) => {
          console.error("[Memory-Only] Error fetching DeDust pools:", err);
          return [];
        }),
        new Promise((resolve) =>
          setTimeout(() => {
            console.log("[Memory-Only] DeDust API timeout");
            resolve([]);
          }, 2000)
        ),
      ]);

      const stonfiPromise = Promise.race([
        this.stonfiClient.getPools().catch((err) => {
          console.error("[Memory-Only] Error fetching StonFi pools:", err);
          return [];
        }),
        new Promise((resolve) =>
          setTimeout(() => {
            console.log("[Memory-Only] StonFi API timeout");
            resolve([]);
          }, 2000)
        ),
      ]);

      // Wait for both API calls in parallel
      const [dedustPools, stonfiResponse] = await Promise.all([
        dedustPromise,
        stonfiPromise,
      ]);

      // Process DeDust pools
      if (Array.isArray(dedustPools) && dedustPools.length > 0) {
        // Get current in-memory pools
        const currentPools = this.redisCacheData.get("dedust") || [];
        const poolMap = new Map<string, Pool>();

        // Create lookup map
        for (const pool of currentPools) {
          poolMap.set(pool.address, pool);
        }

        // Tagged new pools
        const taggedDedustPools = (dedustPools as DeDustPool[]).map((pool) => ({
          ...pool,
          source: "dedust",
          lastUpdateTimestamp: now,
        }));

        // Check for changes and update memory cache
        let changesCount = 0;
        let significantChanges = 0;

        for (const newPool of taggedDedustPools) {
          const existingPool = poolMap.get(newPool.address);

          if (existingPool) {
            // Check for reserve changes
            if (
              newPool.reserves &&
              existingPool.reserves &&
              newPool.reserves.join(",") !== existingPool.reserves.join(",")
            ) {
              changesCount++;
              changedPoolAddresses.push(newPool.address);

              // Track tokens in this pool for targeted path invalidation
              if (newPool.assets && newPool.assets.length > 0) {
                newPool.assets.forEach((asset) => {
                  const tokenId = asset.address || asset.type;
                  if (tokenId) changedTokens.add(tokenId);
                });
              }

              // Calculate percent change
              try {
                const reserve0Old = parseFloat(existingPool.reserves[0]);
                const reserve0New = parseFloat(newPool.reserves[0]);
                const reserve1Old = parseFloat(existingPool.reserves[1]);
                const reserve1New = parseFloat(newPool.reserves[1]);

                const pctChange0 = Math.abs(
                  (reserve0New - reserve0Old) / reserve0Old
                );
                const pctChange1 = Math.abs(
                  (reserve1New - reserve1Old) / reserve1Old
                );
                const maxChange = Math.max(pctChange0, pctChange1);

                // If significant change (>1%), count it
                if (maxChange > 0.01) {
                  significantChanges++;

                  // Update volatility tracking for this pool
                  this.updatePoolVolatility(
                    ensureCompletePool(newPool),
                    ensureCompletePool(existingPool)
                  );
                }
              } catch (error) {
                // Ignore calculation errors
              }
            }

            // Update in-memory pool (merge existing metadata with new data)
            poolMap.set(newPool.address, {
              ...existingPool, // Keep existing fields
              ...newPool, // Apply updates
              assets: newPool.assets || existingPool.assets,
              reserves: newPool.reserves || existingPool.reserves,
              stats: newPool.stats || existingPool.stats,
              lastUpdateTimestamp: now,
            });
          } else {
            // For new pools, make sure we have all required Pool properties
            poolMap.set(newPool.address, {
              ...newPool,
              lastUpdateTimestamp: now,
              // Add missing required properties
              lt: newPool.lt || "0",
              totalSupply: newPool.totalSupply || "0",
              lastPrice: newPool.lastPrice || { value: "0" },
              stats: newPool.stats || { fees: ["0", "0"], volume: ["0", "0"] },
            });
            changesCount++;

            // Track tokens in new pool too
            if (newPool.assets && newPool.assets.length > 0) {
              newPool.assets.forEach((asset) => {
                const tokenId = asset.address || asset.type;
                if (tokenId) changedTokens.add(tokenId);
              });
            }
          }
        }

        // Update in-memory cache with new data
        this.redisCacheData.set("dedust", Array.from(poolMap.values()));

        if (changesCount > 0) {
          console.log(
            `[Memory-Only] Updated DeDust in-memory cache: ${changesCount} changes, ${significantChanges} significant`
          );
        }

        // Flag for Redis update if we have significant changes
        if (significantChanges >= 3) {
          significantChangesDetected = true;
        }
      }

      // Process StonFi pools
      if (Array.isArray(stonfiResponse) && stonfiResponse.length > 0) {
        // Get current in-memory pools
        const currentPools = this.redisCacheData.get("stonfi") || [];
        const poolMap = new Map<string, Pool>();

        // Create lookup map
        for (const pool of currentPools) {
          poolMap.set(pool.address, pool);
        }

        // Process non-deprecated pools with all required Pool properties
        const stonfiPools = stonfiResponse
          .filter((pool) => !pool.deprecated)
          .map((pool) => {
            // Get existing pool for this address if any
            const existingPool = poolMap.get(pool.address);

            return {
              address: pool.address,
              reserves: [pool.reserve0, pool.reserve1],
              source: "stonfi",
              lastUpdateTimestamp: now,
              // Use existing asset data if available, otherwise provide empty array
              assets: existingPool?.assets || [],
              // Include all required properties
              tradeFee: pool.lpFee || existingPool?.tradeFee || "0",
              type: "stonfi",
              lt: existingPool?.lt || "0",
              totalSupply:
                pool.lpTotalSupply || existingPool?.totalSupply || "0",
              lastPrice: existingPool?.lastPrice || { value: "0" },
              stats: existingPool?.stats || {
                fees: [
                  pool.collectedToken0ProtocolFee || "0",
                  pool.collectedToken1ProtocolFee || "0",
                ],
                volume: [pool.token0Balance || "0", pool.token1Balance || "0"],
              },
            } as Pool;
          });

        // Check for changes and update memory cache
        let changesCount = 0;
        let significantChanges = 0;

        for (const newPool of stonfiPools) {
          const existingPool = poolMap.get(newPool.address);

          if (existingPool) {
            // Check for reserve changes
            if (
              newPool.reserves &&
              existingPool.reserves &&
              newPool.reserves.join(",") !== existingPool.reserves.join(",")
            ) {
              changesCount++;
              changedPoolAddresses.push(newPool.address);

              // Track tokens in this pool for targeted path invalidation
              if (existingPool.assets && existingPool.assets.length > 0) {
                existingPool.assets.forEach((asset) => {
                  const tokenId = asset.address || asset.type;
                  if (tokenId) changedTokens.add(tokenId);
                });
              }

              // Calculate percent change
              try {
                const reserve0Old = parseFloat(existingPool.reserves[0]);
                const reserve0New = parseFloat(newPool.reserves[0]);
                const reserve1Old = parseFloat(existingPool.reserves[1]);
                const reserve1New = parseFloat(newPool.reserves[1]);

                const pctChange0 = Math.abs(
                  (reserve0New - reserve0Old) / reserve0Old
                );
                const pctChange1 = Math.abs(
                  (reserve1New - reserve1Old) / reserve1Old
                );
                const maxChange = Math.max(pctChange0, pctChange1);

                // If significant change (>1%), count it
                if (maxChange > 0.01) {
                  significantChanges++;

                  // Update volatility tracking for this pool
                  this.updatePoolVolatility(
                    ensureCompletePool(newPool),
                    ensureCompletePool(existingPool)
                  );
                }
              } catch (error) {
                // Ignore calculation errors
              }
            }

            // Update in-memory pool (merge existing metadata with new data)
            poolMap.set(newPool.address, {
              ...existingPool, // Keep existing fields
              ...newPool, // Apply updates
              reserves: newPool.reserves, // Update reserves
              lastUpdateTimestamp: now,
            });
          } else {
            // For new pools, all properties should already be set
            poolMap.set(newPool.address, newPool);
            changesCount++;

            // Will need a real update to get full metadata
            significantChangesDetected = true;
          }
        }

        // Update in-memory cache with new data
        this.redisCacheData.set("stonfi", Array.from(poolMap.values()));

        if (changesCount > 0) {
          console.log(
            `[Memory-Only] Updated StonFi in-memory cache: ${changesCount} changes, ${significantChanges} significant`
          );
        }

        // Flag for Redis update if we have significant changes
        if (significantChanges >= 3) {
          significantChangesDetected = true;
        }
      }

      // Update hot pools cache with memory-only updates
      this.updateHotPoolsCache().catch((err) =>
        console.error("[Memory-Only] Error updating hot pools cache:", err)
      );

      // Invalidate memory path cache for changed tokens
      if (changedTokens.size > 0) {
        this.invalidateMemoryPathsForTokens(changedTokens);
      }

      // If significant changes detected, trigger a Redis update
      if (significantChangesDetected) {
        console.log(
          "[Memory-Only] Significant changes detected, triggering Redis update"
        );

        // Store last memory update time
        await this.redis.set("lastMemoryUpdate", now, { ex: 60 });

        // Trigger Redis update in background (don't await)
        this.performFastUpdate().catch((err) =>
          console.error("[Memory-Only] Error triggering Redis update:", err)
        );
      } else {
        // Still update the timestamp even if no Redis update needed
        await this.redis.set("lastMemoryUpdate", now, { ex: 60 });
      }

      const updateDuration = Date.now() - now;
      console.log(`[Memory-Only] Update completed in ${updateDuration}ms`);
    } catch (error) {
      console.error("[Memory-Only] Update error:", error);
    }
  }

  private invalidateMemoryPathsForTokens(tokens: Set<string>): void {
    try {
      const invalidatedKeys: string[] = [];

      // Check each path in memory cache
      for (const [key, _] of this.pathCache) {
        // Parse key format: "fromAddress-toAddress-amount"
        const parts = key.split("-");
        if (parts.length >= 2) {
          const fromAddress = parts[0];
          const toAddress = parts[1];

          // If path involves any of the changed tokens, invalidate it
          if (tokens.has(fromAddress) || tokens.has(toAddress)) {
            this.pathCache.delete(key);
            this.pathCacheExpiry.delete(key);
            invalidatedKeys.push(key);
          }
        }
      }

      if (invalidatedKeys.length > 0) {
        console.log(
          `[Memory-Only] Invalidated ${invalidatedKeys.length} paths in memory cache`
        );
      }
    } catch (error) {
      console.error("[Memory-Only] Error invalidating memory paths:", error);
    }
  }

  // OPTIMIZATION: Enhanced pool retrieval with hot cache prioritization
  public async getPoolsFromChunks(source: string): Promise<Pool[]> {
    try {
      // Check if we have it in memory cache first
      if (this.redisCacheData.has(source)) {
        const cachedPools = this.redisCacheData.get(source)!;
        if (cachedPools.length > 0) {
          return cachedPools;
        }
      }

      // OPTIMIZATION: Check hot pools cache first for important pools
      const hotPools: Pool[] = [];
      for (const [_, pool] of this.hotPoolsCache.entries()) {
        if (pool.source === source) {
          hotPools.push(pool);
        }
      }

      // If we have a significant number of hot pools, return them immediately
      if (hotPools.length >= 50) {
        console.log(
          `Returning ${hotPools.length} hot pools for ${source} from memory cache`
        );
        return hotPools;
      }

      // Retrieve chunks from Redis
      const metadataKey = `pools:meta:${source}`;
      const metadataJson = await this.redis.get(metadataKey);

      if (!metadataJson) {
        return hotPools.length > 0 ? hotPools : [];
      }

      // Parse metadata
      const metadata =
        typeof metadataJson === "string"
          ? JSON.parse(metadataJson)
          : metadataJson;

      if (!metadata || !metadata.chunks) {
        return hotPools.length > 0 ? hotPools : [];
      }

      const numChunks = metadata.chunks;

      // OPTIMIZATION: For large datasets, load first chunk immediately
      // and load remaining chunks in the background

      // Get first chunk immediately (contains most important pools)
      const firstChunkKey = `${this.CHUNK_KEY_PREFIX}${source}:0`;
      const firstChunkData = await this.redis.get(firstChunkKey);

      let firstChunk: Pool[] = [];
      if (firstChunkData) {
        firstChunk =
          typeof firstChunkData === "string"
            ? JSON.parse(firstChunkData)
            : firstChunkData;
      }

      // If we have a good number of pools from first chunk and hot cache,
      // kick off background load and return what we have
      if (firstChunk.length + hotPools.length >= 100 && numChunks > 3) {
        const combinedPools = [...hotPools];

        // Add pools from first chunk that aren't already in hot cache
        const hotPoolAddresses = new Set(hotPools.map((p) => p.address));
        for (const pool of firstChunk) {
          if (!hotPoolAddresses.has(pool.address)) {
            combinedPools.push(pool);
          }
        }

        // Start background loading of remaining chunks
        this.loadRemainingChunksInBackground(source, numChunks, combinedPools);

        console.log(
          `Returning ${combinedPools.length} pools for ${source} from hot cache and first chunk`
        );
        return combinedPools;
      }

      // For smaller datasets or if we need all data, load all chunks
      // Create pipeline for parallel chunk retrieval
      const chunkKeys = [];
      for (let i = 0; i < numChunks; i++) {
        chunkKeys.push(`${this.CHUNK_KEY_PREFIX}${source}:${i}`);
      }

      // OPTIMIZATION: Use mget for faster multi-key retrieval
      const chunkResults = await this.redis.mget(...chunkKeys);

      // Combine chunks
      const allPools: Pool[] = [...hotPools]; // Start with hot pools
      const seenAddresses = new Set(hotPools.map((p) => p.address));

      for (const chunkData of chunkResults) {
        if (chunkData) {
          const chunk =
            typeof chunkData === "string" ? JSON.parse(chunkData) : chunkData;

          // Add pools that aren't in hot cache
          for (const pool of chunk) {
            if (!seenAddresses.has(pool.address)) {
              allPools.push(pool);
              seenAddresses.add(pool.address);
            }
          }
        }
      }

      // Update memory cache
      this.redisCacheData.set(source, allPools);

      return allPools;
    } catch (error) {
      console.error(`Error getting pools from chunks for ${source}:`, error);

      // Return what we have in hot cache if anything
      const hotPools: Pool[] = [];
      for (const [_, pool] of this.hotPoolsCache.entries()) {
        if (pool.source === source) {
          hotPools.push(pool);
        }
      }

      return hotPools.length > 0 ? hotPools : [];
    }
  }

  // OPTIMIZATION: Background loading of remaining chunks
  private async loadRemainingChunksInBackground(
    source: string,
    numChunks: number,
    initialPools: Pool[]
  ): Promise<void> {
    try {
      // Skip first chunk which was already loaded
      const chunkPromises = [];
      for (let i = 1; i < numChunks; i++) {
        const chunkKey = `${this.CHUNK_KEY_PREFIX}${source}:${i}`;
        chunkPromises.push(this.redis.get(chunkKey));
      }

      const chunkResults = await Promise.all(chunkPromises);

      // Process chunks and update memory cache
      const allPools = [...initialPools];
      const seenAddresses = new Set(initialPools.map((p) => p.address));

      for (const chunkData of chunkResults) {
        if (chunkData) {
          const chunk =
            typeof chunkData === "string" ? JSON.parse(chunkData) : chunkData;

          // Add pools that weren't in initial pools
          for (const pool of chunk) {
            if (!seenAddresses.has(pool.address)) {
              allPools.push(pool);
              seenAddresses.add(pool.address);
            }
          }
        }
      }

      // Update in-memory cache with complete data
      this.redisCacheData.set(source, allPools);
      console.log(
        `Background loaded complete set of ${allPools.length} pools for ${source}`
      );

      // Update hot pools cache
      this.updateHotPoolsCache().catch((err) =>
        console.error("Error updating hot pools cache:", err)
      );
    } catch (error) {
      console.error(`Error loading remaining chunks for ${source}:`, error);
      // Non-fatal error, just log it
    }
  }

  async addPool(pool: Pool): Promise<void> {
    try {
      const address = Address.parse(pool.address);
      this.poolAddresses.add(address.toString());

      // Get initial state
      const state = await this.fetchPoolState(pool);
      if (state) {
        // Store in Redis
        await this.updateBulkPoolStates([state]);
      }
    } catch (error) {
      console.error(`Error adding pool ${pool.address}:`, error);
    }
  }

  private async fetchPoolState(pool: Pool): Promise<Pool | null> {
    try {
      // Initially just store the pool data without TON client calls
      return {
        ...pool,
        lastUpdateTimestamp: Date.now(),
      };
    } catch (error) {
      console.error(`Error storing pool ${pool.address}:`, error);
      return null;
    }
  }

  // OPTIMIZATION: Enhanced bulk state update with volatility tracking
  public async updateBulkPoolStates(pools: Pool[]): Promise<void> {
    if (pools.length === 0) return;

    // Track if any reserves have changed to invalidate path cache
    let reservesChanged = false;
    const changedTokens = new Set<string>();
    const volatileTokens = new Set<string>();

    // Update Redis cache first (this is fast)
    try {
      // Group pools by source
      const poolsBySource = new Map<string, Pool[]>();
      for (const pool of pools) {
        if (pool.source) {
          if (!poolsBySource.has(pool.source)) {
            poolsBySource.set(pool.source, []);
          }
          poolsBySource.get(pool.source)!.push(pool);
        }
      }

      // Update Redis cache for each source
      for (const [source, sourcePools] of poolsBySource.entries()) {
        try {
          // Get current pools from chunks
          const currentPools = await this.getPoolsFromChunks(source);

          // Create map for fast lookup of existing pools
          const poolMap = new Map<string, Pool>();
          for (const pool of currentPools) {
            poolMap.set(pool.address, pool);
          }

          // OPTIMIZATION: Track significant changes for volatility metrics
          let significantChangesCount = 0;
          const significantlyChangedPools: string[] = [];

          // Update existing or add new pools
          for (const pool of sourcePools) {
            // Get existing pool first
            const existingPool = poolMap.get(pool.address);

            if (existingPool) {
              // Check if reserves have changed
              if (pool.reserves && existingPool.reserves) {
                if (
                  pool.reserves.join(",") !== existingPool.reserves.join(",")
                ) {
                  reservesChanged = true;

                  // Track tokens in this pool for targeted path invalidation
                  if (pool.assets && pool.assets.length > 0) {
                    pool.assets.forEach((asset) => {
                      const tokenId = asset.address || asset.type;
                      if (tokenId) changedTokens.add(tokenId);
                    });
                  }

                  // OPTIMIZATION: Calculate percent change to detect volatility
                  try {
                    const reserve0New = parseFloat(pool.reserves[0]);
                    const reserve0Old = parseFloat(existingPool.reserves[0]);
                    const reserve1New = parseFloat(pool.reserves[1]);
                    const reserve1Old = parseFloat(existingPool.reserves[1]);

                    // Calculate percent changes
                    const change0 = Math.abs(
                      (reserve0New - reserve0Old) / reserve0Old
                    );
                    const change1 = Math.abs(
                      (reserve1New - reserve1Old) / reserve1Old
                    );

                    // If change is significant (>1%), track it
                    if (change0 > 0.01 || change1 > 0.01) {
                      significantChangesCount++;
                      significantlyChangedPools.push(pool.address);

                      // Update volatility tracking for this pool
                      this.updatePoolVolatility(pool, existingPool);

                      // Track tokens in volatile pools
                      if (change0 > 0.05 || change1 > 0.05) {
                        pool.assets.forEach((asset) => {
                          const tokenId = asset.address || asset.type;
                          if (tokenId) volatileTokens.add(tokenId);
                        });
                      }
                    }
                  } catch (error) {
                    // Ignore calculation errors and continue
                  }
                }
              }

              // Merge the update with existing data
              poolMap.set(pool.address, {
                ...existingPool, // Keep all existing fields
                ...pool, // Apply updates
                assets: pool.assets || existingPool.assets, // Ensure assets are preserved
                reserves: pool.reserves || existingPool.reserves, // Ensure reserves are preserved
                stats: pool.stats || existingPool.stats, // Ensure stats are preserved
                lastUpdateTimestamp: Date.now(),
              });
            } else {
              // For new pools, add them directly
              poolMap.set(pool.address, {
                ...pool,
                lastUpdateTimestamp: Date.now(),
              });
              // New pool should also invalidate path cache
              reservesChanged = true;

              // Track tokens in new pools too
              if (pool.assets && pool.assets.length > 0) {
                pool.assets.forEach((asset) => {
                  const tokenId = asset.address || asset.type;
                  if (tokenId) changedTokens.add(tokenId);
                });
              }
            }
          }

          // OPTIMIZATION: Store list of significantly changed pools for future prioritization
          if (significantlyChangedPools.length > 0) {
            await this.redis.set(
              `significantChanges:${source}`,
              JSON.stringify(significantlyChangedPools),
              { ex: 300 } // 5 minute expiry
            );

            console.log(
              `Tracked ${significantlyChangedPools.length} significantly changed pools for ${source}`
            );
          }

          // Convert back to array
          const updatedPools = Array.from(poolMap.values());

          // Store in Redis using chunks
          await this.storePoolsInChunks(source, updatedPools);

          // OPTIMIZATION: Update hot pools cache if we have significant changes
          if (significantChangesCount > 0) {
            this.updateHotPoolsCache().catch((err) =>
              console.error("Error updating hot pools cache:", err)
            );
          }
        } catch (error) {
          console.error(`Error updating Redis cache for ${source}:`, error);
        }
      }

      // Emit events immediately for updates
      pools.forEach((pool) => this.emit("poolStateUpdated", pool));

      // OPTIMIZATION: Smarter path cache invalidation
      if (reservesChanged) {
        // Track volatile tokens for future reference
        if (volatileTokens.size > 0) {
          await this.redis.set(
            "volatileTokens",
            JSON.stringify({
              tokens: Array.from(volatileTokens),
              timestamp: Date.now(),
            }),
            { ex: 300 } // 5 minute expiry
          );
        }

        // Smart invalidation of path cache
        if (changedTokens.size <= 5) {
          // If only a few tokens changed, do targeted invalidation
          const invalidationPromises = Array.from(changedTokens).map(
            (tokenId) => this.invalidatePathsForToken(tokenId)
          );
          await Promise.all(invalidationPromises);
        } else {
          // If many tokens changed, clear the entire cache
          this.clearPathCache();
        }
      }

      return;
    } catch (error) {
      console.error("Redis update error:", error);
    }
  }

  // Other methods remain largely unchanged...

  public async clearPathCache(): Promise<void> {
    try {
      // Use SCAN to delete path cache entries
      let cursor = "0";
      let totalDeleted = 0;

      // OPTIMIZATION: Use pipeline for batch deletions
      do {
        // SCAN with a reasonable batch size
        const scanResult = await this.redis.scan(cursor, {
          match: "path:*",
          count: 100,
        });

        // Extract the new cursor and matching keys
        if (Array.isArray(scanResult) && scanResult.length >= 1) {
          cursor = scanResult[0].toString();
          const keys = scanResult[1] || [];

          // Delete keys in batches if any were found
          if (keys.length > 0) {
            const pipeline = this.redis.pipeline();
            for (const key of keys) {
              pipeline.del(key);
            }
            await pipeline.exec();
            totalDeleted += keys.length;
          }
        } else {
          // Handle unexpected response format
          console.warn("Unexpected SCAN response format:", scanResult);
          break;
        }
      } while (cursor !== "0");

      console.log(`Cleared ${totalDeleted} path cache entries from Redis`);

      // Also clear memory cache
      this.pathCache.clear();
      this.pathCacheExpiry.clear();

      // Set a flag indicating path cache was recently cleared
      await this.redis.set("pathCacheLastCleared", Date.now().toString(), {
        ex: 60, // 1 minute expiry
      });
    } catch (error) {
      console.error("Error clearing Redis path cache:", error);

      // On error, at least clear memory cache
      this.pathCache.clear();
      this.pathCacheExpiry.clear();
    }
  }

  // OPTIMIZATION: Enhanced token-specific path invalidation
  public async invalidatePathsForToken(tokenAddress: string): Promise<void> {
    try {
      // We'll use a more efficient approach with multiple targeted scans
      const keysToDelete: string[] = [];
      let totalScanned = 0;

      // Patterns to check
      const patterns = [
        `path:${tokenAddress}-*`, // Token as source
        `path:*-${tokenAddress}-*`, // Token as destination or amount
      ];

      // Run all scans in parallel for speed
      const scanPromises = patterns.map(async (pattern) => {
        let cursor = "0";
        const matchingKeys: string[] = [];

        do {
          const scanResult = await this.redis.scan(cursor, {
            match: pattern,
            count: 100,
          });

          if (Array.isArray(scanResult) && scanResult.length >= 1) {
            cursor = scanResult[0].toString();
            const keys = scanResult[1] || [];
            matchingKeys.push(...keys);
            totalScanned += keys.length;
          } else {
            break;
          }
        } while (cursor !== "0");

        return matchingKeys;
      });

      // Combine results from all scans
      const scanResults = await Promise.all(scanPromises);
      for (const keys of scanResults) {
        keysToDelete.push(...keys);
      }

      // Deduplicate keys (might be overlap between patterns)
      const uniqueKeys = [...new Set(keysToDelete)];

      // Delete in batches of 100 using pipeline for efficiency
      if (uniqueKeys.length > 0) {
        for (let i = 0; i < uniqueKeys.length; i += 100) {
          const batch = uniqueKeys.slice(i, i + 100);
          const pipeline = this.redis.pipeline();

          for (const key of batch) {
            pipeline.del(key);

            // Also remove from memory cache if present
            const memoryCacheKey = key.replace("path:", "");
            this.pathCache.delete(memoryCacheKey);
            this.pathCacheExpiry.delete(memoryCacheKey);
          }

          await pipeline.exec();
        }

        console.log(
          `Invalidated ${uniqueKeys.length} paths for token ${tokenAddress} (scanned ${totalScanned} keys)`
        );
      }
    } catch (error) {
      console.error(
        `Error invalidating paths for token ${tokenAddress}:`,
        error
      );
    }
  }

  // Add these methods to the PoolTracker class

  // Method to get all pools from all sources
  public async getAllPools(): Promise<Pool[]> {
    let dedustPools = await this.getPoolsFromChunks("dedust");
    let stonfiPools = await this.getPoolsFromChunks("stonfi");

    // If either source has no pools, try to fetch them
    if (dedustPools.length === 0 || stonfiPools.length === 0) {
      console.log("Some pool sources empty, fetching from APIs...");
      try {
        await this.performFastUpdate();

        // Refresh from Redis after update
        if (dedustPools.length === 0) {
          dedustPools = await this.getPoolsFromChunks("dedust");
        }

        if (stonfiPools.length === 0) {
          stonfiPools = await this.getPoolsFromChunks("stonfi");
        }
      } catch (error) {
        console.error("Error fetching pools from APIs:", error);
      }
    }

    return [...dedustPools, ...stonfiPools];
  }

  // Start the pool tracking process
  async startTracking(): Promise<void> {
    // If already tracking, return immediately
    if (this.isTracking) {
      console.log("Already tracking, skipping additional start request");
      return;
    }

    this.isTracking = true;

    // Define fast update function for real-time data with debounce logic
    const performFastUpdate = async () => {
      // Skip if update already in progress
      if (await this.isUpdateInProgress("fast")) {
        console.log("Fast update already in progress, skipping");
        return;
      }

      try {
        await this.setUpdateInProgress("fast", true);

        // Check if we recently updated (avoid multiple simultaneous updates)
        const lastUpdateData = await this.redis.get("fastUpdateTimestamp");
        const now = Date.now();

        if (lastUpdateData) {
          const lastUpdate =
            typeof lastUpdateData === "string"
              ? parseInt(lastUpdateData)
              : typeof lastUpdateData === "number"
              ? lastUpdateData
              : 0;

          // Only update if 3 seconds have passed
          if (now - lastUpdate < this.FAST_UPDATE_INTERVAL) {
            console.log("Fast update too soon, skipping");
            return;
          }
        }

        // Mark update in progress
        await this.redis.set("fastUpdateTimestamp", now, { ex: 60 });

        // Track if any reserves have changed to invalidate path cache
        let reservesChanged = false;
        const changedPools = [];

        // Optimize API timeouts
        const dedustPromise = fetchWithRetry(
          async () => {
            return await this.dedustClient.getPools().catch((err) => {
              console.error("Error fetching DeDust pools:", err);
              return [];
            });
          },
          3,
          1000
        );

        const stonfiPromise = fetchWithRetry(
          async () => {
            return await this.stonfiClient.getPools().catch((err) => {
              console.error("Error fetching StonFi pools:", err);
              return [];
            });
          },
          3,
          1000
        );

        const [dedustPools, stonfiResponse] = await Promise.all([
          dedustPromise,
          stonfiPromise,
        ]);

        // Process DeDust pools with basic data needed for fast updates
        const taggedDedustPools = (dedustPools as DeDustPool[]).map((pool) => ({
          ...pool,
          source: "dedust",
          lastUpdateTimestamp: now,
        }));

        // Process StonFi pools with basic data needed for fast updates
        const stonfiPools: Pool[] = [];
        if (stonfiResponse && Array.isArray(stonfiResponse)) {
          stonfiPools.push(
            ...(stonfiResponse
              .filter((pool) => !pool.deprecated)
              .map((pool) => ({
                address: pool.address,
                reserves: [pool.reserve0, pool.reserve1],
                source: "stonfi",
                lastUpdateTimestamp: now,
              })) as unknown as Pool[])
          );
        }

        // Update Redis for each source
        const allApiPools: Record<string, Pool[]> = {
          dedust: taggedDedustPools as unknown as Pool[],
          stonfi: stonfiPools,
        };

        // Update Redis for each source
        for (const [source, sourcePools] of Object.entries(allApiPools)) {
          if (sourcePools && sourcePools.length > 0) {
            try {
              // Get existing Redis pools for this source
              const currentPools = await this.getPoolsFromChunks(source);

              // Create map for fast lookup of existing pools
              const poolMap = new Map<string, Pool>();
              for (const pool of currentPools) {
                poolMap.set(pool.address, pool);
              }

              let updatedCount = 0;
              let addedCount = 0;

              // Update existing or add new pools
              for (const pool of sourcePools) {
                // Get existing pool first
                const existingPool = poolMap.get(pool.address);

                if (existingPool) {
                  // Check if reserves have changed - IMPORTANT
                  if (pool.reserves && existingPool.reserves) {
                    if (
                      pool.reserves.join(",") !==
                      existingPool.reserves.join(",")
                    ) {
                      changedPools.push(pool.address);
                      reservesChanged = true;
                    }
                  }

                  // Merge the update with existing data to preserve metadata
                  poolMap.set(pool.address, {
                    ...existingPool, // Keep existing fields
                    ...pool, // Apply updates from API
                    // Ensure critical fields are preserved from existing data if not in API update
                    assets: pool.assets || existingPool.assets,
                    reserves: pool.reserves || existingPool.reserves,
                    stats: pool.stats || existingPool.stats,
                    lastUpdateTimestamp: now,
                  });
                  updatedCount++;
                } else {
                  // For new pools, add them directly
                  poolMap.set(pool.address, {
                    ...pool,
                    lastUpdateTimestamp: now,
                  });
                  addedCount++;
                  // New pools should also invalidate path cache
                  changedPools.push(pool.address);
                  reservesChanged = true;
                }
              }

              // Convert back to array and store in Redis using chunks
              const updatedPools = Array.from(poolMap.values());
              await this.storePoolsInChunks(source, updatedPools);

              // Only log this message if Redis was actually updated
              if (updatedCount > 0 || addedCount > 0) {
                console.log(
                  `Updated Redis cache for ${source}: ${updatedCount} updated, ${addedCount} added, total: ${updatedPools.length}`
                );
              }

              // Emit events for updates
              sourcePools.forEach((pool) =>
                this.emit("poolStateUpdated", pool)
              );
            } catch (error) {
              console.error(`Error updating ${source} pools in Redis:`, error);
            }
          } else {
            console.warn(
              `No ${source} pools received from API in this update cycle`
            );
          }
        }

        // Always clear path cache if reserves have changed
        if (reservesChanged) {
          await this.clearPathCache();

          // Update the lastUpdate timestamp for sources
          if (allApiPools.dedust && allApiPools.dedust.length > 0) {
            await this.redis.set("lastUpdate:dedust", now, { ex: 3600 });
            console.log(
              `Updated lastUpdate:dedust timestamp to ${new Date(
                now
              ).toISOString()}`
            );
          }

          if (allApiPools.stonfi && allApiPools.stonfi.length > 0) {
            await this.redis.set("lastUpdate:stonfi", now, { ex: 3600 });
            console.log(
              `Updated lastUpdate:stonfi timestamp to ${new Date(
                now
              ).toISOString()}`
            );
          }
        }
      } catch (error) {
        console.error("Fast update error:", error);
      } finally {
        // Reset update in progress flag
        await this.setUpdateInProgress("fast", false);
      }
    };

    // Function for full updates (complete metadata refresh)
    const performFullUpdate = async () => {
      // Skip if update already in progress
      if (await this.isUpdateInProgress("full")) {
        console.log("Full update already in progress, skipping");
        return;
      }

      try {
        await this.setUpdateInProgress("full", true);

        // Check if we recently did a full update (avoid multiple simultaneous updates)
        const lastFullUpdateData = await this.redis.get("fullUpdateTimestamp");
        const now = Date.now();

        if (lastFullUpdateData) {
          const lastUpdate =
            typeof lastFullUpdateData === "string"
              ? parseInt(lastFullUpdateData)
              : typeof lastFullUpdateData === "number"
              ? lastFullUpdateData
              : 0;

          // Only update if 60 seconds have passed
          if (now - lastUpdate < this.FULL_UPDATE_INTERVAL) {
            return;
          }
        }

        // Mark update in progress with timeout
        await this.redis.set("fullUpdateTimestamp", now, { ex: 120 });

        // Create promises for both API requests with timeouts
        const dedustPromise = Promise.race([
          this.dedustClient.getPools().catch((err) => {
            console.error("Error fetching DeDust pools for full update:", err);
            return [] as DeDustPool[]; // Return empty array on error
          }),
          new Promise(
            (resolve) =>
              setTimeout(() => {
                console.warn(
                  "DeDust API timeout during full update, using cached data"
                );
                resolve([]);
              }, 10000) // 10 second timeout
          ),
        ]);

        const stonfiPromise = Promise.race([
          this.stonfiClient.getPools().catch((err) => {
            console.error("Error fetching StonFi pools for full update:", err);
            return [] as StonFiPool[]; // Return empty array on error
          }),
          new Promise(
            (resolve) =>
              setTimeout(() => {
                console.warn(
                  "StonFi API timeout during full update, using cached data"
                );
                resolve([]);
              }, 10000) // 10 second timeout
          ),
        ]);

        // Wait for both API calls in parallel
        const [dedustPools, stonfiResponse] = await Promise.all([
          dedustPromise,
          stonfiPromise,
        ]);

        // Process DeDust pools with complete data
        const taggedDedustPools = (dedustPools as DeDustPool[]).map((pool) => ({
          ...pool,
          source: "dedust",
          lastUpdateTimestamp: now,
        }));

        // Process StonFi pools with complete data and error handling
        const stonfiPools: Pool[] = [];
        if (stonfiResponse && Array.isArray(stonfiResponse)) {
          // Process pools in parallel batches for faster completion
          const BATCH_SIZE = 20;
          const numBatches = Math.ceil(stonfiResponse.length / BATCH_SIZE);

          for (let i = 0; i < numBatches; i++) {
            const batch = stonfiResponse.slice(
              i * BATCH_SIZE,
              (i + 1) * BATCH_SIZE
            );

            const batchResults = await Promise.all(
              batch.map(async (pool) => {
                if (pool.deprecated) return null;
                try {
                  return await this.convertStonFiPool(pool, this.stonfiClient);
                } catch (err) {
                  console.error(
                    `Error converting StonFi pool ${pool.address}:`,
                    err
                  );
                  return null;
                }
              })
            );

            stonfiPools.push(...(batchResults.filter(Boolean) as Pool[]));
          }
        }

        // Combine pools from both sources
        const allPools = [...taggedDedustPools, ...stonfiPools];
        console.log(`Total pools for full update: ${allPools.length}`);

        if (allPools.length > 0) {
          // Update all pools with complete data
          await this.updateBulkPoolStates(allPools);
        } else {
          console.warn("No pools found in this full update cycle");
        }

        console.log("Full update completed successfully");
      } catch (error) {
        console.error("Full update error:", error);
      } finally {
        // Reset update in progress flag
        await this.setUpdateInProgress("full", false);
      }
    };

    // Expose these functions
    this.performFastUpdate = performFastUpdate;
    this.performFullUpdate = performFullUpdate;

    // Start fast update in the background (don't await it)
    performFastUpdate().catch((err) =>
      console.error("Initial fast update failed:", err)
    );
    this.memoryUpdateInterval = setInterval(() => {
      this.performMemoryOnlyUpdate().catch((err) =>
        console.error("Error in memory-only update:", err)
      );
    }, this.MEMORY_UPDATE_SECONDS * 1000);

    // NEW: Set up interval for Redis persistence (5 minutes)
    this.redisPersistInterval = setInterval(() => {
      this.performRedisPersistence().catch((err) =>
        console.error("Error in Redis persistence:", err)
      );
    }, this.REDIS_PERSIST_MINUTES * 60 * 1000);

    // Run immediate memory update
    this.performMemoryOnlyUpdate().catch((err) =>
      console.error("Initial memory update failed:", err)
    );
    console.log("Pool tracking initialized successfully");
  }

  private async performRedisPersistence(): Promise<void> {
    // Skip if update already in progress
    if (await this.isUpdateInProgress("redis-persist")) {
      console.log("[Redis-Persist] Update already in progress, skipping");
      return;
    }

    try {
      await this.setUpdateInProgress("redis-persist", true);
      const now = Date.now();

      console.log(
        `[Redis-Persist] Starting persistence at ${new Date(now).toISOString()}`
      );

      // Store timestamp
      await this.redis.set("redisPersistTimestamp", now, { ex: 3600 });

      // Store DeDust pools
      const dedustPools = this.redisCacheData.get("dedust") || [];
      if (dedustPools.length > 0) {
        await this.storePoolsInChunks("dedust", dedustPools);
        console.log(
          `[Redis-Persist] Stored ${dedustPools.length} DeDust pools`
        );
      }

      // Store StonFi pools
      const stonfiPools = this.redisCacheData.get("stonfi") || [];
      if (stonfiPools.length > 0) {
        await this.storePoolsInChunks("stonfi", stonfiPools);
        console.log(
          `[Redis-Persist] Stored ${stonfiPools.length} StonFi pools`
        );
      }

      // Update timestamps using pipeline for efficiency
      const pipeline = this.redis.pipeline();
      pipeline.set("lastUpdate:dedust", now, { ex: 3600 });
      pipeline.set("lastUpdate:stonfi", now, { ex: 3600 });
      await pipeline.exec();

      // Store a quick access version too
      await this.storeQuickResponseData("dedust", dedustPools.slice(0, 500));
      await this.storeQuickResponseData("stonfi", stonfiPools.slice(0, 500));

      console.log(`[Redis-Persist] Completed in ${Date.now() - now}ms`);
    } catch (error) {
      console.error("[Redis-Persist] Error during persistence:", error);
    } finally {
      await this.setUpdateInProgress("redis-persist", false);
    }
  }

  // Stop tracking pools
  async stopTracking(): Promise<void> {
    if (this.memoryUpdateInterval) {
      clearInterval(this.memoryUpdateInterval);
      this.memoryUpdateInterval = null;
    }

    if (this.redisPersistInterval) {
      clearInterval(this.redisPersistInterval);
      this.redisPersistInterval = null;
    }

    this.isTracking = false;
  }

  // Get latest pools with optimized update checking
  async getLatestPools(
    source: string,
    skipUpdate: boolean = false
  ): Promise<Pool[]> {
    // First, check if we have quick response data
    const quickDataKey = `quick:${source}`;
    const quickData = await this.redis.get(quickDataKey);

    if (quickData) {
      // Parse and use quick data
      const quickPools = JSON.parse(
        typeof quickData === "string" ? quickData : JSON.stringify(quickData)
      );

      // If we have quick data and it's recent, use it
      if (Array.isArray(quickPools) && quickPools.length > 0) {
        console.log(
          `Using ${quickPools.length} quick response pools for ${source}`
        );

        // Store in redisCacheData for immediate access elsewhere
        this.redisCacheData.set(source, quickPools);

        // Trigger a background update if needed but don't wait for it
        if (!skipUpdate && (await this.shouldRefreshPools(source))) {
          // Use setTimeout to not block the current response
          setTimeout(async () => {
            console.log(`Background refreshing ${source} pools`);
            try {
              await this.triggerUpdateIfNeeded(false);
            } catch (error) {
              console.error(`Background update error for ${source}:`, error);
            }
          }, 10);
        }

        return quickPools;
      }
    }

    // Check in-memory cache next
    if (this.redisCacheData.has(source)) {
      const cachedPools = this.redisCacheData.get(source)!;
      if (cachedPools.length > 0) {
        // Only trigger update if needed, but return cached data immediately
        if (!skipUpdate) {
          this.triggerUpdateIfNeeded(false).catch((err) =>
            console.error("Background update error:", err)
          );
        }
        return cachedPools;
      }
    }

    // Check if it's time to update first, passing the skipUpdate parameter
    if (!skipUpdate) {
      await this.triggerUpdateIfNeeded(skipUpdate);
    }

    try {
      // Get pools from chunks
      const pools = await this.getPoolsFromChunks(source);
      if (pools.length > 0) {
        // Update in-memory cache with Redis data
        this.redisCacheData.set(source, pools);

        // Any pools with minimum structure are good enough for quotes
        return pools;
      }
    } catch (error) {
      console.error(
        `Error getting latest pools from Redis for ${source}:`,
        error
      );
    }

    // Fall back to direct API calls if Redis fails or has no data
    console.log(`Falling back to API for ${source} pools...`);
    let apiPools: Pool[] = [];

    if (source === "dedust") {
      try {
        const dedustPools = await this.dedustClient.getPools();
        apiPools = (dedustPools as DeDustPool[]).map((pool) => ({
          ...pool,
          source: "dedust",
          lastUpdateTimestamp: Date.now(),
        }));
      } catch (error) {
        console.error("Error fetching DeDust pools:", error);
      }
    } else if (source === "stonfi") {
      try {
        const stonfiResponse = await this.stonfiClient.getPools();

        if (stonfiResponse && Array.isArray(stonfiResponse)) {
          // For fast fallback, just use basic data
          apiPools = stonfiResponse
            .filter((pool) => !pool.deprecated)
            .map((pool) => ({
              address: pool.address,
              reserves: [pool.reserve0, pool.reserve1],
              source: "stonfi",
              lastUpdateTimestamp: Date.now(),
              lt: "0",
              totalSupply: pool.lpTotalSupply || "0",
              type: "stonfi",
              tradeFee: pool.lpFee || "0",
              assets: [
                {
                  type: "jetton",
                  address: pool.token0Address,
                  metadata: {
                    name: "Unknown Token 0",
                    symbol: "UNK0",
                    decimals: 9,
                  },
                },
                {
                  type: "jetton",
                  address: pool.token1Address,
                  metadata: {
                    name: "Unknown Token 1",
                    symbol: "UNK1",
                    decimals: 9,
                  },
                },
              ],
              lastPrice: { value: "0" },
              stats: {
                fees: [
                  pool.collectedToken0ProtocolFee || "0",
                  pool.collectedToken1ProtocolFee || "0",
                ],
                volume: [pool.token0Balance || "0", pool.token1Balance || "0"],
              },
            })) as Pool[];
        }
      } catch (error) {
        console.error("Error fetching StonFi pools:", error);
      }
    }

    // Store in Redis for future use
    if (apiPools.length > 0) {
      try {
        // Update memory cache immediately
        this.redisCacheData.set(source, apiPools);

        // Store in Redis in the background
        this.storePoolsInChunks(source, apiPools).catch((redisError) => {
          console.error(
            `Error storing pools in Redis for ${source}:`,
            redisError
          );
        });
      } catch (error) {
        console.error(`Error updating caches for ${source}:`, error);
      }
    }

    return apiPools;
  }

  // Get pools by source
  async getPoolsBySource(source: string): Promise<Pool[]> {
    // Simply retrieve from chunks/Redis
    try {
      const pools = await this.getPoolsFromChunks(source);

      // If no pools in Redis chunks, fall back to API
      if (pools.length === 0) {
        return await this.getLatestPools(source, false);
      }

      return pools;
    } catch (error) {
      console.error(`Error getting pools for ${source}:`, error);

      // Fall back to API as a last resort
      return await this.getLatestPools(source, false);
    }
  }

  // Filter pools by liquidity
  public filterPoolsByLiquidity(
    source: string,
    minReserve: number,
    maxTradeFee: number,
    sourceVersion?: string
  ): Pool[] {
    // Get pools from memory cache
    const pools = this.redisCacheData.get(source) || [];

    // If no pools in memory cache, return empty array
    if (pools.length === 0) {
      console.warn(`No pools in memory cache for ${source}`);
      return [];
    }

    // Apply the filtering logic
    return pools.filter((pool) => {
      // Basic pool validation
      if (!pool?.assets?.length || !pool?.reserves?.length || !pool?.stats) {
        return false;
      }

      if (
        source === "stonfi" &&
        sourceVersion &&
        pool.version !== sourceVersion
      ) {
        return false;
      }

      let tradeFee = parseFloat(pool.tradeFee || "0");

      // Check trade fee
      if (pool.source === "stonfi" && tradeFee > 1) {
        tradeFee = tradeFee / 100;
      }
      if (tradeFee > maxTradeFee) {
        return false;
      }

      // Validate pool structure
      if (pool.assets.length !== 2 || pool.reserves.length !== 2) {
        return false;
      }

      // Validate assets
      for (const asset of pool.assets) {
        if (asset.type === "native") continue;
        if (
          !asset.metadata?.symbol ||
          asset.metadata?.name?.includes("Stake")
        ) {
          return false;
        }
      }

      // Validate reserves
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

      if (source === "dedust") {
        const totalVolume = pool.stats.volume
          .map((v) => parseFloat(v) || 0)
          .reduce((a, b) => a + b, 0);

        if (totalVolume === 0) {
          return false;
        }
      }

      return true;
    });
  }

  // Convert StonFi pool format to our standard Pool format
  private async convertStonFiPool(
    stonfiPool: any,
    client?: StonApiClient
  ): Promise<Pool> {
    // Use provided client or create a new one if not provided
    const stonfiClient = client || this.stonfiClient;

    // Fetch the asset information for both tokens
    let token0Metadata: TokenMetadata = {
      name: "Unknown Token 0",
      symbol: "UNK0",
      decimals: 9,
    };

    let token1Metadata: TokenMetadata = {
      name: "Unknown Token 1",
      symbol: "UNK1",
      decimals: 9,
    };
    let asset0Type = "jetton";
    let asset1Type = "jetton";

    try {
      const [asset0, asset1] = await Promise.all([
        stonfiPool.token0Address
          ? stonfiClient.getAsset(stonfiPool.token0Address)
          : null,
        stonfiPool.token1Address
          ? stonfiClient.getAsset(stonfiPool.token1Address)
          : null,
      ]);

      // Process asset0 if available
      if (asset0) {
        token0Metadata = {
          name: asset0.displayName || "Unknown Token 0",
          symbol: asset0.symbol || "UNK0",
          decimals: asset0.decimals || 9,
        };
        asset0Type = asset0.kind;
      }

      // Process asset1 if available
      if (asset1) {
        token1Metadata = {
          name: asset1.displayName || "Unknown Token 1",
          symbol: asset1.symbol || "UNK1",
          decimals: asset1.decimals || 9,
        };
        asset1Type = asset1.kind;
      }
    } catch (error) {
      console.error(`Error fetching asset information:`, error);
      // Continue with default metadata if fetching fails
    }

    // Create token assets with the fetched metadata
    const assets: TokenAsset[] = [
      {
        type: asset0Type,
        address: stonfiPool.token0Address,
        metadata: token0Metadata,
      },
      {
        type: asset1Type,
        address: stonfiPool.token1Address,
        metadata: token1Metadata,
      },
    ];

    const stonfiVersion = stonfiPool.router === this.StonfiV1 ? "v1" : "v2";

    // Create Pool object
    return {
      address: stonfiPool.address,
      lt: "0",
      totalSupply: stonfiPool.lpTotalSupply,
      type: "stonfi",
      tradeFee: stonfiPool.lpFee,
      assets: assets,
      lastPrice: {
        value: "0",
      },
      reserves: [stonfiPool.reserve0, stonfiPool.reserve1],
      stats: {
        fees: [
          stonfiPool.collectedToken0ProtocolFee,
          stonfiPool.collectedToken1ProtocolFee,
        ],
        volume: [
          stonfiPool.token0Balance || "0",
          stonfiPool.token1Balance || "0",
        ],
      },
      source: "stonfi",
      version: stonfiVersion,
      lastUpdateTimestamp: Date.now(),
    };
  }

  // Trigger update if needed
  async triggerUpdateIfNeeded(skipUpdate: boolean = false): Promise<void> {
    // If skipUpdate is true or tracking is disabled, return immediately
    if (skipUpdate || !this.isTracking) {
      return;
    }

    try {
      // Check if an update is already in progress
      const updateInProgress = await this.redis.get(
        this.UPDATE_IN_PROGRESS_KEY
      );

      if (updateInProgress) {
        // Check when the update started - handle both string and numeric values
        const updateStartTime =
          typeof updateInProgress === "string"
            ? parseInt(updateInProgress)
            : typeof updateInProgress === "number"
            ? updateInProgress
            : Date.now();

        const now = Date.now();

        // If update has been running for less than 10 seconds, skip
        if (now - updateStartTime < 10000) {
          return;
        } else {
          // Stale lock - the previous update might have failed
          console.log("Clearing stale update lock");
        }
      }

      // Check when we last did a fast update
      const lastUpdateData = await this.redis.get("fastUpdateTimestamp");
      const now = Date.now();

      let shouldUpdate = false;

      if (!lastUpdateData) {
        shouldUpdate = true;
      } else {
        const lastUpdate =
          typeof lastUpdateData === "string"
            ? parseInt(lastUpdateData)
            : typeof lastUpdateData === "number"
            ? lastUpdateData
            : 0;

        // Only update if it's been more than FAST_UPDATE_INTERVAL since last update
        if (now - lastUpdate >= this.FAST_UPDATE_INTERVAL) {
          shouldUpdate = true;
        }
      }

      // Check if fast update is in progress using Redis
      const fastUpdateInProgress = await this.isUpdateInProgress("fast");

      if (shouldUpdate && !fastUpdateInProgress) {
        // Set an update in progress lock with timeout
        await this.redis.set(this.UPDATE_IN_PROGRESS_KEY, now.toString(), {
          ex: 30,
        });

        try {
          // Trigger a fast update
          await this.performFastUpdate();
        } finally {
          // Always clear the lock when done
          await this.redis.del(this.UPDATE_IN_PROGRESS_KEY);
        }
      }

      // Check when we last did a full update
      const lastFullUpdateData = await this.redis.get("fullUpdateTimestamp");

      let shouldFullUpdate = false;

      if (!lastFullUpdateData) {
        shouldFullUpdate = true;
      } else {
        const lastFullUpdate =
          typeof lastFullUpdateData === "string"
            ? parseInt(lastFullUpdateData)
            : typeof lastFullUpdateData === "number"
            ? lastFullUpdateData
            : 0;

        // Only do full update if it's been more than FULL_UPDATE_INTERVAL
        if (now - lastFullUpdate >= this.FULL_UPDATE_INTERVAL) {
          shouldFullUpdate = true;
        }
      }

      // Check if full update is in progress using Redis
      const fullUpdateInProgress = await this.isUpdateInProgress("full");

      if (shouldFullUpdate && !fullUpdateInProgress) {
        // Don't wait for full update, just trigger it in background
        this.performFullUpdate().catch((err) =>
          console.error("Error in background full update:", err)
        );
      }
    } catch (error) {
      console.error("Error checking update timestamps:", error);
    }
  }

  // Get a single pool by address with API fallback
  async getPool(address: string): Promise<Pool | null> {
    // First try to find in memory cache
    for (const [source, pools] of this.redisCacheData.entries()) {
      const pool = pools.find((p) => p.address === address);
      if (pool) return pool;
    }

    // Check hot pools cache
    for (const [poolAddress, pool] of this.hotPoolsCache.entries()) {
      if (poolAddress === address) {
        return pool;
      }
    }

    // Then try Redis cache
    const dedustPools = await this.getPoolsFromChunks("dedust");
    const stonfiPools = await this.getPoolsFromChunks("stonfi");

    const pool = [...dedustPools, ...stonfiPools].find(
      (p) => p.address === address
    );
    if (pool) return pool;

    // Finally, try direct API calls as a last resort
    console.log(`Pool ${address} not found in cache, fetching from APIs...`);
    try {
      // Try to fetch fresh pools and check again
      await this.performFastUpdate();

      // Check again after refresh
      for (const [source, pools] of this.redisCacheData.entries()) {
        const pool = pools.find((p) => p.address === address);
        if (pool) return pool;
      }
    } catch (error) {
      console.error(`Error fetching pool ${address} from APIs:`, error);
    }

    return null;
  }

  // Force refresh pools
  public async forceRefreshPools(source?: string): Promise<void> {
    if (source) {
      // Clear specific source from Redis
      try {
        // Clear all chunks for this source
        const metadataKey = `pools:meta:${source}`;
        const metadataJson = await this.redis.get(metadataKey);

        if (metadataJson) {
          const metadata =
            typeof metadataJson === "string"
              ? JSON.parse(metadataJson)
              : metadataJson;

          const numChunks = metadata.chunks;

          // Delete all chunks
          for (let i = 0; i < numChunks; i++) {
            const chunkKey = `${this.CHUNK_KEY_PREFIX}${source}:${i}`;
            await this.redis.del(chunkKey);
          }
        }

        // Delete metadata
        await this.redis.del(metadataKey);
        await this.redis.del(`lastUpdate:${source}`);

        // Clear memory cache
        this.redisCacheData.delete(source);

        console.log(`Forced refresh of ${source} pools cache`);
      } catch (error) {
        console.error(`Error clearing Redis cache for ${source}:`, error);
      }

      // Immediately repopulate from API
      if (source === "dedust") {
        try {
          const dedustPools = await this.dedustClient.getPools();
          const pools = (dedustPools as DeDustPool[]).map((pool) => ({
            ...pool,
            source: "dedust",
            lastUpdateTimestamp: Date.now(),
          }));
          await this.updateBulkPoolStates(pools);
        } catch (error) {
          console.error("Error refreshing DeDust pools:", error);
        }
      } else if (source === "stonfi") {
        try {
          const stonfiResponse = await this.stonfiClient.getPools();
          if (stonfiResponse && Array.isArray(stonfiResponse)) {
            const pools = await Promise.all(
              stonfiResponse
                .filter((pool) => !pool.deprecated)
                .map(async (pool) => {
                  try {
                    return await this.convertStonFiPool(pool);
                  } catch (err) {
                    console.error(`Error converting StonFi pool:`, err);
                    return null;
                  }
                })
            );
            await this.updateBulkPoolStates(pools.filter(Boolean) as Pool[]);
          }
        } catch (error) {
          console.error("Error refreshing StonFi pools:", error);
        }
      }
    } else {
      // Clear all sources from Redis
      try {
        // Get all chunk metadata keys
        const metaKeys = await this.redis.keys("pools:meta:*");

        // Delete all chunks for each source
        for (const metaKey of metaKeys) {
          const metadataJson = await this.redis.get(metaKey);
          const source = metaKey.split(":")[2]; // Extract source from key

          if (metadataJson) {
            const metadata =
              typeof metadataJson === "string"
                ? JSON.parse(metadataJson)
                : metadataJson;

            const numChunks = metadata.chunks;

            // Delete all chunks for this source
            for (let i = 0; i < numChunks; i++) {
              const chunkKey = `${this.CHUNK_KEY_PREFIX}${source}:${i}`;
              await this.redis.del(chunkKey);
            }
          }

          // Delete metadata
          await this.redis.del(metaKey);
        }

        // Delete all lastUpdate keys
        const updateKeys = await this.redis.keys("lastUpdate:*");
        for (const key of updateKeys) {
          await this.redis.del(key);
        }

        // Clear memory cache
        this.redisCacheData.clear();
        this.hotPoolsCache.clear();

        // Also clear path cache
        this.pathCache.clear();
        this.pathCacheExpiry.clear();

        console.log("Forced refresh of all pools cache");
      } catch (error) {
        console.error("Error clearing all Redis caches:", error);
      }

      // Force a full update
      await this.performFullUpdate();
    }
  }
}

class PoolService {
  private static instance: PoolService;
  private tracker: PoolTracker;
  private initialized: boolean = false;
  private initializationPromise: Promise<void> | null = null;

  private constructor() {
    this.tracker = new PoolTracker(
      process.env.TON_ENDPOINT || "https://mainnet-v4.tonhubapi.com"
    );
  }

  public getRedis(): Redis {
    return this.tracker.redis;
  }

  static getInstance(): PoolService {
    if (!PoolService.instance) {
      PoolService.instance = new PoolService();
    }
    return PoolService.instance;
  }

  async initialize(pools: Pool[] = []): Promise<void> {
    // If already initialized, return immediately
    if (this.initialized) {
      return;
    }

    // If initialization is in progress, wait for it to complete
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    // Start initialization process and store the promise
    this.initializationPromise = this._doInitialize(pools);

    try {
      // Set a timeout to prevent hanging
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Initialize timed out")), 8000)
      );

      // Race between initialization and timeout
      await Promise.race([this.initializationPromise, timeout]);
    } catch (error) {
      console.error("PoolService initialization timed out:", error);
      // If we time out, still mark as initialized so future requests can proceed
      this.initialized = true;

      // Continue initialization in the background
      this.initializationPromise.catch((err) =>
        console.error("Background initialization failed:", err)
      );
    }
  }

  private async _doInitialize(pools: Pool[]): Promise<void> {
    try {
      // No need to connect to MongoDB anymore
      console.log("Initializing PoolService...");

      // Do minimal initialization to get the service working
      this.initialized = true;

      // Start tracking but don't wait for the initial updates
      this.tracker.startTracking().catch((error) => {
        console.error("Error starting tracking:", error);
      });

      // Start a background task to store pools
      if (pools.length > 0) {
        setTimeout(() => {
          this.tracker.updateBulkPoolStates(pools).catch((error) => {
            console.error("Error storing initial pools:", error);
          });
        }, 100);
      }

      // Don't await this, let it happen in the background
      return;
    } catch (error) {
      console.error("Failed to initialize PoolService:", error);
      this.initializationPromise = null; // Reset promise so initialization can be retried
      throw error;
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async getPools(): Promise<Pool[]> {
    // Ensure initialization before getting pools
    if (!this.initialized) {
      await this.initialize();
    }
    return await this.tracker.getAllPools();
  }

  // Cache the path finding results
  public async cachePathResult(
    fromAddress: string,
    toAddress: string,
    amount: string,
    result: any
  ): Promise<void> {
    try {
      const baseKey = `path:${fromAddress}-${toAddress}-${amount}`;
      const jsonData = JSON.stringify(result);

      // If data is small enough, store directly
      if (jsonData.length < 900000) {
        await this.tracker.redis.set(baseKey, jsonData, { ex: 30 });
        return;
      }

      // Otherwise split into chunks of 800KB
      const chunkSize = 800000;
      const chunks = [];

      for (let i = 0; i < jsonData.length; i += chunkSize) {
        chunks.push(jsonData.slice(i, i + chunkSize));
      }

      // Store metadata
      await this.tracker.redis.set(
        `${baseKey}:meta`,
        JSON.stringify({
          chunks: chunks.length,
          timestamp: Date.now(),
        }),
        { ex: 30 }
      );

      // Store chunks
      for (let i = 0; i < chunks.length; i++) {
        await this.tracker.redis.set(`${baseKey}:chunk:${i}`, chunks[i], {
          ex: 30,
        });
      }
    } catch (error) {
      console.error("Error caching path result:", error);
      // Fall back to in-memory cache on error
      const inMemoryCacheKey = `${fromAddress}-${toAddress}-${amount}`;
      this.tracker.pathCache.set(inMemoryCacheKey, result);
      this.tracker.pathCacheExpiry.set(inMemoryCacheKey, Date.now() + 30000);
    }
  }

  // Retrieve path from cache
  public getPathFromCache(
    fromAddress: string,
    toAddress: string,
    amount: string
  ): any | null {
    return this.tracker.getPathFromCache(fromAddress, toAddress, amount);
  }

  // Modified method to accept and pass skipUpdate parameter
  async getPoolsBySource(
    source: string,
    skipUpdate: boolean = true // Default to true to avoid unnecessary updates
  ): Promise<Pool[]> {
    // Ensure initialization before getting pools
    if (!this.initialized) {
      await this.initialize();
    }
    return await this.tracker.getLatestPools(source, skipUpdate);
  }

  public getTracker(): PoolTracker {
    return this.tracker;
  }

  async cleanup(): Promise<void> {
    await this.tracker.stopTracking();
    this.initialized = false;
    this.initializationPromise = null;
  }
}

export { PoolTracker, PoolService };
