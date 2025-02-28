/* eslint-disable @typescript-eslint/no-unused-vars */
import { Worker } from "worker_threads";
import path from "path";
import type { Pool, PathWithCost } from "./types";

export async function findSwapPathsParallel(
  graph: Map<string, Map<string, number>>,
  poolsByPair: Map<string, Pool>,
  from: string,
  to: string,
  inputAmount: string,
  maxDepth = 4,
  maxPaths = 1,
  protocol = "dedust"
): Promise<PathWithCost[]> {
  try {
    // Get initial set of nodes to distribute work
    const startNodes = Array.from(graph.get(from)?.keys() || []);
    if (startNodes.length === 0) return [];
    // Prepare data for workers
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serializedGraph: any = {};
    for (const [key, value] of graph.entries()) {
      serializedGraph[key] = Object.fromEntries(value);
    }
    const serializedPools = Object.fromEntries(poolsByPair);

    // Determine number of workers based on available paths
    const numWorkers = Math.min(4, startNodes.length);
    const workerPromises: Promise<PathWithCost[]>[] = [];
    const workers: Worker[] = [];

    // Pre-calculate initial steps for each worker
    const initialSteps = startNodes
      .map((node) => {
        const pairKey = [from, node].sort().join("-");
        const pool = poolsByPair.get(pairKey);
        return {
          node,
          pool: pool!,
          initialAmount: calculateInitialSwapOutput(
            inputAmount,
            pool!,
            from,
            node
          ),
        };
      })
      .filter((step) => step.initialAmount !== "0");

    // Split work among workers
    for (let i = 0; i < numWorkers; i++) {
      const workerNodes = initialSteps.filter(
        (_, index) => index % numWorkers === i
      );
      if (workerNodes.length === 0) continue;

      const workerPromise = new Promise<PathWithCost[]>((resolve, reject) => {
        try {
          const worker = new Worker(
            path.resolve("./src/app/api/quote/worker.js"),
            {
              workerData: {
                from,
                startNodes: workerNodes,
                targetNode: to,
                inputAmount,
                maxDepth,
                graph: serializedGraph,
                poolsByPair: serializedPools,
              },
            }
          );

          workers.push(worker);

          worker.on("message", (data) => {
            resolve(data.paths);
          });

          worker.on("error", (error) => {
            console.error("Worker error:", error);
            reject(error);
          });

          worker.on("exit", (code) => {
            if (code !== 0) {
              reject(new Error(`Worker stopped with exit code ${code}`));
            }
          });
        } catch (error) {
          console.error("Error creating worker:", error);
          reject(error);
        }
      });

      workerPromises.push(workerPromise);
    }

    // Wait for all workers to complete
    const pathsArrays = await Promise.all(workerPromises);

    // Cleanup workers
    workers.forEach((worker) => worker.terminate());

    // Combine all paths
    const allPaths = pathsArrays.flat();

    // Sort by output amount
    if (allPaths.length > 1) {
      allPaths.sort((a, b) => {
        const outputA = BigInt(a.outputAmount);
        const outputB = BigInt(b.outputAmount);
        return outputB > outputA ? 1 : outputB < outputA ? -1 : 0;
      });
    }

    return allPaths.slice(0, maxPaths);
  } catch (error) {
    console.error("Error in parallel path finding:", error);
    throw error;
  }
}

function calculateInitialSwapOutput(
  inputAmount: string,
  pool: Pool,
  inputTokenId: string,
  outputTokenId: string
): string {
  try {
    const inputTokenIndex = pool.assets.findIndex(
      (asset) => (asset.address || asset.type) === inputTokenId
    );
    const outputTokenIndex = pool.assets.findIndex(
      (asset) => (asset.address || asset.type) === outputTokenId
    );

    if (inputTokenIndex === -1 || outputTokenIndex === -1) return "0";

    const inputReserve = pool.reserves[inputTokenIndex];
    const outputReserve = pool.reserves[outputTokenIndex];

    if (!inputReserve || !outputReserve) return "0";

    const inputAmountBN = BigInt(inputAmount);
    const inputReserveBN = BigInt(inputReserve);
    const outputReserveBN = BigInt(outputReserve);
    let feeBPS;

    if (pool.source === "stonfi") {
      // StonFi sends fee directly in basis points (20 = 0.2%)
      feeBPS = BigInt(parseFloat(pool.tradeFee));
    } else {
      // DeDust sends fee as a percentage (0.25 = 0.25%)
      feeBPS = BigInt(Math.floor(parseFloat(pool.tradeFee) * 100));
    }
    const BPS_DENOMINATOR = BigInt(10000);

    if (
      inputAmountBN <= BigInt(0) ||
      inputReserveBN <= BigInt(0) ||
      outputReserveBN <= BigInt(0)
    ) {
      return "0";
    }

    const inputAmountWithFee =
      (inputAmountBN * (BPS_DENOMINATOR - feeBPS)) / BPS_DENOMINATOR;

    if (inputAmountWithFee <= BigInt(0)) return "0";

    const numerator = outputReserveBN * inputAmountWithFee;
    const denominator = inputReserveBN + inputAmountWithFee;

    if (denominator <= BigInt(0)) return "0";

    return (numerator / denominator).toString();
  } catch {
    return "0";
  }
}
