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
  collected_token0_protocol_fee: string;
  collected_token1_protocol_fee: string;
  deprecated: boolean;
  lp_account_address: string;
  lp_balance: string;
  lp_fee: string;
  lp_price_usd: string;
  lp_total_supply: string;
  lp_total_supply_usd: string;
  lp_wallet_address: string;
  popularity_index: number;
  protocol_fee: string;
  protocol_fee_address: string;
  ref_fee: string;
  reserve0: string;
  reserve1: string;
  router_address: string;
  token0_address: string;
  token0_balance: string;
  token1_address: string;
  token1_balance: string;
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
    if (this.db) return;
    try {
      this.mongoClient = await MongoClient.connect(this.mongoUri, {
        maxPoolSize: 50, // Maximum number of connections in the pool
        minPoolSize: 5, // Minimum number of connections to maintain
      });
      const db = this.mongoClient.db();
      this.db = db.collection("pool_states");

      // Create indexes
      await this.db.createIndex({ address: 1 }, { unique: true });
      await this.db.createIndex({ lastUpdateTimestamp: 1 });
      await this.db.createIndex({ source: 1 }); // Index for source field
      await this.db.createIndex({ source: 1, type: 1 }, { background: true });
      await this.db.createIndex(
        { source: 1, lastUpdateTimestamp: -1 },
        { background: true }
      );
      console.log("Connected to MongoDB successfully");
    } catch (error) {
      console.error("Failed to connect to MongoDB:", error);
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
        poolMap.set(pool.address, pool);
      }

      // Convert back to array and store
      const updatedPools = Array.from(poolMap.values());
      this.inMemoryPools.set(source, updatedPools);
      this.lastUpdateTime.set(source, Date.now());

      console.log(
        `Updated in-memory ${source} pools: ${updatedPools.length} total`
      );
    }

    // Proceed with database update
    const bulkOps = pools.map((pool) => ({
      updateOne: {
        filter: { address: pool.address },
        update: { $set: pool },
        upsert: true,
      },
    }));

    try {
      await this.db.bulkWrite(bulkOps, { ordered: false });
      // Emit events
      setImmediate(() => {
        pools.forEach((pool) => this.emit("poolStateUpdated", pool));
      });
    } catch (error) {
      console.error("Bulk update error:", error);
    }
  }

  // Function to convert StonFi pool data to our Pool format
  private convertStonFiPool(stonfiPool: any): Pool {
    // Create token metadata for token0 and token1
    const token0Metadata: TokenMetadata = {
      name: "Unknown Token 0",
      symbol: "UNK0",
      decimals: 9,
    };

    const token1Metadata: TokenMetadata = {
      name: "Unknown Token 1",
      symbol: "UNK1",
      decimals: 9,
    };

    // Create token assets
    const assets: TokenAsset[] = [
      {
        type: "token",
        address: stonfiPool.token0_address,
        metadata: token0Metadata,
      },
      {
        type: "token",
        address: stonfiPool.token1_address,
        metadata: token1Metadata,
      },
    ];

    // Create Pool object
    return {
      address: stonfiPool.address,
      lt: "0",
      totalSupply: stonfiPool.lp_total_supply,
      type: "stonfi",
      tradeFee: stonfiPool.lp_fee,
      assets: assets,
      lastPrice: {
        value: "0",
      },
      reserves: [stonfiPool.reserve0, stonfiPool.reserve1],
      stats: {
        fees: [
          stonfiPool.collected_token0_protocol_fee,
          stonfiPool.collected_token1_protocol_fee,
        ],
        volume: ["0", "0"],
      },
      source: "stonfi",
      lastUpdateTimestamp: Date.now(),
    };
  }

  async startTracking(): Promise<void> {
    if (this.isTracking) return;
    const dedustSDK = new DeDustClient({
      endpointUrl: "https://api.dedust.io",
    });

    const stonfiClient = new StonApiClient();

    this.isTracking = true;
    this.trackingInterval = setInterval(async () => {
      try {
        // Fetch pools from DeDust
        const dedustPools = await dedustSDK.getPools();
        // Add source field to track the origin
        const taggedDedustPools = dedustPools.map((pool) => ({
          ...pool,
          source: "dedust",
          lastUpdateTimestamp: Date.now(),
        }));

        // Fetch pools from StonFi
        const stonfiResponse = await stonfiClient.getPools();
        let stonfiPools: Pool[] = [];

        // Check if the response matches expected structure
        if (stonfiResponse) {
          // Convert StonFi pools to our format
          stonfiPools = stonfiResponse.map((pool) =>
            this.convertStonFiPool(pool)
          );
        } else {
          console.error("Unexpected StonFi response format:");
        }

        // Combine pools from both sources
        const allPools = [...taggedDedustPools, ...stonfiPools];

        // Update all pools in a single bulk operation
        await this.updateBulkPoolStates(allPools);
        console.log(
          `Updated ${taggedDedustPools.length} DeDust pools and ${stonfiPools.length} StonFi pools`
        );
      } catch (error) {
        console.error("Pools update error:", error);
      }
    }, 15000);
  }

  async stopTracking(): Promise<void> {
    if (this.trackingInterval) {
      clearInterval(this.trackingInterval);
      this.trackingInterval = null;
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

      console.log(
        `Using ${
          pools.length
        } in-memory ${source} pools (${ageInSeconds.toFixed(1)}s old)`
      );
      return pools;
    }

    // If not in memory, load from database
    console.log(`No in-memory pools for ${source}, loading from database...`);
    const startTime = Date.now();

    const results = await this.db!.find({ source }).toArray();
    const pools = results.map((doc) => doc as unknown as Pool);

    // Store in memory for future use
    this.inMemoryPools.set(source, pools);
    this.lastUpdateTime.set(source, Date.now());

    console.log(
      `Loaded ${pools.length} ${source} pools from database in ${
        Date.now() - startTime
      }ms`
    );
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

      // Check trade fee
      const tradeFee = parseFloat(pool.tradeFee || "0");
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

    console.log(
      `Filtered ${pools.length} ${source} pools to ${filteredPools.length} in ${
        Date.now() - startTime
      }ms`
    );
    return filteredPools;
  }

  async disconnect(): Promise<void> {
    if (this.mongoClient) {
      await this.mongoClient.close();
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
      console.log("Starting PoolService initialization...");
      const startTime = Date.now();

      // Connect to MongoDB
      await this.tracker.connect();

      // Preload common data to warm up the cache
      const sources = ["dedust", "stonfi"];
      for (const source of sources) {
        // This will populate the in-memory cache
        await this.tracker.getPoolsBySource(source);
        console.log(`Preloaded ${source} pools into cache`);
      }

      // Store pool metadata if provided
      if (pools.length > 0) {
        await this.tracker.updateBulkPoolStates(pools);
      }

      // Start tracking with a proper error handler
      await this.tracker.startTracking();

      this.initialized = true;
      console.log(
        `PoolService initialization completed in ${Date.now() - startTime}ms`
      );
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

  // Get pools by source with initialization check
  async getPoolsBySource(source: string): Promise<Pool[]> {
    // Ensure initialization before getting pools
    if (!this.initialized) {
      await this.initialize();
    }
    return await this.tracker.getPoolsBySource(source);
  }

  public getTracker(): PoolTracker {
    return this.tracker;
  }

  async cleanup(): Promise<void> {
    await this.tracker.stopTracking();
    await this.tracker.disconnect();
    this.initialized = false;
    this.initializationPromise = null;
  }
}

export { PoolTracker, PoolService };
