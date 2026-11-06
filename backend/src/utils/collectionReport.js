const { AppError } = require("../middleware/error");
const INDIA_OFFSET_MS = 330 * 60 * 1000;

function indiaDateString(date) {
  return new Date(date.getTime() + INDIA_OFFSET_MS).toISOString().slice(0, 10);
}

function parseDate(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError(`${field} must use YYYY-MM-DD format`, 400);
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new AppError(`${field} is not a valid date`, 400);
  }
  return new Date(date.getTime() - INDIA_OFFSET_MS);
}

function getDateRange(query, now = new Date()) {
  const indiaNow = new Date(now.getTime() + INDIA_OFFSET_MS);
  const today = Date.UTC(indiaNow.getUTCFullYear(), indiaNow.getUTCMonth(), indiaNow.getUTCDate());
  const to = query.to
    ? parseDate(query.to, "to")
    : new Date(today - INDIA_OFFSET_MS);
  const from = query.from
    ? parseDate(query.from, "from")
    : new Date(to.getTime() - 29 * 24 * 60 * 60 * 1000);
  const toExclusive = new Date(to.getTime() + 24 * 60 * 60 * 1000);

  if (from >= toExclusive) {
    throw new AppError("The report start date must be on or before its end date", 400);
  }

  return { from, toExclusive, fromDate: indiaDateString(from), toDate: indiaDateString(to) };
}

function summarizeCollections(orders) {
  const totals = {
    totalCollectedPaise: 0,
    onlineCollectedPaise: 0,
    onlineCardCollectedPaise: 0,
    onlineUpiCollectedPaise: 0,
    otherOnlineCollectedPaise: 0,
    cashCollectedPaise: 0,
    totalRefundsPaise: 0,
    totalGstCollectedPaise: 0,
  };
  const byDate = new Map();

  for (const order of orders) {
    if (!order.paidAt) continue;

    const date = indiaDateString(new Date(order.paidAt));
    const isCash = order.paymentMethod === "COD";
    const instrument = String(order.paymentInstrument || "").toLowerCase();
    const collectionType = isCash
      ? "cashCollectedPaise"
      : instrument === "card"
        ? "onlineCardCollectedPaise"
        : instrument === "upi"
          ? "onlineUpiCollectedPaise"
          : "otherOnlineCollectedPaise";
    const amount = order.totalAmountPaise;
    const day = byDate.get(date) || {
      date,
      grossPaise: 0,
      onlineCollectedPaise: 0,
      onlineCardCollectedPaise: 0,
      onlineUpiCollectedPaise: 0,
      otherOnlineCollectedPaise: 0,
      cashCollectedPaise: 0,
      totalCollectedPaise: 0,
      refundsPaise: 0,
      netPaise: 0,
    };

    totals[collectionType] += amount;
    if (!isCash) totals.onlineCollectedPaise += amount;
    totals.totalCollectedPaise += amount;
    totals.totalRefundsPaise += order.refundedAmountPaise || 0;
    if (order.status !== "REFUNDED") totals.totalGstCollectedPaise += order.totalGstPaise || 0;

    day[collectionType] += amount;
    if (!isCash) day.onlineCollectedPaise += amount;
    day.grossPaise += amount;
    day.totalCollectedPaise += amount;
    day.refundsPaise += order.refundedAmountPaise || 0;
    day.netPaise += amount - (order.refundedAmountPaise || 0);
    byDate.set(date, day);
  }

  totals.netSalesPaise = totals.totalCollectedPaise - totals.totalRefundsPaise;
  return {
    totals,
    salesByDate: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function amountFromEvent(event) {
  if (Number.isSafeInteger(event.amountPaise)) return event.amountPaise;
  if (["ORDER_CANCELLED", "PAYMENT_CONFIRMED", "COD_COLLECTED"].includes(event.type)) {
    return event.order?.totalAmountPaise || 0;
  }
  if (event.type === "PAYMENT_REFUNDED") return event.order?.refundedAmountPaise || 0;
  const match = event.message?.match(/₹\s*([\d,]+(?:\.\d{1,2})?)/);
  return match ? Math.round(Number(match[1].replaceAll(",", "")) * 100) : 0;
}

function collectionCategory(event) {
  const paymentMethod = event.paymentMethod || event.order?.paymentMethod;
  if (paymentMethod === "COD") return "cashPaise";
  const instrument = String(event.paymentInstrument || event.order?.paymentInstrument || "").toLowerCase();
  if (instrument === "upi") return "upiPaise";
  if (instrument === "card") return "cardPaise";
  if (["netbanking", "wallet"].includes(instrument)) return "bankPaise";
  return "otherOnlinePaise";
}

function summarizeAnalyticsEvents(events) {
  const totals = {
    grossCollectedPaise: 0,
    cashPaise: 0,
    cardPaise: 0,
    upiPaise: 0,
    bankPaise: 0,
    otherOnlinePaise: 0,
    refundedPaise: 0,
    cancelledPaise: 0,
    netCollectedPaise: 0,
    paymentCount: 0,
    refundCount: 0,
    cancelledCount: 0,
  };
  const byDate = new Map();
  const transactionEvents = new Set([
    "PAYMENT_CONFIRMED",
    "COD_COLLECTED",
    "REFUND_INITIATED",
    "PAYMENT_REFUNDED",
    "ORDER_CANCELLED",
  ]);
  const transactions = events
    .filter((event) => transactionEvents.has(event.type))
    .map((event) => {
      const amountPaise = amountFromEvent(event);
      const date = indiaDateString(new Date(event.createdAt));
      const day = byDate.get(date) || {
        date,
        grossCollectedPaise: 0,
        refundedPaise: 0,
        cancelledPaise: 0,
        netCollectedPaise: 0,
      };
      if (event.type === "PAYMENT_CONFIRMED" || event.type === "COD_COLLECTED") {
        totals.grossCollectedPaise += amountPaise;
        totals[collectionCategory(event)] += amountPaise;
        totals.paymentCount += 1;
        day.grossCollectedPaise += amountPaise;
        day.netCollectedPaise += amountPaise;
      } else if (event.type === "REFUND_INITIATED" || event.type === "PAYMENT_REFUNDED") {
        totals.refundedPaise += amountPaise;
        totals.refundCount += 1;
        day.refundedPaise += amountPaise;
        day.netCollectedPaise -= amountPaise;
      } else {
        totals.cancelledPaise += amountPaise;
        totals.cancelledCount += 1;
        day.cancelledPaise += amountPaise;
      }
      byDate.set(date, day);
      return {
        id: event.id,
        type: event.type,
        status: event.status,
        message: event.message,
        amountPaise,
        paymentMethod: event.paymentMethod || event.order?.paymentMethod || null,
        paymentInstrument: event.paymentInstrument || event.order?.paymentInstrument || null,
        createdAt: event.createdAt,
        order: event.order ? {
          id: event.order.id,
          orderNumber: event.order.orderNumber,
          recipientName: event.order.recipientName,
          paymentId: event.order.paymentId,
        } : null,
      };
    });

  totals.netCollectedPaise = totals.grossCollectedPaise - totals.refundedPaise;
  return {
    totals,
    daily: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    transactions,
  };
}

module.exports = {
  getDateRange,
  summarizeCollections,
  summarizeAnalyticsEvents,
};
