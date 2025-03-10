import { DeDustClient } from "@dedust/sdk";
import { PoolService } from "./quote/PoolTracker";
import { StonApiClient } from "@ston-fi/api";

export async function initializePoolService() {
  try {
    console.log("Initializing pool service...");
    const poolService = PoolService.getInstance();

    // Check if already initialized
    if (poolService.isInitialized()) {
      console.log("Pool service already initialized");
      return;
    }

    // Get the tracker instance to prepare connections
    const tracker = poolService.getTracker();

    // Create a timeout promise to prevent hanging
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error("Pool service initialization timed out")),
        12000
      );
    });

    // Enhanced initialization with concurrent API calls
    const initializePromise = (async () => {
      try {
        // First initialize with empty data to make service available immediately
        await poolService.initialize([]);
        console.log("Basic pool service initialization complete");

        // Then start fetching data from both APIs concurrently
        const dedustSDK = new DeDustClient({
          endpointUrl: "https://api.dedust.io",
        });
        const stonfiSDK = new StonApiClient();

        // Fetch both sources in parallel
        const [dedustPoolsResponse, stonfiPoolsResponse] =
          await Promise.allSettled([
            dedustSDK.getPools().catch((err) => {
              console.error("Error fetching DeDust pools during init:", err);
              return [];
            }),
            stonfiSDK.getPools().catch((err) => {
              console.error("Error fetching StonFi pools during init:", err);
              return [];
            }),
          ]);

        // Process DeDust pools
        let dedustPools = [];
        if (
          dedustPoolsResponse.status === "fulfilled" &&
          Array.isArray(dedustPoolsResponse.value)
        ) {
          dedustPools = dedustPoolsResponse.value.map((pool) => ({
            ...pool,
            source: "dedust",
            lastUpdateTimestamp: Date.now(),
          }));
          console.log(
            `Fetched ${dedustPools.length} initial pools from DeDust`
          );

          // Add directly to memory cache for immediate availability
          tracker.redisCacheData.set("dedust", dedustPools);
        }

        // Process StonFi pools - convert to our format
        let stonfiPools = [];
        if (
          stonfiPoolsResponse.status === "fulfilled" &&
          Array.isArray(stonfiPoolsResponse.value)
        ) {
          // Only process non-deprecated pools
          const validStonfiPools = stonfiPoolsResponse.value.filter(
            (pool) => !pool.deprecated
          );

          // Convert in batches to avoid processing too many at once
          const BATCH_SIZE = 50;
          for (let i = 0; i < validStonfiPools.length; i += BATCH_SIZE) {
            const batch = validStonfiPools.slice(i, i + BATCH_SIZE);

            // Convert each pool in the batch
            const convertedBatch = await Promise.all(
              batch.map(async (pool) => {
                try {
                  return await tracker.convertStonFiPool(pool);
                } catch (error) {
                  console.error(
                    `Error converting StonFi pool ${pool.address}:`,
                    error
                  );
                  return null;
                }
              })
            );

            // Add valid pools from this batch
            stonfiPools = [...stonfiPools, ...convertedBatch.filter(Boolean)];
          }

          console.log(
            `Fetched and converted ${stonfiPools.length} initial pools from StonFi`
          );

          // Add directly to memory cache for immediate availability
          tracker.redisCacheData.set("stonfi", stonfiPools);
        }

        // Combine pools and store in Redis in the background
        const allPools = [...dedustPools, ...stonfiPools];
        if (allPools.length > 0) {
          console.log(
            `Updating ${allPools.length} total pools in Redis (background)`
          );
          // Don't await this to avoid blocking initialization
          tracker.updateBulkPoolStates(allPools).catch((err) => {
            console.error("Error storing initial pools:", err);
          });
        }

        // This tells Vercel we're done with the critical path
        return true;
      } catch (error) {
        console.error("Failed to initialize pool service with data:", error);
        throw error;
      }
    })();

    // Race between initialization and timeout
    await Promise.race([initializePromise, timeoutPromise]);

    console.log(
      "Pool service initialization in progress, continuing with request"
    );
    return;
  } catch (error) {
    console.error("Failed to initialize pool service:", error);
    // Don't rethrow to prevent initialization failures from breaking the app
  }
}
