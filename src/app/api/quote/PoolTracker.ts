/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { TonClient4, Address } from "@ton/ton";
import { MongoClient, Collection } from "mongodb";
import { EventEmitter } from "events";
import { DeDustClient } from "@dedust/sdk";
import { StonApiClient } from "@ston-fi/api";
import { Redis } from "@upstash/redis";

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

interface StonFiPoolsResponse {
  pool_list: StonFiPool[];
}

class PoolTracker extends EventEmitter {
  private tonClient: TonClient4;
  private db: Collection | null = null;
  private poolAddresses: Set<string>;
  private isTracking: boolean = false;
  private trackingInterval: NodeJS.Timeout | null = null;
  private readonly FAST_UPDATE_INTERVAL = 3000; // 3 seconds between fast updates
  private readonly FULL_UPDATE_INTERVAL = 60000; // 60 seconds between full updates
  private mongoClient: MongoClient | null = null;
  private trackingIntervals: NodeJS.Timeout[] = [];
  private redis: Redis;
  private redisCacheData: Map<string, Pool[]> = new Map();
  private readonly CHUNK_SIZE = 200; // Number of pools per chunk, adjust as needed
  private readonly CHUNK_KEY_PREFIX = "pools:chunk:";
  private readonly UPDATE_IN_PROGRESS_KEY = "updateInProgress";

  // Track if a connection is in progress to prevent multiple simultaneous connection attempts
  private connectionInProgress: Promise<void> | null = null;

  // Define for TypeScript
  public performFastUpdate: () => Promise<void>;
  public performFullUpdate: () => Promise<void>;

  constructor(
    private readonly tonEndpoint: string = "https://mainnet-v4.tonhubapi.com",
    private readonly mongoUri: string = process.env.MONGO_CONNECTION
  ) {
    super();
    this.tonClient = new TonClient4({ endpoint: tonEndpoint });
    this.poolAddresses = new Set();

    // Initialize Redis client with Upstash
    this.redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL || "",
      token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
    });

    // Initialize these methods with no-ops, they'll be properly defined in startTracking
    this.performFastUpdate = async () => {};
    this.performFullUpdate = async () => {};
  }

  // Add a method to check if data has actually changed
  private async hasDataChanged(
    source: string,
    newPools: Pool[]
  ): Promise<boolean> {
    try {
      // First check the lastUpdate timestamp
      const lastUpdateKey = `lastUpdate:${source}`;
      const lastUpdateData = await this.redis.get(lastUpdateKey); // Removed <string> type

      let lastUpdateValue: number | null = null;

      if (typeof lastUpdateData === "string") {
        lastUpdateValue = parseInt(lastUpdateData);
      } else if (typeof lastUpdateData === "number") {
        lastUpdateValue = lastUpdateData;
      }

      if (lastUpdateValue === null) {
        // No previous update, data has changed
        return true;
      }

      const now = Date.now();

      // If last update was very recent (within 1 second), avoid duplicate updates
      if (now - lastUpdateValue < 1000) {
        console.log(
          `Skipping Redis update for ${source}, last update was ${
            now - lastUpdateValue
          }ms ago`
        );
        return false;
      }

      // Get the metadata about chunks
      const metadataKey = `pools:meta:${source}`;
      const metadataData = await this.redis.get(metadataKey); // Removed <string> type

      if (!metadataData) {
        // No metadata, data has changed
        return true;
      }

      // Parse metadata if it's a string
      const metadata =
        typeof metadataData === "string"
          ? JSON.parse(metadataData)
          : metadataData;

      // Check if pool count has changed
      if (metadata.totalPools !== newPools.length) {
        console.log(
          `Pool count changed for ${source}: ${metadata.totalPools} -> ${newPools.length}`
        );
        return true;
      }

      // Sample a few pools to check for changes
      const sampleSize = Math.min(10, newPools.length);
      const samples = [];

      for (let i = 0; i < sampleSize; i++) {
        const index = Math.floor(Math.random() * newPools.length);
        samples.push(newPools[index]);
      }

      // Check these samples against Redis
      for (const pool of samples) {
        // Which chunk would this pool be in?
        const chunkIndex = Math.floor(
          newPools.findIndex((p) => p.address === pool.address) /
            this.CHUNK_SIZE
        );

        if (chunkIndex < 0 || chunkIndex >= metadata.chunks) {
          // Can't find the chunk, data has changed
          return true;
        }

        const chunkKey = `${this.CHUNK_KEY_PREFIX}${source}:${chunkIndex}`;
        const chunkData = await this.redis.get(chunkKey); // Removed <string> type

        if (!chunkData) {
          // Chunk missing, data has changed
          return true;
        }

        // Parse chunk if it's a string
        const chunkPools =
          typeof chunkData === "string" ? JSON.parse(chunkData) : chunkData;

        const existingPool = chunkPools.find(
          (p: Pool) => p.address === pool.address
        );

        if (!existingPool) {
          // Pool not found, data has changed
          return true;
        }

        // Check if reserves have changed - the most common change
        if (pool.reserves && existingPool.reserves) {
          if (pool.reserves.join(",") !== existingPool.reserves.join(",")) {
            // Reserves changed, data has changed
            return true;
          }
        }
      }

      // No significant changes detected
      console.log(
        `No significant changes detected for ${source}, skipping Redis update`
      );
      return false;
    } catch (error) {
      console.error(`Error checking if data changed for ${source}:`, error);
      // If error occurred, assume data changed to be safe
      return true;
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

  async connect(): Promise<void> {
    // If already connected, return immediately
    if (this.db) return;

    // If a connection attempt is already in progress, wait for it to complete
    if (this.connectionInProgress) {
      await this.connectionInProgress;
      return;
    }

    // Start a new connection attempt and store the promise
    const connectionPromise = this._doConnect();
    this.connectionInProgress = connectionPromise;

    try {
      await connectionPromise;
    } finally {
      // Clear the connection promise when done (whether successful or failed)
      if (this.connectionInProgress === connectionPromise) {
        this.connectionInProgress = null;
      }
    }
  }

  private async _doConnect(): Promise<void> {
    try {
      console.log("Connecting to MongoDB...");

      // Check if we already have an active connection
      if (this.mongoClient && this.db) {
        try {
          // Ping the database to verify the connection is active
          await this.mongoClient.db().command({ ping: 1 });
          console.log("Reusing existing MongoDB connection");
          return;
        } catch (err) {
          console.log("Existing connection is invalid, creating a new one");
          // Continue to create a new connection
        }
      }

      // Close any existing client that might be in an invalid state
      if (this.mongoClient) {
        try {
          await this.mongoClient.close(true);
          this.mongoClient = null;
        } catch (err) {
          console.error("Error closing existing MongoDB client:", err);
        }
      }

      // Connect with proper options for connection pooling
      this.mongoClient = await MongoClient.connect(this.mongoUri, {
        maxPoolSize: 20,
        minPoolSize: 5,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 60000,
        waitQueueTimeoutMS: 10000,
      });

      const db = this.mongoClient.db();
      this.db = db.collection("pool_states");

      // Create indexes
      await this.db.createIndex({ address: 1 }, { unique: true });
      await this.db.createIndex({ lastUpdateTimestamp: 1 });
      await this.db.createIndex({ source: 1 });
      await this.db.createIndex({ source: 1, type: 1 }, { background: true });
      await this.db.createIndex(
        { source: 1, lastUpdateTimestamp: -1 },
        { background: true }
      );

      console.log("MongoDB connection established successfully");
    } catch (error) {
      console.error("Failed to connect to MongoDB:", error);
      // Ensure we clean up in case of connection failure
      if (this.mongoClient) {
        try {
          await this.mongoClient.close(true);
        } catch (err) {
          // Ignore errors during cleanup
        }
        this.mongoClient = null;
      }
      throw error;
    }
  }

  async addPool(pool: Pool): Promise<void> {
    try {
      const address = Address.parse(pool.address);
      this.poolAddresses.add(address.toString());

      // Get initial state
      const state = await this.fetchPoolState(pool);
      if (state) {
        await this.updatePoolState(state);
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

  private async updatePoolState(pool: Pool): Promise<void> {
    await this.db.updateOne(
      { address: pool.address },
      { $set: pool },
      { upsert: true }
    );

    this.emit("poolStateUpdated", pool);
  }

  public async updateBulkPoolStates(pools: Pool[]): Promise<void> {
    if (pools.length === 0) return;

    const startTime = Date.now();

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
            // CRITICAL FIX: Make sure we preserve all fields when updating
            // Get existing pool first
            const existingPool = poolMap.get(pool.address);

            if (existingPool) {
              // Merge the update with existing data instead of replacing everything
              poolMap.set(pool.address, {
                ...existingPool, // Keep all existing fields
                ...pool, // Apply updates
                assets: pool.assets || existingPool.assets, // Ensure assets are preserved
                reserves: pool.reserves || existingPool.reserves, // Ensure reserves are preserved
                stats: pool.stats || existingPool.stats, // Ensure stats are preserved
                lastUpdateTimestamp: Date.now(),
              });
            } else {
              // For new pools, just add them directly
              poolMap.set(pool.address, {
                ...pool,
                lastUpdateTimestamp: Date.now(),
              });
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

      // Start database update in the background
      this.updatePoolsDatabase(pools).catch((error) => {
        console.error("Background database update failed:", error);
      });

      return;
    } catch (error) {
      console.error("Redis update error:", error);
      // Continue with database update if Redis update fails
    }
  }

  // Database update method remains the same
  private async updatePoolsDatabase(pools: Pool[]): Promise<void> {
    const startTime = Date.now();

    const CHUNK_SIZE = 25;
    const chunks = [];

    for (let i = 0; i < pools.length; i += CHUNK_SIZE) {
      chunks.push(pools.slice(i, i + CHUNK_SIZE));
    }

    try {
      const PARALLEL_CHUNKS = 5;

      for (let i = 0; i < chunks.length; i += PARALLEL_CHUNKS) {
        const batchChunks = chunks.slice(i, i + PARALLEL_CHUNKS);
        const batchPromises = batchChunks.map(async (chunk) => {
          const addresses = chunk.map((pool) => pool.address);

          const existingPoolsArray = await this.db
            .find({
              address: { $in: addresses },
            })
            .toArray();

          const existingPools = new Map();
          for (const pool of existingPoolsArray) {
            existingPools.set(pool.address, pool);
          }

          const bulkOps = chunk.map((pool) => {
            const isExisting = existingPools.has(pool.address);
            const existingPool = existingPools.get(pool.address);

            if (isExisting) {
              const updateFields: any = {};

              updateFields.lastUpdateTimestamp =
                pool.lastUpdateTimestamp || Date.now();

              if (pool.reserves) updateFields.reserves = pool.reserves;
              if (pool.lastPrice) updateFields.lastPrice = pool.lastPrice;

              if (pool.source) updateFields.source = pool.source;

              if (pool.assets) updateFields.assets = pool.assets;
              if (pool.totalSupply) updateFields.totalSupply = pool.totalSupply;
              if (pool.type) updateFields.type = pool.type;
              if (pool.tradeFee) updateFields.tradeFee = pool.tradeFee;
              if (pool.stats) updateFields.stats = pool.stats;

              return {
                updateOne: {
                  filter: { address: pool.address },
                  update: { $set: updateFields },
                },
              };
            } else {
              return {
                insertOne: {
                  document: {
                    address: pool.address,
                    reserves: pool.reserves || [],
                    lastPrice: pool.lastPrice || { value: "0" },
                    lastUpdateTimestamp: pool.lastUpdateTimestamp || Date.now(),
                    source: pool.source || "unknown",
                    assets: pool.assets || [],
                    totalSupply: pool.totalSupply || "0",
                    type: pool.type || "unknown",
                    tradeFee: pool.tradeFee || "0",
                    stats: pool.stats || { fees: [], volume: [] },
                    lt: pool.lt || "0",
                  },
                },
              };
            }
          });

          const bulkWriteOptions = {
            ordered: false,
            wtimeout: 15000, // 15 second write timeout
          };

          return this.db.bulkWrite(bulkOps, bulkWriteOptions);
        });

        await Promise.all(batchPromises);
      }

      const duration = Date.now() - startTime;
    } catch (error) {
      console.error("Database update error:", error);
      throw error;
    }
  }

  // Function to convert StonFi pool data to our Pool format
  private async convertStonFiPool(
    stonfiPool: any,
    client?: StonApiClient
  ): Promise<Pool> {
    // Use provided client or create a new one if not provided
    const stonfiClient = client || new StonApiClient();

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

    // Create clients once and reuse them
    const dedustSDK = new DeDustClient({
      endpointUrl: "https://api.dedust.io",
    });

    const stonfiClient = new StonApiClient();

    this.isTracking = true;
    let consecutiveErrorCount = 0;

    // Define fast update function for real-time data
    const performFastUpdate = async () => {
      try {
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
            return;
          }
        }

        // Mark update in progress
        await this.redis.set("fastUpdateTimestamp", now, { ex: 10 });
        if (!this.db) {
          try {
            // Limit connection time to prevent hanging
            await Promise.race([
              this.connect(),
              new Promise((_, reject) =>
                setTimeout(
                  () => reject(new Error("DB connection timeout")),
                  3000
                )
              ),
            ]);
          } catch (connError) {
            console.warn(
              "DB connection timed out during fast update, proceeding without DB"
            );
          }
        }

        // Fetch from both DeDust and StonFi in parallel with timeouts
        const dedustPromise = Promise.race([
          dedustSDK.getPools().catch((err) => {
            console.error("Error fetching DeDust pools for fast update:", err);
            return [] as DeDustPool[];
          }),
          new Promise((resolve) =>
            setTimeout(() => {
              console.warn("DeDust API timeout, returning empty array");
              resolve([]);
            }, 5000)
          ),
        ]);

        const stonfiPromise = Promise.race([
          stonfiClient.getPools().catch((err) => {
            console.error("Error fetching StonFi pools for fast update:", err);
            return [] as StonFiPool[];
          }),
          new Promise((resolve) =>
            setTimeout(() => {
              console.warn("StonFi API timeout, returning empty array");
              resolve([]);
            }, 5000)
          ),
        ]);

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
                }
              }

              // Convert back to array and store in Redis using chunks
              const updatedPools = Array.from(poolMap.values());
              await this.storePoolsInChunks(source, updatedPools);

              console.log(
                `Updated Redis cache for ${source}: ${updatedCount} updated, ${addedCount} added, total: ${updatedPools.length}`
              );

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

        // Then update the database in the background (don't wait for it)
        const allPools = [...taggedDedustPools, ...stonfiPools];
        if (allPools.length > 0) {
          this.updatePoolsDatabase(allPools).catch((error) => {
            console.error("Background database update failed:", error);
          });
        }

        // Reset consecutive error count on successful update
        consecutiveErrorCount = 0;
      } catch (error) {
        console.error("Fast update error:", error);
        consecutiveErrorCount++;

        // Reconnect logic for consistent errors
        if (consecutiveErrorCount >= 20) {
          console.log(
            "Too many consecutive errors, attempting to reconnect to MongoDB..."
          );
          try {
            await this.disconnect();
            await this.connect();
            consecutiveErrorCount = 0;
          } catch (reconnectError) {
            console.error("Failed to reconnect:", reconnectError);
          }
        }
      }
    };

    // Function for full updates (complete metadata refresh)
    const performFullUpdate = async () => {
      try {
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
        // Make sure we have a valid database connection
        if (!this.db) {
          try {
            // Limit connection time to prevent hanging
            await Promise.race([
              this.connect(),
              new Promise((_, reject) =>
                setTimeout(
                  () => reject(new Error("DB connection timeout")),
                  5000
                )
              ),
            ]);
          } catch (connError) {
            console.warn(
              "DB connection timed out during full update, proceeding without DB"
            );
          }
        }

        // Create promises for both API requests with timeouts
        const dedustPromise = Promise.race([
          dedustSDK.getPools().catch((err) => {
            console.error("Error fetching DeDust pools for full update:", err);
            return [] as DeDustPool[]; // Return empty array on error
          }),
          new Promise((resolve) =>
            setTimeout(() => {
              console.warn(
                "DeDust API timeout during full update, returning empty array"
              );
              resolve([]);
            }, 8000)
          ),
        ]);

        const stonfiPromise = Promise.race([
          stonfiClient.getPools().catch((err) => {
            console.error("Error fetching StonFi pools for full update:", err);
            return [] as StonFiPool[]; // Return empty array on error
          }),
          new Promise((resolve) =>
            setTimeout(() => {
              console.warn(
                "StonFi API timeout during full update, returning empty array"
              );
              resolve([]);
            }, 8000)
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
                  return await this.convertStonFiPool(pool, stonfiClient);
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
          consecutiveErrorCount = 0;
        } else {
          console.warn("No pools found in this full update cycle");
        }

        console.log("Full update completed successfully");
      } catch (error) {
        console.error("Full update error:", error);
        consecutiveErrorCount++;
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

    // No need to start full update right away, it can happen later
    // We're just initializing the function references

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

      if (shouldUpdate) {
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

      if (shouldFullUpdate) {
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

  async getPool(address: string): Promise<Pool | null> {
    const result = await this.db.findOne({ address });

    if (!result) {
      return null;
    }

    return result as unknown as Pool;
  }

  async getAllPools(): Promise<Pool[]> {
    if (!this.db) {
      await this.connect();
    }
    const results = await this.db!.find({}).toArray();
    const pools = results.map((doc) => doc as unknown as Pool);
    return pools;
  }

  // Preload pools into memory cache
  async preloadRedisCache(source: string): Promise<Pool[]> {
    try {
      const pools = await this.getPoolsFromChunks(source);
      if (pools.length > 0) {
        return pools;
      }

      // If no pools found in Redis, get from database
      if (!this.db) {
        await this.connect();
      }

      const results = await this.db!.find({ source }).toArray();
      const dbPools = results.map((doc) => doc as unknown as Pool);

      if (dbPools.length > 0) {
        // Store in Redis chunks for future use
        await this.storePoolsInChunks(source, dbPools);
      }

      return dbPools;
    } catch (error) {
      console.error(`Error preloading Redis cache for ${source}:`, error);
      return [];
    }
  }

  // Modified method to accept skipUpdate parameter
  async getLatestPools(
    source: string,
    skipUpdate: boolean = false
  ): Promise<Pool[]> {
    // Check if it's time to update first, passing the skipUpdate parameter
    await this.triggerUpdateIfNeeded(skipUpdate);

    try {
      // Get pools from chunks
      const pools = await this.getPoolsFromChunks(source);
      if (pools.length > 0) {
        // Verify pools have the minimum required data structure
        const validPools = pools.filter(
          (p) =>
            p &&
            p.address &&
            ((p.reserves && p.reserves.length > 0) ||
              (p.assets && p.assets.length > 0))
        );

        if (validPools.length > 0) {
          return pools;
        }
      }
    } catch (error) {
      console.error(
        `Error getting latest pools from Redis for ${source}:`,
        error
      );
    }

    // Fall back to database if Redis fails or has no data
    try {
      if (!this.db) {
        await this.connect();
      }

      const results = await this.db.find({ source }).toArray();
      const pools = results.map((doc) => doc as unknown as Pool);

      // Store in Redis for future use
      if (pools.length > 0) {
        try {
          await this.storePoolsInChunks(source, pools);
        } catch (redisError) {
          console.error(
            `Error storing pools in Redis for ${source}:`,
            redisError
          );
        }
      }

      return pools;
    } catch (error) {
      console.error(`Error fetching pools from database for ${source}:`, error);
      return [];
    }
  }

  async getPoolsBySource(source: string): Promise<Pool[]> {
    // Simply retrieve from chunks/Redis
    try {
      const pools = await this.getPoolsFromChunks(source);

      // If no pools in Redis chunks, fall back to database
      if (pools.length === 0) {
        if (!this.db) {
          await this.connect();
        }
        const results = await this.db!.find({ source }).toArray();
        return results.map((doc) => doc as unknown as Pool);
      }

      return pools;
    } catch (error) {
      console.error(`Error getting pools for ${source}:`, error);

      // Fallback if everything fails
      if (!this.db) {
        await this.connect();
      }
      const results = await this.db!.find({ source }).toArray();
      return results.map((doc) => doc as unknown as Pool);
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

  async disconnect(): Promise<void> {
    if (this.mongoClient) {
      try {
        console.log("Closing MongoDB connection...");
        await this.mongoClient.close(true);
        console.log("MongoDB connection closed successfully");
      } catch (error) {
        console.error("Error closing MongoDB connection:", error);
      } finally {
        this.mongoClient = null;
        this.db = null;
      }
    }
  }

  // Helper method to refresh pools from database to Redis
  private async refreshPoolsFromDatabase(source: string): Promise<void> {
    try {
      if (!this.db) {
        await this.connect();
      }

      const results = await this.db.find({ source }).toArray();
      const pools = results.map((doc) => doc as unknown as Pool);

      if (pools.length > 0) {
        // Update Redis cache using chunks
        await this.storePoolsInChunks(source, pools);
      }
    } catch (error) {
      console.error(`Background refresh failed for ${source}:`, error);
      throw error;
    }
  }

  async fixIncompleteRecords(): Promise<void> {
    console.log("Starting database fix for incomplete records...");

    try {
      // Make sure we have a database connection
      if (!this.db) {
        await this.connect();
      }

      // Find all incomplete records
      const incompleteRecords = await this.db
        .find({
          $or: [
            { source: null },
            { lastUpdateTimestamp: null },
            { assets: { $exists: false } },
          ],
        })
        .toArray();

      console.log(
        `Found ${incompleteRecords.length} incomplete records to fix`
      );

      if (incompleteRecords.length === 0) {
        console.log("No incomplete records found.");
        return;
      }

      // Force a full update on startup
      let dedustPools: any[] = [];
      let stonfiPools: any[] = [];

      try {
        const dedustSDK = new DeDustClient({
          endpointUrl: "https://api.dedust.io",
        });
        dedustPools = await dedustSDK.getPools();
      } catch (err) {
        console.error("Failed to fetch DeDust pools:", err);
      }

      try {
        const stonfiClient = new StonApiClient();
        stonfiPools = await stonfiClient.getPools();
      } catch (err) {
        console.error("Failed to fetch StonFi pools:", err);
      }

      // Process pools into complete records
      const allPools: Pool[] = [];

      // Process DeDust pools
      const taggedDedustPools = dedustPools.map((pool) => ({
        ...pool,
        source: "dedust",
        lastUpdateTimestamp: Date.now(),
      }));
      allPools.push(...taggedDedustPools);

      // Process StonFi pools
      if (stonfiPools && Array.isArray(stonfiPools)) {
        for (const pool of stonfiPools) {
          if (pool.deprecated) continue;

          try {
            const convertedPool = await this.convertStonFiPool(pool);
            if (convertedPool) {
              allPools.push(convertedPool);
            }
          } catch (err) {
            console.error(`Error converting StonFi pool ${pool.address}:`, err);
          }
        }
      }

      // Create a map for quick lookup by address
      const poolMap = new Map<string, Pool>();
      for (const pool of allPools) {
        poolMap.set(pool.address, pool);
      }

      // Update each incomplete record
      let fixedCount = 0;
      let defaultsCount = 0;

      for (const record of incompleteRecords) {
        const address = record.address;
        const completeData = poolMap.get(address);

        if (completeData) {
          // Update with complete data from APIs
          await this.db.updateOne({ _id: record._id }, { $set: completeData });
          fixedCount++;
        } else {
          // Set default values if no API data found
          await this.db.updateOne(
            { _id: record._id },
            {
              $set: {
                source: record.source || "unknown",
                lastUpdateTimestamp: Date.now(),
                assets: record.assets || [],
                totalSupply: record.totalSupply || "0",
                type: record.type || "unknown",
                tradeFee: record.tradeFee || "0",
                stats: record.stats || { fees: [], volume: [] },
              },
            }
          );
          defaultsCount++;
        }
      }
    } catch (error) {
      console.error("Error fixing incomplete records:", error);
      throw error;
    }
  }

  public async forceRefreshPools(source?: string): Promise<void> {
    if (source) {
      // Clear specific source from Redis
      try {
        // Clear all chunks for this source
        const metadataKey = `pools:meta:${source}`;
        const metadataJson = await this.redis.get<string>(metadataKey);

        if (metadataJson) {
          const metadata = JSON.parse(metadataJson);
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

      // Immediately repopulate from database
      await this.getPoolsBySource(source);
    } else {
      // Clear all sources from Redis
      try {
        // Get all chunk metadata keys
        const metaKeys = await this.redis.keys("pools:meta:*");

        // Delete all chunks for each source
        for (const metaKey of metaKeys) {
          const metadataJson = await this.redis.get<string>(metaKey);
          const source = metaKey.split(":")[2]; // Extract source from key

          if (metadataJson) {
            const metadata = JSON.parse(metadataJson);
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
      process.env.TON_ENDPOINT,
      process.env.MONGODB_URI
    );
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
      // Connect to MongoDB - limit connection timeout
      try {
        await Promise.race([
          this.tracker.connect(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("MongoDB connection timeout")),
              5000
            )
          ),
        ]);
      } catch (connError) {
        console.warn(
          "MongoDB connection timed out, continuing with initialization"
        );
        // Continue even if MongoDB connection times out
      }

      // Do minimal initialization to get the service working
      this.initialized = true;

      // Start tracking but don't wait for the initial updates
      const trackingPromise = this.tracker.startTracking().catch((error) => {
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

  // Modified method to accept and pass skipUpdate parameter
  async getPoolsBySource(
    source: string,
    skipUpdate: boolean = false
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

  async fixDatabase(): Promise<void> {
    await this.tracker.fixIncompleteRecords();
  }

  async cleanup(): Promise<void> {
    await this.tracker.stopTracking();
    await this.tracker.disconnect();
    this.initialized = false;
    this.initializationPromise = null;
  }
}

export { PoolTracker, PoolService };
