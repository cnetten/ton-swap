import { NextResponse } from "next/server";
import { Omniston, Blockchain, SettlementMethod } from "@ston-fi/omniston-sdk";
import { Quote } from "@/types/api/swap";

export async function POST(req: Request) {
  try {
    const { fromAddress, toAddress, amount, slippageTolerance } =
      await req.json();

    if (!fromAddress || !toAddress || !amount || isNaN(amount) || amount <= 0) {
      return NextResponse.json(
        { error: "Invalid or missing required parameters" },
        { status: 400 }
      );
    }

    const omniston = new Omniston({
      apiUrl: "wss://omni-ws.ston.fi",
    });

    const quoteRequest = {
      settlementMethods: [SettlementMethod.SETTLEMENT_METHOD_SWAP],
      askAssetAddress: {
        blockchain: Blockchain.TON,
        address: toAddress,
      },
      offerAssetAddress: {
        blockchain: Blockchain.TON,
        address: fromAddress,
      },
      amount: {
        offerUnits: amount,
      },
    };

    const receivedQuotes: Quote[] = [];

    await Promise.race([
      new Promise<Quote[]>((resolve, reject) => {
        omniston.requestForQuote(quoteRequest).subscribe({
          next(event) {
            if (event.type === "quoteUpdated") {
              if (BigInt(event.quote.askUnits) > 0) {
                receivedQuotes.push({ ...event.quote });

                resolve(receivedQuotes);
              } else {
                reject({
                  status: 400,
                  error: "Unexpected event - Failed to find quotes",
                });
              }
            } else if (event.type === "noQuote") {
              reject({
                status: 400,
                error: "No quotes available for the specified parameters",
              });
            } else if (event.type === "unsubscribed") {
              reject({
                status: 400,
                error: "No valid quotes received during the session",
              });
            }
          },
          error(err: any) {
            reject({ status: 500, error: "Failed to retrieve swap quotes" });
          },
          complete() {
            console.log("Quote request completed.");
          },
        });
      }),
    ]);

    if (!receivedQuotes || receivedQuotes.length === 0) {
      return NextResponse.json(
        { error: "No valid swap quotes found" },
        { status: 400 }
      );
    }

    const bestQuote = receivedQuotes.reduce((prev, current) =>
      BigInt(current.askUnits) > BigInt(prev.askUnits) ? current : prev
    );

    const tx = await omniston.buildTransfer({
      quote: bestQuote,
      sourceAddress: {
        blockchain: Blockchain.TON,
        address: fromAddress,
      },
      destinationAddress: {
        blockchain: Blockchain.TON,
        address: toAddress,
      },
      maxSlippageBps: slippageTolerance * 100,
    });

    const messages = tx.transaction!.ton!.messages;

    return NextResponse.json({
      quote: bestQuote,
      priceImpact: "0",
      transaction: messages,
    });
  } catch (error: any) {
    return NextResponse.json(
      {
        error:
          error?.error ||
          "An unexpected error occurred while requesting the swap quote",
      },
      { status: error?.status || 500 }
    );
  }
}
