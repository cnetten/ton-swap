/* eslint-disable @typescript-eslint/no-explicit-any */
import { TonClient4, Address } from "@ton/ton";
import { EventEmitter } from "events";
import { DeDustClient } from "@dedust/sdk";
import { StonApiClient } from "@ston-fi/api";
import { Redis } from "@upstash/redis";
import { fetchWithRetry } from "./utils/utils";

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
  lastUpdateTimestamp?: number;
}

// StonFi interfaces remain the same
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
  private readonly FAST_UPDATE_INTERVAL = 3000; // 3 seconds between fast updates
  private readonly FULL_UPDATE_INTERVAL = 60000; // 60 seconds between full updates
  private trackingIntervals: NodeJS.Timeout[] = [];
  public redis: Redis;
  private redisCacheData: Map<string, Pool[]> = new Map();
  private readonly CHUNK_SIZE = 200; // Number of pools per chunk, adjust as needed
  private readonly CHUNK_KEY_PREFIX = "pools:chunk:";
  private readonly UPDATE_IN_PROGRESS_KEY = "updateInProgress";

  // Path cache for faster response - store calculation results
  public pathCache = new Map<string, any>();
  public pathCacheExpiry = new Map<string, number>();
  private readonly PATH_CACHE_TTL = 30000; // 30 seconds TTL for path cache

  // API clients for direct calls
  private dedustClient: DeDustClient;
  private stonfiClient: StonApiClient;

  // Define for TypeScript
  public performFastUpdate: () => Promise<void>;
  public performFullUpdate: () => Promise<void>;

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
  }

  // Cache path finding results for quicker responses
  public cachePathResult(
    fromAddress: string,
    toAddress: string,
    amount: string,
    result: any
  ): void {
    const cacheKey = `${fromAddress}-${toAddress}-${amount}`;
    this.pathCache.set(cacheKey, result);
    this.pathCacheExpiry.set(cacheKey, Date.now() + this.PATH_CACHE_TTL);
  }

  public async getPathFromCache(
    fromAddress: string,
    toAddress: string,
    amount: string
  ): Promise<any | null> {
    try {
      // Try to get from Redis first
      const cacheKey = `path:${fromAddress}-${toAddress}-${amount}`;
      const cachedResult = await this.redis.get(cacheKey);

      if (cachedResult) {
        return typeof cachedResult === "string"
          ? JSON.parse(cachedResult)
          : cachedResult;
      }

      // Fall back to in-memory cache if Redis failed or returned nothing
      const inMemoryCacheKey = `${fromAddress}-${toAddress}-${amount}`;
      const expiry = this.pathCacheExpiry.get(inMemoryCacheKey) || 0;

      // Return null if cache expired
      if (expiry < Date.now()) {
        this.pathCache.delete(inMemoryCacheKey);
        this.pathCacheExpiry.delete(inMemoryCacheKey);
        return null;
      }

      return this.pathCache.get(inMemoryCacheKey) || null;
    } catch (error) {
      console.error("Error retrieving from path cache:", error);
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

      // Check sample of pools for changes - more efficient for Vercel
      const checkSampleSize = Math.min(10, newPools.length);
      const sampleIndexes = Array.from({ length: checkSampleSize }, () =>
        Math.floor(Math.random() * newPools.length)
      );

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

      // Fetch a sample of chunks
      const chunkPromises = [];
      const chunkIndexes = [0]; // Always check first chunk
      if (metadata.chunks > 1) {
        // Add one random chunk if there are multiple
        chunkIndexes.push(Math.floor(Math.random() * metadata.chunks));
      }

      for (const i of chunkIndexes) {
        const chunkKey = `${this.CHUNK_KEY_PREFIX}${source}:${i}`;
        chunkPromises.push(this.redis.get(chunkKey));
      }

      const chunkResults = await Promise.all(chunkPromises);

      // Build a map of sample existing pools
      const existingPoolMap = new Map<string, Pool>();
      for (const chunkData of chunkResults) {
        if (chunkData) {
          const chunk =
            typeof chunkData === "string" ? JSON.parse(chunkData) : chunkData;
          for (const pool of chunk) {
            existingPoolMap.set(pool.address, pool);
          }
        }
      }

      // Check sampled pools for changes
      let changesFound = 0;
      for (const idx of sampleIndexes) {
        const newPool = newPools[idx];
        if (!newPool || !newPool.address) continue;

        const existingPool = existingPoolMap.get(newPool.address);
        if (!existingPool) {
          console.log(`New pool found: ${newPool.address}`);
          return true;
        }

        if (newPool.reserves && existingPool.reserves) {
          if (newPool.reserves.join(",") !== existingPool.reserves.join(",")) {
            changesFound++;
            console.log(
              `Reserve changed for pool ${newPool.address}: [${existingPool.reserves}] -> [${newPool.reserves}]`
            );

            if (changesFound >= 3) {
              console.log(
                `Found ${changesFound} changes in sample, updating data`
              );
              return true;
            }
          }
        }
      }

      return changesFound > 0;
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
          await this.redis.del(flagKey);
          await this.redis.del(startTimeKey);
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

      if (inProgress) {
        // Set flag with 10 minute expiry as a safeguard
        await this.redis.set(flagKey, "true", { ex: 600 });
        await this.redis.set(startTimeKey, Date.now().toString(), { ex: 600 });
      } else {
        // Clear the flags
        await this.redis.del(flagKey);
        await this.redis.del(startTimeKey);
      }
    } catch (error) {
      console.error(`Error setting ${type} update status:`, error);
    }
  }

  // Stores pools in chunks to avoid Redis size limits
  private async storePoolsInChunks(
    source: string,
    pools: Pool[]
  ): Promise<void> {
    try {
      // First check if data has actually changed
      const hasChanged = await this.hasDataChanged(source, pools);

      if (!hasChanged) {
        // Data hasn't changed, just update in-memory cache and return
        this.redisCacheData.set(source, pools);
        // CRITICAL FIX: Return immediately without continuing to update Redis
        return;
      }

      // Continue with existing storage logic...
      const chunks: Pool[][] = [];
      for (let i = 0; i < pools.length; i += this.CHUNK_SIZE) {
        chunks.push(pools.slice(i, i + this.CHUNK_SIZE));
      }

      console.log(
        `Storing ${pools.length} pools in ${chunks.length} chunks for ${source}`
      );

      // Store metadata about chunks
      const metadataKey = `pools:meta:${source}`;
      await this.redis.set(
        metadataKey,
        JSON.stringify({
          totalPools: pools.length,
          chunks: chunks.length,
          lastUpdate: Date.now(),
        }),
        { ex: 3600 }
      );

      // Store each chunk separately with expiration
      const chunkPromises = chunks.map((chunk, index) => {
        const chunkKey = `${this.CHUNK_KEY_PREFIX}${source}:${index}`;
        return this.redis.set(chunkKey, JSON.stringify(chunk), { ex: 3600 });
      });

      await Promise.all(chunkPromises);

      // Also update our in-memory cache
      this.redisCacheData.set(source, pools);

      // Update last update timestamp
      await this.redis.set(`lastUpdate:${source}`, Date.now(), { ex: 3600 });

      console.log(
        `Successfully stored ${pools.length} pools in ${chunks.length} chunks for ${source}`
      );
    } catch (error) {
      console.error(`Error storing chunked pools for ${source}:`, error);
      throw error;
    }
  }

  // Retrieves pools from chunks and reconstitutes them
  private async getPoolsFromChunks(source: string): Promise<Pool[]> {
    try {
      // Check if we have it in memory cache first
      if (this.redisCacheData.has(source)) {
        const cachedPools = this.redisCacheData.get(source)!;
        if (cachedPools.length > 0) {
          return cachedPools;
        }
      }

      // Retrieve chunks directly from Redis without any change detection
      const metadataKey = `pools:meta:${source}`;
      const metadataJson = await this.redis.get(metadataKey);

      if (!metadataJson) {
        return [];
      }

      // Parse metadata
      const metadata =
        typeof metadataJson === "string"
          ? JSON.parse(metadataJson)
          : metadataJson;

      if (!metadata || !metadata.chunks) {
        return [];
      }

      const numChunks = metadata.chunks;

      // Retrieve all chunks in parallel
      const chunkPromises = [];
      for (let i = 0; i < numChunks; i++) {
        const chunkKey = `${this.CHUNK_KEY_PREFIX}${source}:${i}`;
        chunkPromises.push(this.redis.get(chunkKey));
      }

      const chunkResults = await Promise.all(chunkPromises);

      // Combine chunks
      let allPools: Pool[] = [];
      for (const chunkData of chunkResults) {
        if (chunkData) {
          const chunk =
            typeof chunkData === "string" ? JSON.parse(chunkData) : chunkData;
          allPools = allPools.concat(chunk);
        }
      }

      // Update memory cache
      this.redisCacheData.set(source, allPools);

      return allPools;
    } catch (error) {
      console.error(`Error getting pools from chunks for ${source}:`, error);
      return [];
    }
  }

  async addPool(pool: Pool): Promise<void> {
    try {
      const address = Address.parse(pool.address);
      this.poolAddresses.add(address.toString());

      // Get initial state
      const state = await this.fetchPoolState(pool);
      if (state) {
        // Instead of updating DB, store in Redis
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

  public async updateBulkPoolStates(pools: Pool[]): Promise<void> {
    if (pools.length === 0) return;

    // Track if any reserves have changed to invalidate path cache
    let reservesChanged = false;

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
                  console.log(`Reserves changed for pool ${pool.address}`);
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
            }
          }

          // Convert back to array
          const updatedPools = Array.from(poolMap.values());

          // Store in Redis using chunks
          await this.storePoolsInChunks(source, updatedPools);
        } catch (error) {
          console.error(`Error updating Redis cache for ${source}:`, error);
        }
      }

      // Emit events immediately for updates
      pools.forEach((pool) => this.emit("poolStateUpdated", pool));

      if (reservesChanged) {
        console.log("Reserves changed, clearing path cache");
        this.clearPathCache();
      }

      return;
    } catch (error) {
      console.error("Redis update error:", error);
    }
  }

  // Function to convert StonFi pool data to our Pool format
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
      lastUpdateTimestamp: Date.now(),
    };
  }

  async startTracking(): Promise<void> {
    // If already tracking, return immediately
    if (this.isTracking) {
      console.log("Already tracking, skipping additional start request");
      return;
    }

    this.isTracking = true;

    // Define fast update function for real-time data with debounce logic
    // This function should be placed inside the startTracking method
    const performFastUpdate = async () => {
      // CRITICAL: Skip if update already in progress
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

        // OPTIMIZATION: Reduce API timeouts from 10s to 2s
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
                  // Check if reserves have changed - IMPORTANT NEW CODE
                  if (pool.reserves && existingPool.reserves) {
                    if (
                      pool.reserves.join(",") !==
                      existingPool.reserves.join(",")
                    ) {
                      console.log(
                        `Reserves changed for pool ${pool.address}: [${existingPool.reserves}] -> [${pool.reserves}]`
                      );
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

        const forceRefreshSample = Math.floor(Math.random() * 5) === 0; // 20% chance
        if (forceRefreshSample) {
          console.log("Forced refresh of path cache based on random sample");
          this.clearPathCache();
        }
      } catch (error) {
        console.error("Fast update error:", error);
      } finally {
        // IMPORTANT: Reset update in progress flag
        await this.setUpdateInProgress("fast", false);
      }
    };

    // Function for full updates (complete metadata refresh) with debounce logic
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
              }, 10000) // Reduced from 8000ms to 3000ms
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
              }, 10000) // Reduced from 8000ms to 3000ms
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
        // IMPORTANT: Reset update in progress flag
        await this.setUpdateInProgress("full", false);
      }
    };

    // For serverless environments, we'll expose these functions
    // so they can be called from the API route handlers
    this.performFastUpdate = performFastUpdate;
    this.performFullUpdate = performFullUpdate;

    // Start fast update in the background (don't await it)
    performFastUpdate().catch((err) =>
      console.error("Initial fast update failed:", err)
    );

    console.log("Pool tracking initialized successfully");
  }

  // Modified method to accept skipUpdate parameter
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

  async stopTracking(): Promise<void> {
    // No intervals to clear in serverless implementation
    this.isTracking = false;
  }

  // Get a single pool by address - now with direct API fallback
  async getPool(address: string): Promise<Pool | null> {
    // First try to find in memory cache
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const [source, pools] of this.redisCacheData.entries()) {
      const pool = pools.find((p) => p.address === address);
      if (pool) return pool;
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
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for (const [source, pools] of this.redisCacheData.entries()) {
        const pool = pools.find((p) => p.address === address);
        if (pool) return pool;
      }
    } catch (error) {
      console.error(`Error fetching pool ${address} from APIs:`, error);
    }

    return null;
  }

  // Get all pools - returns combined data from all sources
  async getAllPools(): Promise<Pool[]> {
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

  // Preload pools into memory cache
  async preloadRedisCache(source: string): Promise<Pool[]> {
    try {
      const pools = await this.getPoolsFromChunks(source);
      if (pools.length > 0) {
        return pools;
      }

      // If no pools found in Redis, fetch directly from APIs
      console.log(`No ${source} pools in Redis, fetching from API...`);

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
            // Process non-deprecated pools
            const processedPools = await Promise.all(
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

            apiPools = processedPools.filter(Boolean) as Pool[];
          }
        } catch (error) {
          console.error("Error fetching StonFi pools:", error);
        }
      }

      if (apiPools.length > 0) {
        // Store in Redis chunks for future use
        await this.storePoolsInChunks(source, apiPools);
      }

      return apiPools;
    } catch (error) {
      console.error(`Error preloading Redis cache for ${source}:`, error);
      return [];
    }
  }

  // Get latest pools with optimized update checking
  async getLatestPools(
    source: string,
    skipUpdate: boolean = false
  ): Promise<Pool[]> {
    // First check if we already have pools in memory cache
    if (this.redisCacheData.has(source)) {
      const cachedPools = this.redisCacheData.get(source)!;
      if (cachedPools.length > 0) {
        // OPTIMIZATION: Only trigger update if needed, but return cached data immediately
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
        // OPTIMIZATION: Any pools with minimum structure are good enough for quotes
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

  public filterPoolsByLiquidity(
    source: string,
    minReserve: number,
    maxTradeFee: number
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

  // Helper method to refresh pools from API to Redis
  private async refreshPoolsFromAPI(source: string): Promise<void> {
    try {
      let apiPools: Pool[] = [];

      if (source === "dedust") {
        const dedustPools = await this.dedustClient.getPools();
        apiPools = (dedustPools as DeDustPool[]).map((pool) => ({
          ...pool,
          source: "dedust",
          lastUpdateTimestamp: Date.now(),
        }));
      } else if (source === "stonfi") {
        const stonfiResponse = await this.stonfiClient.getPools();

        if (stonfiResponse && Array.isArray(stonfiResponse)) {
          // Process pools in batches
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
                  return await this.convertStonFiPool(pool);
                } catch (err) {
                  console.error(`Error converting StonFi pool:`, err);
                  return null;
                }
              })
            );

            apiPools.push(...(batchResults.filter(Boolean) as Pool[]));
          }
        }
      }

      if (apiPools.length > 0) {
        // Update Redis cache using chunks
        await this.storePoolsInChunks(source, apiPools);
      }
    } catch (error) {
      console.error(`API refresh failed for ${source}:`, error);
      throw error;
    }
  }

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
      await this.refreshPoolsFromAPI(source);
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

  public async clearPathCache(): Promise<void> {
    // Get all path cache keys
    try {
      const pathKeys = await this.redis.keys("path:*");
      console.log(`Clearing Redis path cache with ${pathKeys.length} entries`);

      if (pathKeys.length > 0) {
        await Promise.all(pathKeys.map((key) => this.redis.del(key)));
      }
    } catch (error) {
      console.error("Error clearing Redis path cache:", error);
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
