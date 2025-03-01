import type { NextApiRequest, NextApiResponse } from "next";
import { PoolService } from "../quote/PoolTracker";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  try {
    const poolService = PoolService.getInstance();
    const tracker = poolService.getTracker();

    // Determine if this is a full or fast update based on a query parameter
    const isFullUpdate = req.query.type === "full";

    if (isFullUpdate) {
      // Perform full update
      await tracker.performFullUpdate();

      return res.status(200).json({
        message: "Full pools update completed successfully",
        timestamp: Date.now(),
        type: "full",
      });
    } else {
      // Perform fast update
      await tracker.performFastUpdate();

      return res.status(200).json({
        message: "Fast pools update completed successfully",
        timestamp: Date.now(),
        type: "fast",
      });
    }
  } catch (error) {
    console.error("Pool update error:", error);
    return res.status(500).json({
      message: "Failed to update pools",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
