// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parentPort, workerData } = require("worker_threads");

function formatPrice(
  rawInput,
  rawOutput,
  inputDecimals = 9,
  outputDecimals = 9
) {
  try {
    const outputValue = Number(rawOutput) / Math.pow(10, outputDecimals);
    const inputValue = Number(rawInput) / Math.pow(10, inputDecimals);
    return inputValue === 0
      ? "0.000000000"
      : (outputValue / inputValue).toFixed(9);
  } catch {
    return "0.000000000";
  }
}

function calculateSwapOutput(inputAmount, pool, inputTokenId, outputTokenId) {
  try {
    const inputTokenIndex = pool.assets.findIndex(
      (asset) => (asset.address || asset.type) === inputTokenId
    );
    const outputTokenIndex = pool.assets.findIndex(
      (asset) => (asset.address || asset.type) === outputTokenId
    );

    if (inputTokenIndex === -1 || outputTokenIndex === -1) {
      console.log(
        `Token not found in pool: input=${inputTokenId}, output=${outputTokenId}`
      );
      return "0";
    }

    const inputReserve = pool.reserves[inputTokenIndex];
    const outputReserve = pool.reserves[outputTokenIndex];

    if (!inputReserve || !outputReserve) {
      console.log(
        `Invalid reserves in pool: input=${inputReserve}, output=${outputReserve}`
      );
      return "0";
    }

    // Get token decimals
    const inputDecimals = pool.assets[inputTokenIndex].metadata?.decimals || 9;
    const outputDecimals =
      pool.assets[outputTokenIndex].metadata?.decimals || 9;

    if (
      outputTokenId === "native" &&
      inputDecimals === 9 &&
      outputDecimals === 9
    ) {
      // Calculate with scaling factor to fix the constant output issue
      const inputAmountBN = BigInt(inputAmount);
      const inputReserveBN = BigInt(inputReserve);
      const outputReserveBN = BigInt(outputReserve);

      // Apply fee
      let feeBPS;
      if (pool.source === "stonfi") {
        // FIX: StonFi fees are in basis points directly (20 = 0.2%)
        const rawFee = parseFloat(pool.tradeFee);
        if (rawFee > 1) {
          // Fee is already in basis points (e.g., 20 for 0.2%)
          feeBPS = BigInt(Math.floor(rawFee));
        } else {
          // Fee is in percentage (e.g., 0.2 for 0.2%)
          feeBPS = BigInt(Math.floor(rawFee * 100));
        }

        // IMPORTANT FIX: Cap StonFi fee to reasonable values
        if (feeBPS > BigInt(100)) {
          console.log(`Capping suspiciously high StonFi fee: ${feeBPS} -> 30`);
          feeBPS = BigInt(30); // Cap at 0.3%
        }
      }

      const inputWithFee = (inputAmountBN * (10000n - feeBPS)) / 10000n;

      const numerator = outputReserveBN * inputWithFee;
      const denominator = inputReserveBN + inputWithFee + 1n;

      if (denominator <= 0n) return "0";

      const outputAmount = numerator / denominator;

      return outputAmount.toString();
    }

    // Convert everything to BigInt with decimal normalization
    const inputAmountBN = BigInt(inputAmount);
    const inputReserveBN = BigInt(inputReserve);
    const outputReserveBN = BigInt(outputReserve);

    // Normalize all values to same decimal basis (use input decimals as base)
    let workingInputAmount = inputAmountBN;
    let workingInputReserve = inputReserveBN;
    let workingOutputReserve = outputReserveBN;

    // Scale values to input decimal basis
    if (inputDecimals !== outputDecimals) {
      if (outputDecimals > inputDecimals) {
        // Scale up input side
        const scale = BigInt(10 ** (outputDecimals - inputDecimals));
        workingInputAmount *= scale;
        workingInputReserve *= scale;
      } else {
        // Scale down output side
        const scale = BigInt(10 ** (inputDecimals - outputDecimals));
        workingOutputReserve /= scale;
      }
    }

    // Apply fee
    let feeBPS;
    if (pool.source === "stonfi" && parseFloat(pool.tradeFee) > 1) {
      // StonFi sends fee directly in basis points (20 = 0.2%)
      feeBPS = BigInt(parseFloat(pool.tradeFee));
    } else {
      // DeDust sends fee as a percentage (0.25 = 0.25%)
      feeBPS = BigInt(Math.floor(parseFloat(pool.tradeFee) * 100));
    }
    const inputWithFee = (workingInputAmount * (10000n - feeBPS)) / 10000n;

    let outputAmount;

    if (pool.type === "volatile" || pool.type === "stonfi") {
      // Constant Product formula: x * y = k
      const numerator = workingOutputReserve * inputWithFee;
      const denominator = workingInputReserve + inputWithFee + 1n;

      if (denominator <= 0n) return "0";

      outputAmount = numerator / denominator;
    } else if (pool.type === "stable") {
      // Stable-Swap formula: x^3 * y + y^3 * x = k
      const x = workingInputReserve + inputWithFee;
      const y = workingOutputReserve;
      const k =
        workingInputReserve ** 3n * workingOutputReserve +
        workingOutputReserve ** 3n * workingInputReserve;

      // Calculate the new output reserve after the swap
      const newY = k / (x ** 3n + k / y ** 2n);

      // Calculate the output amount
      outputAmount = y - newY;
    } else {
      throw new Error(`Unsupported pool type: ${pool.type}`);
    }

    // Scale output back to original decimal basis if needed
    if (inputDecimals !== outputDecimals) {
      if (outputDecimals > inputDecimals) {
        // Already in correct decimals
      } else {
        // Scale back up
        outputAmount *= BigInt(10 ** (inputDecimals - outputDecimals));
      }
    }

    return outputAmount.toString();
  } catch (error) {
    console.error("Swap calculation error:", error);
    return "0";
  }
}

function getSymbolFromPool(tokenId, pool) {
  if (tokenId === "native") return "TON";
  const symbol =
    pool.assets.find((a) => (a.address || a.type) === tokenId)?.metadata
      ?.symbol || "Unknown";
  return symbol;
}

function findDirectPath(graph, poolsByPair, fromToken, toToken, inputAmount) {
  // Skip if graph or tokens are invalid
  if (!graph || !fromToken || !toToken) {
    return null;
  }

  // Check if tokens exist in graph
  if (!graph[fromToken]) {
    return null;
  }

  // Skip if no direct connection
  if (!graph[fromToken][toToken]) {
    return null;
  }

  const pairKey =
    fromToken < toToken ? `${fromToken}-${toToken}` : `${toToken}-${fromToken}`;

  const directPool = poolsByPair[pairKey];

  if (!directPool) {
    return null;
  }

  // Validate pool has sufficient reserves
  const inputTokenIndex = directPool.assets.findIndex(
    (asset) => (asset.address || asset.type) === fromToken
  );
  const outputTokenIndex = directPool.assets.findIndex(
    (asset) => (asset.address || asset.type) === toToken
  );

  if (inputTokenIndex === -1 || outputTokenIndex === -1) {
    return null;
  }

  const inputReserve = directPool.reserves[inputTokenIndex];
  const outputReserve = directPool.reserves[outputTokenIndex];

  if (!inputReserve || !outputReserve) {
    return null;
  }

  // Calculate output amount
  const outputAmount = calculateSwapOutput(
    inputAmount,
    directPool,
    fromToken,
    toToken
  );

  if (outputAmount === "0") {
    return null;
  }

  // Create readable path
  const fromSymbol = getSymbolFromPool(fromToken, directPool);
  const toSymbol = getSymbolFromPool(toToken, directPool);

  return {
    path: [fromToken, toToken],
    pathReadable: `${fromSymbol} → ${toSymbol}`,
    pools: [directPool],
    outputAmount,
    estimatedOutput: outputAmount,
    inputAmount: inputAmount,
    minimumAmountOut: Number(outputAmount) * 0.995, // 0.5% slippage
    estimatedGasFees: 0,
    outPerIn: formatPrice(inputAmount, outputAmount), // Keep using formatPrice for price ratio
    pathDepth: 1,
    outPutMint: toToken,
  };
}

function findPathsFromNode(
  graph,
  poolsByPair,
  startStep,
  targetNode,
  maxDepth,
  from
) {
  const allPaths = [];
  const visited = new Set([from, startStep.node]);
  const currentPath = [from, startStep.node];
  const currentPools = [startStep.pool];

  function getPairKey(a, b) {
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  }

  function getNeighbors(node) {
    const neighbors = graph[node];
    if (!neighbors) return [];

    const result = [];
    for (const neighbor of Object.keys(neighbors)) {
      const pairKey = getPairKey(node, neighbor);
      const pool = poolsByPair[pairKey];

      if (pool?.reserves[0] && pool?.reserves[1]) {
        const liquidity = Number(pool.reserves[0]) + Number(pool.reserves[1]);
        result.push([neighbor, pool, liquidity]);
      }
    }

    return result
      .sort((a, b) => b[2] - a[2])
      .map(([neighbor, pool]) => [neighbor, pool]);
  }

  const stack = [
    {
      node: startStep.node,
      depth: 2,
      previousNode: from,
      neighborIndex: 0,
      currentAmount: startStep.initialAmount,
    },
  ];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];

    if (!frame.neighbors) {
      frame.neighbors = getNeighbors(frame.node);
    }

    if (frame.neighborIndex >= frame.neighbors.length) {
      stack.pop();
      if (currentPath.length > 2) {
        const lastNode = currentPath.pop();
        currentPools.pop();
        visited.delete(lastNode);
      }
      continue;
    }

    const [nextNode, pool] = frame.neighbors[frame.neighborIndex++];

    if (nextNode === frame.previousNode || visited.has(nextNode)) continue;

    const outputAmount = calculateSwapOutput(
      frame.currentAmount,
      pool,
      frame.node,
      nextNode
    );

    if (outputAmount === "0" || outputAmount.startsWith("-")) continue;

    visited.add(nextNode);
    currentPath.push(nextNode);
    currentPools.push(pool);

    if (nextNode === targetNode) {
      const readablePath = currentPath
        .map((tokenId, i) => {
          if (tokenId === "native") return "TON";
          return i === 0
            ? getSymbolFromPool(tokenId, currentPools[0])
            : getSymbolFromPool(tokenId, currentPools[i - 1]);
        })
        .join(" → ");

      // Standard path handling (unchanged)
      allPaths.push({
        path: [...currentPath],
        pathReadable: readablePath,
        pools: [...currentPools],
        outputAmount,
        estimatedOutput: outputAmount,
        inputAmount: workerData.inputAmount,
        minimumAmountOut: Number(outputAmount) * 0.995,
        estimatedGasFees: 0,
        outPerIn: formatPrice(workerData.inputAmount, outputAmount),
        pathDepth: currentPath.length - 1,
        outPutMint: nextNode,
      });

      currentPath.pop();
      currentPools.pop();
      visited.delete(nextNode);
      continue;
    }

    if (frame.depth < maxDepth) {
      stack.push({
        node: nextNode,
        depth: frame.depth + 1,
        previousNode: frame.node,
        neighborIndex: 0,
        currentAmount: outputAmount,
      });
    } else {
      currentPath.pop();
      currentPools.pop();
      visited.delete(nextNode);
    }
  }

  return allPaths;
}

// This is where the main execution code starts
if (parentPort) {
  // Check if we're working with StonFi and should only find direct paths
  const isStonfiProtocol = workerData.protocol === "stonfi";

  // First check for direct path - this is important to try first
  const directPath = findDirectPath(
    workerData.graph,
    workerData.poolsByPair,
    workerData.from,
    workerData.targetNode,
    workerData.inputAmount
  );

  // Then find multi-hop paths (only for non-StonFi protocols)
  const allPaths = [];
  
  if (directPath) {
    allPaths.push(directPath);
  }

  // Only search for multi-hop paths if not using StonFi
  if (!isStonfiProtocol) {
    for (const startStep of workerData.startNodes) {
      const paths = findPathsFromNode(
        workerData.graph,
        workerData.poolsByPair,
        startStep,
        workerData.targetNode,
        workerData.maxDepth,
        workerData.from
      );
      allPaths.push(...paths);
    }
  } else {
    console.log("StonFi protocol: Only using direct path, skipping multi-hop search");
  }

  // Sort by output amount and prefer shorter paths when outputs are similar
  allPaths.sort((a, b) => {
    if (a.outputAmount.startsWith("-")) return 1;
    if (b.outputAmount.startsWith("-")) return -1;
    const outputDiff = Number(b.outputAmount) - Number(a.outputAmount);
    // If outputs are within 1% of each other, prefer shorter path
    if (Math.abs(outputDiff) < Number(b.outputAmount) * 0.01) {
      return a.path.length - b.path.length;
    }
    return outputDiff;
  });

  // Filter out negative or zero output paths
  const validPaths = allPaths.filter(
    (path) =>
      !path.outputAmount.startsWith("-") && BigInt(path.outputAmount) > 0n
  );

  // IMPORTANT: If no multi-hop paths were found, but we have a direct path, use it
  let bestPaths;
  if (validPaths.length > 0) {
    // We found valid paths through normal means
    bestPaths = validPaths.slice(0, 1);
    console.log(`Found ${validPaths.length} valid paths, using best path`);
  } else if (
    directPath &&
    !directPath.outputAmount.startsWith("-") &&
    BigInt(directPath.outputAmount) > 0n
  ) {
    // No multi-hop paths but we have a valid direct path as fallback
    bestPaths = [directPath];
    console.log(`No multi-hop paths found, falling back to direct path`);
  } else {
    // No valid paths found at all
    bestPaths = [];
    console.log(`No valid paths found`);
  }

  parentPort.postMessage({ paths: bestPaths });
}