// src/app/api/quote/multi-route-finder.ts
import type { PathWithCost } from "./types";

/**
 * Interface for path splitting results
 */
export interface PathSplit {
  path1Percentage: number;
  path2Percentage: number;
  totalOutput: string;
  path1Output: string;
  path2Output: string;
  improvement: number;
}

/**
 * Interface for multi-route results
 */
export interface MultiRouteResult {
  useMultiRoute: boolean;
  bestSinglePath: PathWithCost | null;
  multiRoute: {
    paths: (PathWithCost | null)[];
    percentages: number[];
    outputs: string[];
    totalOutput: string;
  };
}

/**
 * Calculate the estimated output when swapping a specific amount through a path
 */
export function calculateEstimatedOutput(
  path: PathWithCost,
  inputAmount: string,
  originalInputAmount: string
): string {
  try {
    // If the path is null or input is zero, return zero
    if (!path || !inputAmount || inputAmount === "0") {
      return "0";
    }

    // For very small amounts, use linear approximation
    if (BigInt(inputAmount) * BigInt(100) < BigInt(originalInputAmount)) {
      // Simple linear scaling for very small amounts
      const ratio = Number(inputAmount) / Number(originalInputAmount);
      return Math.floor(Number(path.outputAmount) * ratio).toString();
    }

    // For direct paths with constant product formula, calculate more precisely
    if (
      path.pools &&
      path.pools.length === 1 &&
      path.path &&
      path.path.length === 2
    ) {
      try {
        const pool = path.pools[0];

        // Find token indices
        const inputTokenIndex = pool.assets.findIndex(
          (asset) => (asset.address || asset.type) === path.path[0]
        );
        const outputTokenIndex = pool.assets.findIndex(
          (asset) => (asset.address || asset.type) === path.path[1]
        );

        if (
          inputTokenIndex !== -1 &&
          outputTokenIndex !== -1 &&
          pool.reserves &&
          pool.reserves.length >= 2
        ) {
          // Get reserves and fee
          const inputReserve = BigInt(pool.reserves[inputTokenIndex]);
          const outputReserve = BigInt(pool.reserves[outputTokenIndex]);

          let feeBPS: bigint;
          if (pool.source === "stonfi" && parseFloat(pool.tradeFee) > 1) {
            // StonFi fee is already in basis points
            feeBPS = BigInt(Math.round(parseFloat(pool.tradeFee)));
          } else {
            // Convert percentage to basis points
            feeBPS = BigInt(Math.round(parseFloat(pool.tradeFee) * 100));
          }

          const BPS_DENOMINATOR = BigInt(10000);
          const inputAmountBigInt = BigInt(inputAmount);

          // Apply fee and calculate output
          const inputWithFee =
            (inputAmountBigInt * (BPS_DENOMINATOR - feeBPS)) / BPS_DENOMINATOR;
          const numerator = outputReserve * inputWithFee;
          const denominator = inputReserve + inputWithFee;

          if (denominator > BigInt(0)) {
            return (numerator / denominator).toString();
          }
        }
      } catch (error) {
        console.error("Error in constant product calculation:", error);
        // Fall back to approximation
      }
    }

    // Use approximation model for other cases
    const inputRatio = Number(inputAmount) / Number(originalInputAmount);

    // Adjust price impact based on ratio
    let priceImpactFactor: number;
    if (inputRatio <= 1) {
      priceImpactFactor = Math.pow(inputRatio, 0.98);
    } else {
      priceImpactFactor = Math.pow(inputRatio, 1.02);
    }

    const outputAmount = Math.floor(
      Number(path.outputAmount) * priceImpactFactor
    );
    return outputAmount.toString();
  } catch (error) {
    console.error("Error calculating estimated output:", error);
    return "0";
  }
}

/**
 * Check if protocol types are compatible for multi-route
 */
export function areProtocolsCompatible(
  protocol1: string | undefined,
  protocol2: string | undefined
): boolean {
  // If either protocol is undefined, they're not compatible
  if (!protocol1 || !protocol2) return false;

  // StonFi v1 and v2 can be combined because they use separate liquidity pools
  if (protocol1.startsWith("stonfi") && protocol2.startsWith("stonfi")) {
    return protocol1 !== protocol2; // Only combine different versions
  }

  // Different protocols use separate liquidity pools, so they're compatible
  return protocol1 !== protocol2;
}

export function findOptimalSplit(
  path1: PathWithCost | null,
  path2: PathWithCost | null,
  totalInputAmount: string
): PathSplit {
  // Handle invalid inputs
  if (!path1 && !path2) {
    return {
      path1Percentage: 0,
      path2Percentage: 0,
      totalOutput: "0",
      path1Output: "0",
      path2Output: "0",
      improvement: 0,
    };
  }

  if (!path1) {
    return {
      path1Percentage: 0,
      path2Percentage: 100,
      totalOutput: path2 ? path2.outputAmount : "0",
      path1Output: "0",
      path2Output: path2 ? path2.outputAmount : "0",
      improvement: 0,
    };
  }

  if (!path2) {
    return {
      path1Percentage: 100,
      path2Percentage: 0,
      totalOutput: path1.outputAmount,
      path1Output: path1.outputAmount,
      path2Output: "0",
      improvement: 0,
    };
  }

  // Phase 1: Coarse search with 5% steps
  let bestPath1Percentage = 100;
  let bestPath2Percentage = 0;
  let bestTotalOutput = BigInt(path1.outputAmount);
  let bestPath1Output = path1.outputAmount;
  let bestPath2Output = "0";

  // Initial coarse search with 5% steps (21 evaluations)
  const coarseSteps = 20;
  for (let i = 0; i <= coarseSteps; i++) {
    const path1Percentage = i * (100 / coarseSteps);
    const path2Percentage = 100 - path1Percentage;

    // Calculate input amounts for each path based on percentages
    const path1Amount = BigInt(
      Math.floor(Number(totalInputAmount) * (path1Percentage / 100))
    ).toString();
    const path2Amount = BigInt(
      Math.floor(Number(totalInputAmount) * (path2Percentage / 100))
    ).toString();

    // Calculate estimated outputs
    const path1Output = calculateEstimatedOutput(
      path1,
      path1Amount,
      path1.inputAmount
    );
    const path2Output = calculateEstimatedOutput(
      path2,
      path2Amount,
      path2.inputAmount
    );

    // Calculate total output
    const totalOutput = BigInt(path1Output) + BigInt(path2Output);

    // Update best if this split is better
    if (totalOutput > bestTotalOutput) {
      bestTotalOutput = totalOutput;
      bestPath1Percentage = path1Percentage;
      bestPath2Percentage = path2Percentage;
      bestPath1Output = path1Output;
      bestPath2Output = path2Output;
    }
  }

  // Phase 2: Fine search around the best result from phase 1
  // Define search range: +/- 5% around the best result from phase 1
  const startPercentage = Math.max(0, bestPath1Percentage - 5);
  const endPercentage = Math.min(100, bestPath1Percentage + 5);

  // Use 1001 steps within this range for ~0.01% precision
  const fineSteps = 1000;
  const stepSize = (endPercentage - startPercentage) / fineSteps;

  for (let i = 0; i <= fineSteps; i++) {
    const path1Percentage = startPercentage + i * stepSize;
    const path2Percentage = 100 - path1Percentage;

    // Calculate input amounts for each path based on percentages
    const path1Amount = BigInt(
      Math.floor(Number(totalInputAmount) * (path1Percentage / 100))
    ).toString();
    const path2Amount = BigInt(
      Math.floor(Number(totalInputAmount) * (path2Percentage / 100))
    ).toString();

    // Calculate estimated outputs
    const path1Output = calculateEstimatedOutput(
      path1,
      path1Amount,
      path1.inputAmount
    );
    const path2Output = calculateEstimatedOutput(
      path2,
      path2Amount,
      path2.inputAmount
    );

    // Calculate total output
    const totalOutput = BigInt(path1Output) + BigInt(path2Output);

    // Update best if this split is better
    if (totalOutput > bestTotalOutput) {
      bestTotalOutput = totalOutput;
      bestPath1Percentage = path1Percentage;
      bestPath2Percentage = path2Percentage;
      bestPath1Output = path1Output;
      bestPath2Output = path2Output;
    }
  }

  // Round percentages to 2 decimal places for display purposes
  bestPath1Percentage = Math.round(bestPath1Percentage * 100) / 100;
  bestPath2Percentage = Math.round(bestPath2Percentage * 100) / 100;

  // Calculate improvement over best single path
  const bestSingleOutput =
    BigInt(path1.outputAmount) > BigInt(path2.outputAmount)
      ? BigInt(path1.outputAmount)
      : BigInt(path2.outputAmount);

  const improvement =
    bestSingleOutput > BigInt(0)
      ? (Number(bestTotalOutput - bestSingleOutput) /
          Number(bestSingleOutput)) *
        100
      : 0;

  return {
    path1Percentage: bestPath1Percentage,
    path2Percentage: bestPath2Percentage,
    totalOutput: bestTotalOutput.toString(),
    path1Output: bestPath1Output,
    path2Output: bestPath2Output,
    improvement,
  };
}

/**
 * Find the best multi-route combination among available paths
 */
export function findBestMultiRoute(
  dedustPath: PathWithCost | null,
  stonfiV1Path: PathWithCost | null,
  stonfiV2Path: PathWithCost | null,
  totalInputAmount: string,
  minImprovementPercent: number = 2, // Minimum improvement to use multi-route
  minAmountForMultiRoute: string = "1000000000" // Default 1 TON (10^9 nanoTON)
): MultiRouteResult {
  // Find the best single path first
  const bestSinglePath = [dedustPath, stonfiV1Path, stonfiV2Path]
    .filter(Boolean)
    .reduce((best, current) => {
      if (!best) return current;
      if (!current) return best;

      return BigInt(current.outputAmount) > BigInt(best.outputAmount)
        ? current
        : best;
    }, null as PathWithCost | null);

  if (!bestSinglePath) {
    return {
      useMultiRoute: false,
      bestSinglePath: null,
      multiRoute: {
        paths: [],
        percentages: [],
        outputs: [],
        totalOutput: "0",
      },
    };
  }

  // Check all possible path combinations
  const combinations = [
    { path1: dedustPath, path2: stonfiV1Path },
    { path1: dedustPath, path2: stonfiV2Path },
    { path1: stonfiV1Path, path2: stonfiV2Path },
  ];

  let bestMultiRoute = {
    paths: [null, null] as (PathWithCost | null)[],
    percentages: [0, 0],
    outputs: ["0", "0"],
    totalOutput: "0",
    improvement: 0,
  };

  for (const { path1, path2 } of combinations) {
    // Check if protocols are compatible for multi-routing
    if (
      !path1 ||
      !path2 ||
      !areProtocolsCompatible(path1.source, path2.source)
    ) {
      continue;
    }

    // Find optimal split for this combination
    const result = findOptimalSplit(path1, path2, totalInputAmount);

    // If this combination is better than the previous best, update
    if (BigInt(result.totalOutput) > BigInt(bestMultiRoute.totalOutput)) {
      bestMultiRoute = {
        paths: [path1, path2],
        percentages: [result.path1Percentage, result.path2Percentage],
        outputs: [result.path1Output, result.path2Output],
        totalOutput: result.totalOutput,
        improvement: result.improvement,
      };
    }
  }

  // Check if multi-route should be used based on criteria
  const useMultiRoute =
    BigInt(totalInputAmount) >= BigInt(minAmountForMultiRoute) && // Only for larger amounts
    bestMultiRoute.improvement >= minImprovementPercent &&
    BigInt(bestMultiRoute.totalOutput) > BigInt(bestSinglePath.outputAmount);

  return {
    useMultiRoute,
    bestSinglePath,
    multiRoute: {
      paths: bestMultiRoute.paths,
      percentages: bestMultiRoute.percentages,
      outputs: bestMultiRoute.outputs,
      totalOutput: bestMultiRoute.totalOutput,
    },
  };
}

/**
 * Format a multi-route path into a readable string
 */
export function formatMultiRoutePath(
  paths: (PathWithCost | null)[],
  percentages: number[]
): string {
  const pathDetails = paths
    .map((path, index) => {
      if (!path) return null;
      const percent = Math.round(percentages[index]);
      return `${percent}% ${path.source || "Unknown"}`;
    })
    .filter(Boolean)
    .join(" + ");

  return `Multi-route: ${pathDetails}`;
}
