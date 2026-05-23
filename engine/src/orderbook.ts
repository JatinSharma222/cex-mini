import {
  type Balance,
  type CancelOrder,
  type CreateOrderInput,
  type OrderRecord,
  type OrderStatus,
  type RestingOrder,
  type Fill,
  type DepthResponse,
  ORDERBOOKS,
  BALANCES,
  ORDERS,
} from "./store/exchange-store";

export function createOrder(input: CreateOrderInput) {
  const { userId, price, qty, side, type, symbol } = input;
  const totalCost = (price || 0) * qty;
  if (side === "buy") {
    if (getBalance(userId, "INR").available < totalCost) {
      throw new Error("Insufficient funds!");
    }
    getBalance(userId, "INR").available -= totalCost;
    getBalance(userId, "INR").locked += totalCost;
  } else if (side === "sell") {
    if (getBalance(userId, symbol).available < qty) {
      throw new Error("Insufficient funds!");
    }
    getBalance(userId, symbol).available -= qty;
    getBalance(userId, symbol).locked += qty;
  }

  const orderId = crypto.randomUUID();

  const order: OrderRecord = {
    userId,
    orderId,
    symbol,
    side,
    type,
    price: price || null,
    fills: [],
    createdAt: Date.now(),
    qty,
    filledQty: 0,
    status: "open",
  };

  const books = getOrderBook(symbol);
  const oppositeSide = side === "buy" ? books.asks : books.bids;

  let remainingQty = qty;

  for (let i = 0; i < oppositeSide.length; i++) {
    const existingOrder: RestingOrder = oppositeSide[i]!;
    const isMatch =
      side === "buy"
        ? existingOrder.price <= price!
        : existingOrder.price >= price!;

    if (isMatch) {
      const fillAmount = Math.min(remainingQty, existingOrder.qty);

      remainingQty -= fillAmount;
      existingOrder.qty -= fillAmount;
      existingOrder.filledQty += fillAmount;

      const fillId = crypto.randomUUID();
      const fills: Fill = {
        fillId,
        symbol: existingOrder.symbol,
        price: existingOrder.price,
        qty: fillAmount,
        buyOrderId: side === "buy" ? order.orderId : existingOrder.orderId,
        sellOrderId: side === "sell" ? existingOrder.orderId : order.orderId,
        createdAt: Date.now(),
      };

      order.fills.push(fills);

      const globalExisting = ORDERS.get(existingOrder.orderId)!;
      globalExisting.filledQty += fillAmount;
      globalExisting.status =
        existingOrder.qty === 0 ? "filled" : "partially_filled";
      globalExisting.fills.push(fills);

      if (side === "buy") {
        settleTrade(
          userId,
          existingOrder.userId,
          fillAmount,
          existingOrder.price,
          symbol,
        );
      } else {
        settleTrade(
          existingOrder.userId,
          userId,
          fillAmount,
          existingOrder.price,
          symbol,
        );
      }

      if (existingOrder.qty === 0) {
        oppositeSide.splice(i, 1);
        i--;
      }
    }
  }

  order.filledQty = qty - remainingQty;
  order.status =
    remainingQty === 0
      ? "filled"
      : remainingQty === qty
        ? "open"
        : "partially_filled";
  ORDERS.set(order.orderId, order);

  if (remainingQty > 0) {
    const mySide = side === "buy" ? books.bids : books.asks;

    mySide.push({
      orderId: order.orderId,
      userId,
      price: price!,
      side,
      type: "limit",
      symbol,
      createdAt: Date.now(),
      qty: remainingQty,
      filledQty: qty - remainingQty,
      status: order.status as OrderStatus,
    });
  }

  return {
    message: "Order Processed!",
    orderId: order.orderId,
    status: order.status,
    fills: order.fills,
    averagePrice: price ?? 0,
    filled: qty - remainingQty,
    remaining: remainingQty,
  };
}

export function getDepth(symbol: string): DepthResponse {
  const book = ORDERBOOKS[symbol];
  if (!book) {
    return {
      symbol: symbol,
      bids: [],
      asks: [],
    };
  }

  const aggregate = (orders: RestingOrder[]) => {
    const counts: Record<number, number> = {};
    orders.forEach((order) => {
      counts[order.price] = (counts[order.price] || 0) + order.qty;
    });
    return Object.entries(counts).map(([price, qty]) => ({
      price: Number(price),
      qty,
    }));
  };

  const bids = aggregate(book.bids).sort((a, b) => b.price - a.price);
  const asks = aggregate(book.asks).sort((a, b) => a.price - b.price);

  return {
    symbol,
    bids,
    asks,
  };
}

export function getUserBalance(userId: string): Record<string, Balance> {
  return BALANCES[userId] || {};
}

export function getOrder(orderId: string) {
  const order = ORDERS.get(orderId)
  if (!order) throw new Error("Order not found");
  return order;
}