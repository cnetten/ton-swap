import { DeDustClient } from "@dedust/sdk";
import { PoolService } from "./quote/PoolTracker";

export async function initializePoolService() {
  // Prevent multiple initializations in development
  // if (process.env.NODE_ENV === "development" && global.poolServiceInitialized) {
  //   return;
  // }

  try {
    console.log("Initializing pool service...");
    const poolService = PoolService.getInstance();

    // Check if already initialized
    if (poolService.isInitialized()) {
      console.log("Pool service already initialized");

      // Even if initialized, check pool health to ensure data is fresh
      const tracker = poolService.getTracker();
      const sources = ["dedust", "stonfi"];

      // Force refresh pools from all sources
      for (const source of sources) {
        await tracker.forceRefreshPools(source);
      }

      return;
    }

    // Fetch initial pools from DeDust
    const dedustSDK = new DeDustClient({
      endpointUrl: "https://api.dedust.io",
    });

    console.log("Fetching initial pools from DeDust...");
    const initialPools = await dedustSDK.getPools();
    console.log(`Fetched ${initialPools.length} initial pools from DeDust`);

    // Initialize pool service with initial pools
    console.log("Initializing pool service with initial data...");
    await poolService.initialize(initialPools);

    // Ensure StonFi pools are also loaded
    console.log("Preloading all pool sources...");
    const sources = ["dedust", "stonfi"];
    for (const source of sources) {
      await poolService.getPoolsBySource(source);
    }

    // Validate pool data quality
    const tracker = poolService.getTracker();
    const dedustCount = tracker.filterPoolsByLiquidity(
      "dedust",
      100000,
      0.5
    ).length;
    const stonfiCount = tracker.filterPoolsByLiquidity(
      "stonfi",
      100000,
      0.5
    ).length;

    console.log(
      `Initialized with ${dedustCount} DeDust pools and ${stonfiCount} StonFi pools`
    );

    if (dedustCount < 10 || stonfiCount < 10) {
      console.warn("Suspiciously low pool count, forcing refresh");
      await tracker.forceRefreshPools();
    }

    if (process.env.NODE_ENV === "development") {
      global.poolServiceInitialized = true;
    }

    console.log("Pool service initialization complete");
  } catch (error) {
    console.error("Failed to initialize pool service:", error);
    // Don't rethrow to prevent initialization failures from breaking the app
    // But do ensure we don't mark as initialized if it failed
    if (process.env.NODE_ENV === "development") {
      global.poolServiceInitialized = false;
    }
  }
}
