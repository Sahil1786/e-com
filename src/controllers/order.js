const express = require("express");
const prisma = require("../prisma");
const { authenticate } = require("../middleware/auth");
const config = require("../config");
const { AppError } = require("../middleware/error");
const { isObjectId, releaseInventory } = require("../utils/orderWorkflow");
const { getRazorpay } = require("../../services/razorpay");
const { generateInvoicePdf } = require("../utils/invoicePdf");

const router = express.Router();

router.post("/orders/:orderId/cancel", authenticate, async (req, res, next) => {
  try {
    const { orderId } = req.params;
    if (!isObjectId(orderId)) throw new AppError("Invalid order ID", 400);

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order || order.userId !== req.user.id) throw new AppError("Order not found", 404);
    if (order.status === "CANCELLED") {
      return res.json({ success: true, message: "Order already cancelled", order });
    }
    if (!["PENDING", "CONFIRMED", "PAID"].includes(order.status)) {
      throw new AppError(`Order cannot be cancelled in ${order.status} status`, 409);
    }
    if (order.status === "PAID" && !config.razorpay.enabled) {
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
          notes: { internalOrderId: order.id, reason: "Customer cancellation" },
        });
      } catch (err) {
        await prisma.order.updateMany({
          where: { id: order.id, status: "CANCEL_REQUESTED" },
          data: { status: order.status },
        });
        throw new AppError("Payment refund could not be completed; the order was not cancelled", 502);
      }
    }

    const cancelledOrder = await prisma.$transaction(async (tx) => {
      const current = await tx.order.findUnique({
        where: { id: order.id },
        include: { items: true },
      });
      if (current.status !== "CANCEL_REQUESTED") {
        throw new AppError("Order cancellation is already being processed", 409);
      }
      if (current.stockReserved) await releaseInventory(tx, current.items);
      if (current.couponId && order.status !== "PENDING") {
        await tx.coupon.updateMany({
          where: { id: current.couponId, usedCount: { gt: 0 } },
          data: { usedCount: { decrement: 1 } },
        });
      }

      const updated = await tx.order.update({
        where: { id: current.id },
        data: {
          status: "CANCELLED",
          stockReserved: false,
          cancellationReason: "Cancelled by customer",
          ...(refund
            ? {
                refundedAmountPaise: current.totalAmountPaise,
                refundReason: "Customer cancellation",
                refundIds: { push: refund.id },
              }
            : {}),
        },
        include: { items: true },
      });
      return updated;
    });

    res.json({
      success: true,
      message: refund ? "Order cancelled and refund initiated" : "Order cancelled",
      order: cancelledOrder,
      ...(refund ? { refundId: refund.id } : {}),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/orders/my", authenticate, async (req, res, next) => {
  try {
    const orders = await prisma.order.findMany({
      where: { userId: req.user.id },
      include: { items: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, orders });
  } catch (err) {
    next(err);
  }
});

router.get("/orders/:id/invoice", authenticate, async (req, res, next) => {
  try {
    if (!isObjectId(req.params.id)) throw new AppError("Invalid order ID", 400);
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });

    if (!order) throw new AppError("Order not found", 404);
    if (req.user.role !== "ADMIN" && order.userId !== req.user.id) {
      throw new AppError("Unauthorized to view this invoice", 403);
    }
    if (!order.invoiceNumber) {
      throw new AppError("Invoice is available after order confirmation", 400);
    }

    generateInvoicePdf(order, res);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
