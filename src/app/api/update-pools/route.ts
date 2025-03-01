import { NextResponse } from "next/server";
import { PoolService } from "../quote/PoolTracker";

export async function GET(req: Request) {
  try {
    // Get the URL to parse query parameters
    const url = new URL(req.url);
    const isFullUpdate = url.searchParams.get("type") === "full";

    const poolService = PoolService.getInstance();
    const tracker = poolService.getTracker();

    if (isFullUpdate) {
      // Perform full update
      await tracker.performFullUpdate();

      return NextResponse.json({
        message: "Full pools update completed successfully",
        timestamp: Date.now(),
        type: "full",
      });
    } else {
      // Perform fast update
      await tracker.performFastUpdate();

      return NextResponse.json({
        message: "Fast pools update completed successfully",
        timestamp: Date.now(),
        type: "fast",
      });
    }
  } catch (error) {
    console.error("Pool update error:", error);
    return NextResponse.json(
      {
        message: "Failed to update pools",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
