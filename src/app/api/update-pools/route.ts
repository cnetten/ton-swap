// api/keep-alive/route.ts
// Ultra-lightweight endpoint just to keep container alive

import { NextResponse } from "next/server";
import { PoolService } from "../quote/PoolTracker";

// Add dynamic directive for AWS App Runner
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    // Get instance and ensure it's initialized
    const poolService = PoolService.getInstance();
    if (!poolService.isInitialized()) {
      await poolService.initialize();
      console.log("PoolService initialized from keep-alive");
    }

    const tracker = poolService.getTracker();

    // Get the URL to parse query parameters
    const url = new URL(req.url);
    const forceUpdate = url.searchParams.get("force") === "true";

    // Only check for stuck processes if force=true
    if (forceUpdate) {
      const redis = poolService.getRedis();

      // Check for stuck update flags
      const updateTypes = ["fast", "full", "redis-persist"];
      const stuckFlags = [];

      for (const type of updateTypes) {
        const inProgressFlag = await redis.get(`update:${type}:inProgress`);
        if (inProgressFlag === "true") {
          const startTimeData = await redis.get(`update:${type}:startTime`);
          const startTime = startTimeData
            ? typeof startTimeData === "string"
              ? parseInt(startTimeData)
              : (startTimeData as number)
            : 0;
          const flagAge = Date.now() - startTime;

          // If flag is older than 5 minutes, it's stuck
          if (flagAge > 300000) {
            stuckFlags.push(type);
            // Reset this flag
            await redis.del(`update:${type}:inProgress`);
            await redis.del(`update:${type}:startTime`);
          }
        }
      }

      if (stuckFlags.length > 0) {
        console.log(`Reset stuck update flags: ${stuckFlags.join(", ")}`);
      }

      // Force a memory update if requested
      tracker
        .performMemoryOnlyUpdate()
        .catch((err) => console.error("Error in forced memory update:", err));
    }

    // Get basic pool counts without accessing Redis
    const dedustPools = tracker.redisCacheData.get("dedust") || [];
    const stonfiPools = tracker.redisCacheData.get("stonfi") || [];

    // Ultra minimal response
    return NextResponse.json(
      {
        status: "alive",
        timestamp: Date.now(),
        poolCounts: {
          dedust: dedustPools.length,
          stonfi: stonfiPools.length,
          total: dedustPools.length + stonfiPools.length,
        },
      },
      {
        headers: {
          // Prevent caching
          "Cache-Control": "no-store, max-age=0, must-revalidate",
          Pragma: "no-cache",
          Expires: "0",
        },
      }
    );
  } catch (error) {
    console.error("Keep-alive error:", error);

    // Return minimal error response
    return NextResponse.json(
      {
        status: "error",
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
