/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { TonClient4, Address } from "@ton/ton";
import { MongoClient, Collection } from "mongodb";
import { EventEmitter } from "events";
import { DeDustClient } from "@dedust/sdk";
import { StonApiClient } from "@ston-fi/api";

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

// Add interface for StonFi Pool structure
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

interface StonFiPoolsResponse {
  pool_list: StonFiPool[];
}

class PoolTracker extends EventEmitter {
  private tonClient: TonClient4;
  private db: Collection | null = null;
  private poolAddresses: Set<string>;
  private isTracking: boolean = false;
  private trackingInterval: NodeJS.Timeout | null = null;
  private readonly TRACK_INTERVAL = 5000; // 5 seconds
  private mongoClient: MongoClient | null = null;
  private trackingIntervals: NodeJS.Timeout[] = [];

  // Track if a connection is in progress to prevent multiple simultaneous connection attempts
  private connectionInProgress: Promise<void> | null = null;

  constructor(
    private readonly tonEndpoint: string = "https://mainnet-v4.tonhubapi.com",
    private readonly mongoUri: string = process.env.MONGO_CONNECTION
  ) {
    super();
    this.tonClient = new TonClient4({ endpoint: tonEndpoint });
    this.poolAddresses = new Set();
  }

  private inMemoryPools: Map<string, Pool[]> = new Map();
  private lastUpdateTime: Map<string, number> = new Map();

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

    // Update in-memory pools first (this is fast)
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

      // Update in-memory pools for each source
      for (const [source, sourcePools] of poolsBySource.entries()) {
        // Get current pools for this source (or empty array)
        const currentPools = this.inMemoryPools.get(source) || [];

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

        // Convert back to array and store
        const updatedPools = Array.from(poolMap.values());
        this.inMemoryPools.set(source, updatedPools);
        this.lastUpdateTime.set(source, Date.now());
      }

      // Emit events immediately for in-memory updates
      pools.forEach((pool) => this.emit("poolStateUpdated", pool));

      // For instant operation, we can return here and let database updates happen asynchronously
      const inMemoryDuration = Date.now() - startTime;

      // Start database update in the background
      this.updatePoolsDatabase(pools).catch((error) => {
        console.error("Background database update failed:", error);
      });

      return;
    } catch (error) {
      console.error("In-memory update error:", error);
      // Continue with database update if in-memory update fails
    }
  }

  // Separate method for database operations
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

    // Keep track of last full update time
    let lastFullUpdateTime = 0;
    const FULL_UPDATE_INTERVAL = 60000; // 30 seconds between full updates
    const FAST_UPDATE_INTERVAL = 3000; // 3 seconds between fast updates

    let fullUpdateInProgress = false;
    let fastUpdateInProgress = false;
    let consecutiveErrorCount = 0;

    const fastUpdateInterval = setInterval(async () => {
      // Skip if a fast update is already running
      if (fastUpdateInProgress) {
        return;
      }
      const CACHE_MAX_AGE = 15 * 1000; // 15 seconds max age
      // Skip if it's time for a full update and one is about to start
      const now = Date.now();
      if (
        now - lastFullUpdateTime >= FULL_UPDATE_INTERVAL &&
        !fullUpdateInProgress
      ) {
        return;
      }

      for (const [source, lastUpdate] of this.lastUpdateTime.entries()) {
        if (now - lastUpdate > CACHE_MAX_AGE) {
          console.log(`Detected stale cache for ${source}, forcing refresh`);
          this.forceRefreshPools(source);
        }
      }

      fastUpdateInProgress = true;

      try {
        if (!this.db) {
          await this.connect();
        }

        // Fetch from both DeDust and StonFi in parallel
        const [dedustPools, stonfiResponse] = await Promise.all([
          dedustSDK.getPools().catch((err) => {
            console.error("Error fetching DeDust pools for fast update:", err);
            return [];
          }),
          stonfiClient.getPools().catch((err) => {
            console.error("Error fetching StonFi pools for fast update:", err);
            return [];
          }),
        ]);

        // Process DeDust pools (just the price-critical data)
        const pricePools = dedustPools.map((pool) => ({
          address: pool.address,
          reserves: pool.reserves,
          lastPrice: pool.lastPrice,
          source: "dedust",
          lastUpdateTimestamp: Date.now(),
        })) as unknown as Pool[];

        // Process StonFi pools (price-critical data only)
        if (stonfiResponse && Array.isArray(stonfiResponse)) {
          const stonfiPricePools = stonfiResponse
            .filter((pool) => !pool.deprecated)
            .map((pool) => ({
              address: pool.address,
              reserves: [pool.reserve0, pool.reserve1],
              source: "stonfi",
              lastUpdateTimestamp: Date.now(),
            })) as unknown as Pool[];

          // Combine pools from both sources
          pricePools.push(...stonfiPricePools);
        }

        // Fast update in-memory only to maintain responsiveness
        if (pricePools.length > 0) {
          // Always update in-memory data first for immediate use
          try {
            // Group pools by source
            const poolsBySource = new Map<string, Pool[]>();
            for (const pool of pricePools) {
              if (pool.source) {
                if (!poolsBySource.has(pool.source)) {
                  poolsBySource.set(pool.source, []);
                }
                poolsBySource.get(pool.source)!.push(pool);
              }
            }

            // Update in-memory pools for each source
            for (const [source, sourcePools] of poolsBySource.entries()) {
              // Get current pools for this source (or empty array)
              const currentPools = this.inMemoryPools.get(source) || [];

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
                  // Merge the update with existing data instead of replacing everything
                  poolMap.set(pool.address, {
                    ...existingPool,
                    ...pool,
                    assets: pool.assets || existingPool.assets,
                    reserves: pool.reserves || existingPool.reserves,
                    stats: pool.stats || existingPool.stats,
                    lastUpdateTimestamp: Date.now(),
                  });
                } else {
                  poolMap.set(pool.address, {
                    ...pool,
                    lastUpdateTimestamp: Date.now(),
                  });
                }
              }

              // Convert back to array and store
              const updatedPools = Array.from(poolMap.values());
              this.inMemoryPools.set(source, updatedPools);
              this.lastUpdateTime.set(source, Date.now());
            }

            // Emit events for in-memory updates
            pricePools.forEach((pool) => this.emit("poolStateUpdated", pool));

            if (!fullUpdateInProgress) {
              this.updatePoolsDatabase(pricePools).catch((error) => {
                console.error("Background database update failed:", error);
              });
              console.log(
                `Fast update: Updated ${pricePools.length} pools in memory and database`
              );
            } else {
              console.log(
                `Fast update: Updated ${pricePools.length} pools in memory only (full update in progress)`
              );
            }
          } catch (error) {
            console.error("In-memory update error:", error);
          }

          consecutiveErrorCount = 0;
        }
      } catch (error) {
        console.error("Fast price update error:", error);
        consecutiveErrorCount++;

        // Reconnect logic for consistent errors (shared with full update)
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
      } finally {
        // Always mark the fast update as completed
        fastUpdateInProgress = false;
      }
    }, FAST_UPDATE_INTERVAL);

    // Set up full update interval (complete database updates)
    const fullUpdateInterval = setInterval(async () => {
      const now = Date.now();
      // Only run full update if it's time and one isn't already in progress
      if (
        now - lastFullUpdateTime < FULL_UPDATE_INTERVAL ||
        fullUpdateInProgress
      ) {
        return;
      }

      fullUpdateInProgress = true;
      const cycleStartTime = Date.now();

      try {
        // Make sure we have a valid database connection
        if (!this.db) {
          await this.connect();
        }

        // Create promises for both API requests
        const dedustPromise = dedustSDK.getPools().catch((err) => {
          console.error("Error fetching DeDust pools for full update:", err);
          return []; // Return empty array on error
        });

        const stonfiPromise = stonfiClient.getPools().catch((err) => {
          console.error("Error fetching StonFi pools for full update:", err);
          return []; // Return empty array on error
        });

        // Wait for both API calls in parallel
        const [dedustPools, stonfiResponse] = await Promise.all([
          dedustPromise,
          stonfiPromise,
        ]);

        console.log(
          `Full update: Received ${dedustPools.length} pools from DeDust and ${
            stonfiResponse?.length || 0
          } from StonFi`
        );

        // Process DeDust pools with complete data
        const taggedDedustPools = dedustPools.map((pool) => ({
          ...pool,
          source: "dedust",
          lastUpdateTimestamp: Date.now(),
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

        const cycleDuration = Date.now() - cycleStartTime;
        console.log(`Full update cycle completed in ${cycleDuration}ms`);

        // Update the timestamp only after successful completion
        lastFullUpdateTime = Date.now();
      } catch (error) {
        console.error("Full update error:", error);
        consecutiveErrorCount++;
      } finally {
        // Always mark the full update as completed
        fullUpdateInProgress = false;
      }
    }, Math.floor(FULL_UPDATE_INTERVAL / 2)); // Check twice as often to account for potential delays

    // Store intervals for cleanup
    this.trackingIntervals = [fastUpdateInterval, fullUpdateInterval];

    console.log("Dual-cycle pool tracking started successfully");
  }

  async stopTracking(): Promise<void> {
    if (this.trackingIntervals) {
      for (const interval of this.trackingIntervals) {
        clearInterval(interval);
      }
      this.trackingIntervals = [];
    }
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

  async getPoolsBySource(source: string): Promise<Pool[]> {
    // Initialize database connection if needed
    if (!this.db) {
      await this.connect();
    }

    // Check if we have in-memory pools for this source
    if (this.inMemoryPools.has(source)) {
      const pools = this.inMemoryPools.get(source)!;
      const lastUpdate = this.lastUpdateTime.get(source) || 0;
      const ageInSeconds = (Date.now() - lastUpdate) / 1000;

      return pools;
    }

    const startTime = Date.now();

    const results = await this.db!.find({ source }).toArray();
    const pools = results.map((doc) => doc as unknown as Pool);

    // Store in memory for future use
    this.inMemoryPools.set(source, pools);
    this.lastUpdateTime.set(source, Date.now());

    return pools;
  }

  public filterPoolsByLiquidity(
    source: string,
    minReserve: number,
    maxTradeFee: number
  ): Pool[] {
    // Get pools for this source
    const pools = this.inMemoryPools.get(source) || [];

    const startTime = Date.now();
    const filteredPools = pools.filter((pool) => {
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

    return filteredPools;
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

  async getLatestPools(source: string): Promise<Pool[]> {
    // Check if we have fresh in-memory data (less than 10 seconds old)
    if (this.inMemoryPools.has(source)) {
      const pools = this.inMemoryPools.get(source) || [];
      const lastUpdate = this.lastUpdateTime.get(source) || 0;
      const ageInSeconds = (Date.now() - lastUpdate) / 1000;

      // Only use in-memory data if it's fresh AND has content
      if (ageInSeconds < 10 && pools.length > 0) {
        // Verify pools have required data
        const validPools = pools.filter(
          (p) =>
            p &&
            p.assets &&
            p.assets.length > 0 &&
            p.reserves &&
            p.reserves.length > 0
        );

        if (validPools.length > 0) {
          return pools;
        } else {
          console.log(
            `In-memory pools for ${source} missing critical data, falling back to database`
          );
        }
      }
    } else {
      console.log(`No in-memory pools found for ${source}`);
    }

    // Fall back to database if needed
    return this.getPoolsBySource(source);
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

      // Check for any remaining incomplete records
      const remainingCount = await this.db.countDocuments({
        $or: [
          { source: null },
          { lastUpdateTimestamp: null },
          { assets: { $exists: false } },
        ],
      });
    } catch (error) {
      console.error("Error fixing incomplete records:", error);
      throw error;
    }
  }
  public async forceRefreshPools(source?: string): Promise<void> {
    if (source) {
      // Clear specific source
      this.inMemoryPools.delete(source);
      this.lastUpdateTime.delete(source);
      console.log(`Forced refresh of ${source} pools cache`);

      // Immediately repopulate from database
      await this.getPoolsBySource(source);
    } else {
      // Clear all sources
      const sources = Array.from(this.inMemoryPools.keys());
      this.inMemoryPools.clear();
      this.lastUpdateTime.clear();
      console.log("Forced refresh of all pools cache");

      // Immediately repopulate all sources
      for (const src of sources) {
        await this.getPoolsBySource(src);
      }
    }
  }
}

class PoolService {
  private static instance: PoolService;
  private tracker: PoolTracker;
  private knownPools: Map<string, Pool> = new Map();
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
    return this.initializationPromise;
  }

  private async _doInitialize(pools: Pool[]): Promise<void> {
    try {
      const startTime = Date.now();

      // Connect to MongoDB
      await this.tracker.connect();

      // Preload common data to warm up the cache
      const sources = ["dedust", "stonfi"];
      for (const source of sources) {
        // This will populate the in-memory cache
        await this.tracker.getPoolsBySource(source);
      }

      // Store pool metadata if provided
      if (pools.length > 0) {
        await this.tracker.updateBulkPoolStates(pools);
      }

      // Start tracking with a proper error handler
      await this.tracker.startTracking();

      this.initialized = true;
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

  async getPoolsBySource(source: string): Promise<Pool[]> {
    // Ensure initialization before getting pools
    if (!this.initialized) {
      await this.initialize();
    }
    return await this.tracker.getLatestPools(source);
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
