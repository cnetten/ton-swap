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
  source?: string; // Add source field to track where the pool comes from
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
    private readonly mongoUri: string = "mongodb://localhost:27017/ton_pools"
  ) {
    super();
    this.tonClient = new TonClient4({ endpoint: tonEndpoint });
    this.poolAddresses = new Set();
  }

  async connect(): Promise<void> {
    if (this.db) return;
    try {
      this.mongoClient = await MongoClient.connect(this.mongoUri);
      const db = this.mongoClient.db();
      this.db = db.collection("pool_states");

      // Create indexes
      await this.db.createIndex({ address: 1 }, { unique: true });
      await this.db.createIndex({ lastUpdateTimestamp: 1 });
      await this.db.createIndex({ source: 1 }); // Index for source field

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

  private async updateBulkPoolStates(pools: Pool[]): Promise<void> {
    if (pools.length === 0) return;

    // Bulk write operation for much faster updates
    const bulkOps = pools.map((pool) => ({
      updateOne: {
        filter: { address: pool.address },
        update: { $set: pool },
        upsert: true,
      },
    }));

    try {
      await this.db.bulkWrite(bulkOps, { ordered: false });

      // Emit events in a separate non-blocking process
      setImmediate(() => {
        pools.forEach((pool) => this.emit("poolStateUpdated", pool));
      });
    } catch (error) {
      console.error("Bulk update error:", error);
    }
  }

  // Function to convert StonFi pool data to our Pool format
  private convertStonFiPool(stonfiPool: StonFiPool): Pool {
    // Create token metadata for token0 and token1
    // Note: In a real implementation, you'd likely fetch token metadata from a registry
    const token0Metadata: TokenMetadata = {
      name: "Unknown Token 0",
      symbol: "UNK0",
      decimals: 9, // Default decimals for TON tokens
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
      lt: "0", // Default value
      totalSupply: stonfiPool.lp_total_supply,
      type: "stonfi", // Mark as StonFi pool
      tradeFee: stonfiPool.lp_fee,
      assets: assets,
      lastPrice: {
        // You may calculate this based on reserves
        value: "0",
      },
      reserves: [stonfiPool.reserve0, stonfiPool.reserve1],
      stats: {
        fees: [
          stonfiPool.collected_token0_protocol_fee,
          stonfiPool.collected_token1_protocol_fee,
        ],
        volume: ["0", "0"], // Default values
      },
      source: "stonfi", // Mark source as StonFi
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
          console.log("getting here");
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
    }, 15000); // Update every 15 seconds
  }

  async stopTracking(): Promise<void> {
    if (this.trackingInterval) {
      clearInterval(this.trackingInterval);
      this.trackingInterval = null;
    }
    this.isTracking = false;
  }

  async getPool(address: string): Promise<Pool | null> {
    return await this.db.findOne({ address });
  }

  async getAllPools(): Promise<Pool[]> {
    if (!this.db) {
      await this.connect();
    }
    return await this.db!.find({}).toArray();
  }

  // Get pools by source
  async getPoolsBySource(source: string): Promise<Pool[]> {
    if (!this.db) {
      await this.connect();
    }
    return await this.db!.find({ source }).toArray();
  }

  async disconnect(): Promise<void> {
    if (this.mongoClient) {
      await this.mongoClient.close();
    }
  }
}

// Service to manage pool tracking
class PoolService {
  private static instance: PoolService;
  private tracker: PoolTracker;
  private knownPools: Map<string, Pool> = new Map();

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

  async initialize(pools: Pool[]): Promise<void> {
    // Connect to MongoDB
    await this.tracker.connect();

    // Store pool metadata and start tracking
    for (const pool of pools) {
      this.knownPools.set(pool.address, pool);
      await this.tracker.addPool(pool);
    }

    // Start tracking
    await this.tracker.startTracking();
  }

  async getPools(): Promise<Pool[]> {
    return await this.tracker.getAllPools();
  }

  // Get pools by source
  async getPoolsBySource(source: string): Promise<Pool[]> {
    return await this.tracker.getPoolsBySource(source);
  }

  async cleanup(): Promise<void> {
    await this.tracker.stopTracking();
    await this.tracker.disconnect();
  }
}

export { PoolTracker, PoolService };
