/* eslint-disable @typescript-eslint/no-explicit-any */
// src/components/swap-interface/utils/multi-route.ts

/**
 * Minimum amount for multi-route to be viable (to prevent dust amounts)
 * This is in nanoTON (0.1 TON = 100,000,000 nanoTON)
 */
const MIN_PATH_AMOUNT = 100000000; // 0.1 TON

/**
 * Minimum total amount to consider multi-routing
 * This is in nanoTON (1 TON = 1,000,000,000 nanoTON)
 */
const MIN_TOTAL_AMOUNT = 1000000000; // 1 TON

/**
 * Check if multi-route execution is valid for the given parameters
 */
export function validateMultiRouteExecution(
  isMultiRoute: boolean,
  swapPaths: any[],
  fromAmount: string,
  fromDecimals: number = 9
): {
  valid: boolean;
  error?: string;
} {
  // If not a multi-route, it's valid
  if (!isMultiRoute) {
    return { valid: true };
  }

  try {
    // Convert to nanoTON (assuming fromAmount is in human-readable format)
    const totalAmount = BigInt(
      Math.floor(parseFloat(fromAmount) * Math.pow(10, fromDecimals)).toString()
    );

    // Check if total amount meets minimum threshold
    if (totalAmount < BigInt(MIN_TOTAL_AMOUNT)) {
      return {
        valid: false,
        error: `Amount too small for multi-route execution. Minimum ${
          MIN_TOTAL_AMOUNT / 1e9
        } TON required.`,
      };
    }

    // Validate that we have at least two paths
    if (!swapPaths || swapPaths.length < 2) {
      return {
        valid: false,
        error: "Multi-route requires at least two valid paths",
      };
    }

    // Validate that total percentage adds up to approximately 100%
    const totalPercentage = swapPaths.reduce(
      (total, path) => total + (path.percentage || 0),
      0
    );

    if (totalPercentage < 99 || totalPercentage > 101) {
      return {
        valid: false,
        error: `Invalid multi-route: Total percentage (${totalPercentage.toFixed(
          2
        )}%) should be 100%`,
      };
    }

    // Check for dust amounts - ensure each path has a meaningful amount
    for (const path of swapPaths) {
      const pathPercentage = path.percentage / 100;
      const pathAmount = BigInt(
        Math.floor(Number(totalAmount) * pathPercentage).toString()
      );

      if (pathAmount < BigInt(MIN_PATH_AMOUNT)) {
        return {
          valid: false,
          error: `One path has too small an amount (${(
            Number(pathAmount) / 1e9
          ).toFixed(4)} TON)`,
        };
      }

      // StonFi only supports direct routes
      if (path.source && path.source.includes("stonfi") && path.pathDepth > 1) {
        return {
          valid: false,
          error: `StonFi only supports direct routes, but a multi-hop path was detected`,
        };
      }
    }

    return { valid: true };
  } catch (error) {
    console.error("Error validating multi-route:", error);
    return {
      valid: false,
      error: "Failed to validate multi-route execution",
    };
  }
}

/**
 * Format amounts for multi-route paths
 */
export function formatMultiRouteAmounts(
  fromAmount: string,
  paths: any[],
  fromDecimals: number = 9
): { pathAmounts: string[]; totalAmount: string } {
  try {
    // Convert to nanoTON for precise calculations
    const totalNanoTON = Math.floor(
      parseFloat(fromAmount) * Math.pow(10, fromDecimals)
    );

    // Handle edge cases
    if (totalNanoTON <= 0 || !paths || paths.length === 0) {
      return { pathAmounts: [], totalAmount: fromAmount };
    }

    let remainingAmount = BigInt(totalNanoTON);
    const pathAmounts: string[] = [];

    // Process all paths except the last one, allocating exact amounts
    for (let i = 0; i < paths.length - 1; i++) {
      const path = paths[i];
      const percentage = path.percentage / 100;

      // Calculate path amount in nanoTON
      const pathNanoTON = BigInt(Math.floor(totalNanoTON * percentage));

      // Make sure we don't exceed the total
      const pathAmount =
        pathNanoTON > remainingAmount ? remainingAmount : pathNanoTON;
      remainingAmount -= pathAmount;

      // Convert back to human-readable format with proper decimals
      pathAmounts.push(
        (Number(pathAmount) / Math.pow(10, fromDecimals)).toFixed(fromDecimals)
      );
    }

    // Allocate remaining amount to the last path
    if (paths.length > 0) {
      pathAmounts.push(
        (Number(remainingAmount) / Math.pow(10, fromDecimals)).toFixed(
          fromDecimals
        )
      );
    }

    return {
      pathAmounts,
      totalAmount: fromAmount,
    };
  } catch (error) {
    console.error("Error formatting multi-route amounts:", error);

    // Fallback to simple percentage-based splitting
    const totalAmount = parseFloat(fromAmount);
    const pathAmounts = paths.map((path) => {
      const percentage = path.percentage / 100;
      return (totalAmount * percentage).toFixed(fromDecimals);
    });

    return {
      pathAmounts,
      totalAmount: fromAmount,
    };
  }
}

/**
 * Calculate gas requirements for multi-route execution
 */
export function estimateMultiRouteGas(paths: any[]): number {
  if (!paths || !Array.isArray(paths) || paths.length === 0) {
    return 0;
  }

  // Base gas costs by protocol
  const BASE_DEDUST_GAS = 0.25; // 0.25 TON for DeDust
  const BASE_STONFI_GAS = 0.2; // 0.2 TON for StonFi
  const MULTI_HOP_EXTRA = 0.05; // Additional gas for each hop
  const BUFFER = 0.15; // Buffer for unexpected gas costs

  // Calculate gas for each path
  let totalGas = 0;

  for (const path of paths) {
    if (!path) continue;

    // Check path depth (number of hops)
    const hops = path.pathDepth || (path.path ? path.path.length - 1 : 0);
    const isMultiHop = hops > 1;

    // Identify protocol
    const protocol = (path.source || "").toLowerCase();

    if (protocol.includes("dedust")) {
      totalGas += BASE_DEDUST_GAS;
      // Add extra gas for multi-hop paths
      if (isMultiHop) {
        totalGas += (hops - 1) * MULTI_HOP_EXTRA;
      }
    } else if (protocol.includes("stonfi")) {
      totalGas += BASE_STONFI_GAS;
    } else {
      // Unknown protocol, use higher estimate
      totalGas += BASE_DEDUST_GAS;
    }
  }

  // Add buffer for safety
  totalGas += BUFFER;

  return Math.ceil(totalGas * 100) / 100; // Round up to 2 decimal places
}
