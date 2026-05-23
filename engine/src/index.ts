import "dotenv/config";
import { createClient } from "redis";
import { env } from "./utils/env.js";
import type { CreateOrderInput, CancelOrder } from "./store/exchange-store.js";
import {
  createOrder,
  getDepth,
  getUserBalance,
  getOrder,
  cancelOrder,
} from "./orderbook.js";

export type EngineCommandType =
  | "create_order"
  | "get_depth"
  | "get_user_balance"
  | "get_order"
  | "cancel_order";

export interface EngineRequest {
  correlationId: string;
  responseQueue: string;
  type: EngineCommandType;
  payload: Record<string, unknown>;
}

export interface EngineResponse {
  correlationId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

const brokerClient = createClient({ url: env.redisUrl }).on(
  "error",
  (error) => {
    console.error("Redis broker client error", error);
  },
);

const responseClient = createClient({ url: env.redisUrl }).on(
  "error",
  (error) => {
    console.error("Redis response client error", error);
  },
);

await Promise.all([brokerClient.connect(), responseClient.connect()]);

// :-)) I added this just to check the flow, remove it when you start
const DUMMY_SELL_ORDER = {
  orderId: "dummy-sell-order-1",
  userId: "dummy-seller",
  type: "limit",
  side: "sell",
  symbol: "BTC",
  price: 100,
  qty: 1,
  filledQty: 0,
  status: "open",
};

async function sendResponse(
  responseQueue: string,
  response: EngineResponse,
): Promise<void> {
  await responseClient.lPush(responseQueue, JSON.stringify(response));
}

function handleEngineRequest(message: EngineRequest): unknown {
  switch (message.type) {
    case "create_order":
      const payload = message.payload as unknown as CreateOrderInput;

      return createOrder(payload);

    case "get_depth":
      // read symbol from payload
      // return bids[] and asks[] from the order book
      const { symbol } = message.payload.symbol as { symbol: string };
      return getDepth(symbol);

    case "get_user_balance":
      // read userId from payload
      // return their balance
      const { userId } = message.payload as { userId: string };
      return getUserBalance(userId);

    case "get_order":
      // read orderId from payload
      // find and return the order

      const { orderId } = message.payload as { orderId: string };
      return getOrder(orderId);

    case "cancel_order":
      // read orderId from payload
      // remove from order book, return confirmation

      const payload2 = message.payload as unknown as CancelOrder;
      return cancelOrder(payload2);
    default:
      throw new Error("Unknown command type");
  }
}

console.log(`Engine listening on Redis queue: ${env.incomingQueue}`);

for (;;) {
  const item = await brokerClient.brPop(env.incomingQueue, 0);
  if (!item) continue;

  let message: EngineRequest;

  try {
    message = JSON.parse(item.element) as EngineRequest;
  } catch {
    console.error("Skipping invalid broker message");
    continue;
  }

  try {
    const data = handleEngineRequest(message);
    await sendResponse(message.responseQueue, {
      correlationId: message.correlationId,
      ok: true,
      data,
    });
  } catch (error) {
    await sendResponse(message.responseQueue, {
      correlationId: message.correlationId,
      ok: false,
      error: error instanceof Error ? error.message : "engine_error",
    });
  }
}
