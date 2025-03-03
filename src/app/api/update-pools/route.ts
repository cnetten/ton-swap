import { NextResponse } from "next/server";
import { PoolService } from "../quote/PoolTracker";

// Add dynamic directive for Vercel
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Maximum duration in seconds

export async function GET(req: Request) {
  try {
    // Get the URL to parse query parameters
    const url = new URL(req.url);
    const isFullUpdate = url.searchParams.get("type") === "full";
    const forceUpdate = url.searchParams.get("force") === "true";

    console.log(
      `Starting ${isFullUpdate ? "full" : "fast"} update ${
        forceUpdate ? "(forced)" : ""
      }`
    );

    // Get instance and ensure it's initialized
    const poolService = PoolService.getInstance();
    if (!poolService.isInitialized()) {
      await poolService.initialize();
      console.log("PoolService initialized");
    }

    const tracker = poolService.getTracker();

    // Reset flags if they've been stuck or forced
    if (forceUpdate) {
      tracker.fastUpdateInProgress = false;
      tracker.fullUpdateInProgress = false;
      console.log("Update flags reset due to force parameter");
    }

    // For Vercel, we need to be more aggressive about timeout handling
    const updateTimeoutMs = 50000; // 50 seconds to allow for Vercel's 60s limit

    // Create a promise that resolves when the update is complete or times out
    const updateWithTimeout = async () => {
      return new Promise(async (resolve, reject) => {
        // Setup timeout
        const timeout = setTimeout(() => {
          console.error(`Update timed out after ${updateTimeoutMs / 1000}s`);
          tracker.fastUpdateInProgress = false;
          tracker.fullUpdateInProgress = false;
          reject(new Error("Update timed out"));
        }, updateTimeoutMs);

        try {
          // Run the appropriate update
          if (isFullUpdate) {
            await tracker.performFullUpdate();
          } else {
            await tracker.performFastUpdate();
          }
          clearTimeout(timeout);
          resolve("Update completed successfully");
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });
    };

    // Execute the update
    await updateWithTimeout();

    // Clear path cache to ensure fresh calculations
    tracker.clearPathCache();

    // Return success response
    return NextResponse.json(
      {
        message: `${
          isFullUpdate ? "Full" : "Fast"
        } pools update completed successfully`,
        timestamp: Date.now(),
        type: isFullUpdate ? "full" : "fast",
        pathCacheCleared: true,
      },
      {
        headers: {
          // Prevent caching in Vercel edge network
          "Cache-Control": "no-store, max-age=0, must-revalidate",
          Pragma: "no-cache",
          Expires: "0",
        },
      }
    );
  } catch (error) {
    console.error("Pool update error:", error);

    // Reset flags to prevent deadlock on errors
    const poolService = PoolService.getInstance();
    const tracker = poolService.getTracker();

    // Reset update flags to avoid deadlocks
    tracker.fastUpdateInProgress = false;
    tracker.fullUpdateInProgress = false;

    return NextResponse.json(
      {
        message: "Failed to update pools",
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: Date.now(),
      },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store, max-age=0, must-revalidate",
          Pragma: "no-cache",
          Expires: "0",
        },
      }
    );
  }
}
