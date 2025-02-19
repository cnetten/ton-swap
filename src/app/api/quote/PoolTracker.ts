import { TonClient4, Address } from "@ton/ton";
import { MongoClient, Collection } from "mongodb";
import { EventEmitter } from "events";
import { DeDustClient } from "@dedust/sdk";

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
}

class PoolTracker extends EventEmitter {
  private tonClient: TonClient4;
  private db: Collection | null = null;
  private poolAddresses: Set<string>;
  private isTracking: boolean = false;
  private trackingInterval: NodeJS.Timeout | null = null;
  private readonly TRACK_INTERVAL = 5000; // 1 second
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

  async startTracking(): Promise<void> {
    if (this.isTracking) return;
    const dedustSDK = new DeDustClient({
      endpointUrl: "https://api.dedust.io",
    });

    this.isTracking = true;
    this.trackingInterval = setInterval(async () => {
      try {
        // Fetch all pools from Dedust SDK
        const pools = await dedustSDK.getPools();

        // Update all pools in a single bulk operation
        await this.updateBulkPoolStates(pools);
        console.log(`Updated ${pools.length} pools`);
      } catch (error) {
        console.error("Pools update error:", error);
      }
    }, 15000); // Update every 30 seconds
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

  async cleanup(): Promise<void> {
    await this.tracker.stopTracking();
    await this.tracker.disconnect();
  }
}

export { PoolTracker, PoolService };
