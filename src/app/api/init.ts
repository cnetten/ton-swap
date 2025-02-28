import { DeDustClient } from "@dedust/sdk";
import { PoolService } from "./quote/PoolTracker";

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
        10000
      );
    });

    // Initialize with minimal data - don't wait for full data loading
    // This makes a lightweight initialization that won't time out
    const initializePromise = (async () => {
      try {
        // Just initialize the service with empty data first
        await poolService.initialize([]);
        console.log("Basic pool service initialization complete");

        // This tells Vercel we're done with the critical path
        // Further initialization will happen in background
        return true;
      } catch (error) {
        console.error("Failed to initialize basic pool service:", error);
        throw error;
      }
    })();

    // Race between initialization and timeout
    await Promise.race([initializePromise, timeoutPromise]);

    // Background fetch initial data if needed - don't await this
    setTimeout(async () => {
      try {
        console.log("Background fetching of initial pool data started");

        // Fetch initial pools from DeDust
        const dedustSDK = new DeDustClient({
          endpointUrl: "https://api.dedust.io",
        });

        const initialPools = await dedustSDK.getPools();
        console.log(`Fetched ${initialPools.length} initial pools from DeDust`);

        // Trigger pool updates
        await tracker.triggerUpdateIfNeeded();

        console.log("Background pool data initialization complete");
      } catch (backgroundError) {
        console.error("Background data fetching failed:", backgroundError);
        // Failures here won't affect the API response
      }
    }, 100);

    console.log(
      "Pool service initialization in progress, continuing with request"
    );
    return;
  } catch (error) {
    console.error("Failed to initialize pool service:", error);
    // Don't rethrow to prevent initialization failures from breaking the app
  }
}
