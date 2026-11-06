const prisma = require("../prisma");
const config = require("../config");
const { AppError } = require("../middleware/error");
const { releaseInventory, recordOrderEvent } = require("./orderWorkflow");
const { getRazorpay } = require("../../services/razorpay");
const { notifyOrderStatus } = require("./email");

async function cancelOrder({ orderId, expectedUserId, actor }) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order || (expectedUserId && order.userId !== expectedUserId)) {
    throw new AppError("Order not found", 404);
  }
  if (order.status === "CANCELLED") {
    return { order, message: "Order already cancelled", refundId: null };
  }
  if (!["PENDING", "CONFIRMED", "PAID"].includes(order.status)) {
    throw new AppError(`Order cannot be cancelled in ${order.status} status`, 409);
  }
  if (order.status === "PAID" && !config.razorpay.configured) {
    throw new AppError("Online refunds are disabled; contact support to cancel this prepaid order", 503);
  }

  const claimed = await prisma.order.updateMany({
    where: { id: order.id, status: order.status },
    data: { status: "CANCEL_REQUESTED" },
  });
  if (claimed.count !== 1) throw new AppError("Order status changed; please retry", 409);

  let refund;
  if (order.status === "PAID") {
    if (!order.paymentId) {
      await prisma.order.updateMany({
        where: { id: order.id, status: "CANCEL_REQUESTED" },
        data: { status: "PAYMENT_REVIEW" },
      });
      throw new AppError("Paid order has no payment reference; contact support", 409);
    }
    try {
      refund = await getRazorpay().payments.refund(order.paymentId, {
        amount: order.totalAmountPaise - order.refundedAmountPaise,
        notes: { internalOrderId: order.id, reason: `Order cancelled by ${actor.toLowerCase()}` },
      });
    } catch (error) {
      await prisma.order.updateMany({
        where: { id: order.id, status: "CANCEL_REQUESTED" },
        data: { status: order.status },
      });
      throw new AppError("Payment refund could not be completed; the order was not cancelled", 502);
    }
  }

  const reason = `Cancelled by ${actor.toLowerCase()}`;
  const cancelledOrder = await prisma.$transaction(async (tx) => {
    const current = await tx.order.findUnique({
      where: { id: order.id },
      include: { items: true },
    });
    if (!current || current.status !== "CANCEL_REQUESTED") {
      throw new AppError("Order cancellation is already being processed", 409);
    }
    if (current.stockReserved) {
      await releaseInventory(tx, current.items, { orderId: current.id, actor });
    }
    if (current.couponId && order.status !== "PENDING") {
      await tx.coupon.updateMany({
        where: { id: current.couponId, usedCount: { gt: 0 } },
        data: { usedCount: { decrement: 1 } },
      });
    }

    await tx.order.update({
      where: { id: current.id },
      data: {
        status: "CANCELLED",
        stockReserved: false,
        cancellationReason: reason,
        ...(refund
          ? {
              refundedAmountPaise: current.totalAmountPaise,
              refundReason: reason,
              refundIds: { push: refund.id },
            }
          : {}),
      },
    });
    if (refund) {
      await recordOrderEvent(tx, {
        orderId: current.id,
        type: "REFUND_INITIATED",
        status: "CANCELLED",
        message: `Full refund of ₹${(order.totalAmountPaise / 100).toFixed(2)} initiated after order cancellation.`,
        actor,
        amountPaise: current.totalAmountPaise,
        paymentMethod: current.paymentMethod,
        paymentInstrument: current.paymentInstrument,
      });
    }
    await recordOrderEvent(tx, {
      orderId: current.id,
      type: "ORDER_CANCELLED",
      status: "CANCELLED",
      message: `Order cancelled by ${actor.toLowerCase()}.`,
      actor,
      amountPaise: current.totalAmountPaise,
      paymentMethod: current.paymentMethod,
      paymentInstrument: current.paymentInstrument,
    });
    return tx.order.findUnique({
      where: { id: current.id },
      include: { items: true, events: { orderBy: { createdAt: "desc" } } },
    });
  });

  await notifyOrderStatus(cancelledOrder.id, "CANCELLED");
  return {
    order: cancelledOrder,
    message: refund ? "Order cancelled and full refund initiated" : "Order cancelled",
    refundId: refund?.id || null,
  };
}

module.exports = { cancelOrder };
