import { NextResponse } from "next/server";
import { PoolService } from "../quote/PoolTracker";

export async function GET(req: Request) {
  try {
    // Get the URL to parse query parameters
    const url = new URL(req.url);
    const isFullUpdate = url.searchParams.get("type") === "full";

    const poolService = PoolService.getInstance();
    const tracker = poolService.getTracker();

    // Set a timeout for the update to prevent hanging
    const updatePromise = isFullUpdate
      ? tracker.performFullUpdate()
      : tracker.performFastUpdate();

    const timeoutPromise = new Promise(
      (_, reject) =>
        setTimeout(() => reject(new Error("Update timed out")), 55000) // 55 second timeout
    );

    // Run update with timeout
    await Promise.race([updatePromise, timeoutPromise]);

    // IMPORTANT: Always clear path cache after update
    tracker.clearPathCache();

    return NextResponse.json({
      message: `${
        isFullUpdate ? "Full" : "Fast"
      } pools update completed successfully`,
      timestamp: Date.now(),
      type: isFullUpdate ? "full" : "fast",
      pathCacheCleared: true,
    });
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
      },
      { status: 500 }
    );
  }
}
