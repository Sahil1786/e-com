const express = require("express");
const prisma = require("../prisma");
const { authenticate, requireAdmin } = require("../middleware/auth");
const { AppError } = require("../middleware/error");
const { isObjectId } = require("../utils/orderWorkflow");
const config = require("../config");
const { getRazorpay } = require("../../services/razorpay");

const router = express.Router();

function formatProductWithStock(product) {
  const availableStock = product.stock ?? product.quantity ?? 0;
  return {
    ...product,
    availableStock,
    inStock: availableStock > 0,
    canBuy: availableStock > 0,
    stockStatus: availableStock > 5 ? "IN_STOCK" : availableStock > 0 ? "LOW_STOCK" : "OUT_OF_STOCK",
  };
}

router.get("/orders", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const where = req.query.status
      ? { status: String(req.query.status).toUpperCase() }
      : {};
    const orders = await prisma.order.findMany({
      where,
      include: {
        items: true,
        user: { select: { id: true, name: true, email: true, mobile: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({ success: true, orders });
  } catch (err) {
    next(err);
  }
});

router.patch("/orders/:id/status", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, trackingId } = req.body;
    if (!isObjectId(id)) throw new AppError("Invalid order ID", 400);
    if (!["SHIPPED", "DELIVERED"].includes(status)) {
      throw new AppError("Manual status updates may only mark orders SHIPPED or DELIVERED", 400);
    }

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) throw new AppError("Order not found", 404);
    if (status === "SHIPPED" && !order.stockReserved) {
      throw new AppError("Order inventory must be confirmed before shipment", 409);
    }
    const validTransition = status === "SHIPPED"
      ? ["PROCESSING", "PAID", "CONFIRMED", "SHIPMENT_REVIEW"].includes(order.status) &&
        Boolean(trackingId || order.awbCode)
      : order.status === "SHIPPED";
    if (!validTransition) {
      throw new AppError(`Order cannot transition from ${order.status} to ${status}`, 409);
    }
    const updated = await prisma.order.updateMany({
      where: { id, status: order.status },
      data: {
        status,
        trackingId: trackingId ? String(trackingId).trim() : order.trackingId,
      },
    });
    if (updated.count !== 1) throw new AppError("Order status changed; please retry", 409);
    res.json({
      success: true,
      order: await prisma.order.findUnique({ where: { id }, include: { items: true } }),
    });
  } catch (err) {
    next(err);
  }
});

if (config.razorpay.enabled) router.post("/orders/:id/refund", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const amountPaise = Number(req.body.amountPaise);
    const reason = String(req.body.reason || "Admin refund").trim().slice(0, 500);
    if (!isObjectId(id)) throw new AppError("Invalid order ID", 400);
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
      throw new AppError("A positive integer amountPaise is required", 400);
    }

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) throw new AppError("Order not found", 404);
    if (!order.paymentId || order.paymentMethod === "COD") {
      throw new AppError("Online payment reference is required for automatic refunds", 409);
    }
    if (!["PAID", "PROCESSING", "SHIPPED", "DELIVERED", "PAYMENT_REVIEW"].includes(order.status)) {
      throw new AppError(`Cannot refund an order in ${order.status} status`, 409);
    }
    if (order.refundedAmountPaise + amountPaise > order.totalAmountPaise) {
      throw new AppError("Refund exceeds the unrefunded order amount", 400);
    }

    const claimed = await prisma.order.updateMany({
      where: { id, status: order.status, refundedAmountPaise: order.refundedAmountPaise },
      data: { status: "REFUND_PENDING" },
    });
    if (claimed.count !== 1) throw new AppError("Another refund is being processed", 409);

    let refund;
    try {
      refund = await getRazorpay().payments.refund(order.paymentId, {
        amount: amountPaise,
        notes: { internalOrderId: order.id, reason },
      });
    } catch (err) {
      await prisma.order.updateMany({
        where: { id, status: "REFUND_PENDING" },
        data: { status: order.status },
      });
      throw new AppError("Razorpay could not process the refund", 502);
    }

    const refundedAmountPaise = order.refundedAmountPaise + amountPaise;
    const updatedOrder = await prisma.order.update({
      where: { id },
      data: {
        status: refundedAmountPaise === order.totalAmountPaise ? "REFUNDED" : order.status,
        refundedAmountPaise,
        refundReason: reason,
        refundIds: { push: refund.id },
      },
      include: { items: true },
    });
    res.json({ success: true, refundId: refund.id, order: updatedOrder });
  } catch (err) {
    next(err);
  }
});

router.patch("/products/:id/stock", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { stock } = req.body;
    if (!isObjectId(id)) throw new AppError("Invalid product ID", 400);
    if (!Number.isSafeInteger(stock) || stock < 0) {
      throw new AppError("Stock must be a non-negative integer", 400);
    }

    const updatedProduct = await prisma.product.update({
      where: { id },
      data: { stock },
    });
    res.json({
      success: true,
      message: stock === 0 ? "Product marked out of stock" : "Inventory updated",
      product: formatProductWithStock(updatedProduct),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
