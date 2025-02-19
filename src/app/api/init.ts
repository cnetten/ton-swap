import { DeDustClient } from "@dedust/sdk";
import { PoolService } from "./quote/PoolTracker";

export async function initializePoolService() {
  // Prevent multiple initializations in development
  // if (process.env.NODE_ENV === "development" && global.poolServiceInitialized) {
  //   return;
  // }

  try {
    const dedustSDK = new DeDustClient({
      endpointUrl: "https://api.dedust.io",
    });

    const initialPools = await dedustSDK.getPools();
    const poolService = PoolService.getInstance();
    await poolService.initialize(initialPools);

    if (process.env.NODE_ENV === "development") {
      global.poolServiceInitialized = true;
    }
  } catch (error) {
    console.error("Failed to initialize pool service:", error);
  }
}
