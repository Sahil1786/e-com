const express = require("express");
const prisma = require("../prisma");
const { authenticate, requireAdmin } = require("../middleware/auth");
const { AppError } = require("../middleware/error");
const {
  isObjectId,
  recordOrderEvent,
  setProductStock,
  uncollectedCodOrderWhere,
} = require("../utils/orderWorkflow");
const { cancelOrder } = require("../utils/cancelOrder");
const config = require("../config");
const { getRazorpay } = require("../../services/razorpay");
const { notifyOrderStatus } = require("../utils/email");

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
    const page = Number(req.query.page || 1);
    const pageSize = 50;
    const status = typeof req.query.status === "string" ? req.query.status.toUpperCase() : "";
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const statuses = [
      "PENDING", "CONFIRMED", "PAID", "PROCESSING", "SHIPPED", "DELIVERED",
      "SHIPMENT_PENDING", "CANCEL_REQUESTED", "CANCELLED", "REFUND_PENDING", "REFUNDED",
      "PAYMENT_REVIEW", "SHIPMENT_REVIEW",
    ];
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new AppError("Page must be a positive integer", 400);
    }
    if (status && !statuses.includes(status)) throw new AppError("Invalid order status", 400);
    if (search.length > 100) throw new AppError("Order search must be 100 characters or fewer", 400);

    const where = {
      ...(status ? { status } : {}),
      ...(search
        ? {
            OR: [
              { orderNumber: { contains: search } },
              { id: { contains: search } },
              { recipientName: { contains: search } },
              { phone: { contains: search } },
              { paymentReference: { contains: search } },
              { user: { is: { name: { contains: search } } } },
              { user: { is: { email: { contains: search } } } },
              { items: { some: { productName: { contains: search } } } },
            ],
          }
        : {}),
    };
    const [total, orders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
      where,
      include: {
        items: true,
        user: { select: { id: true, name: true, email: true, mobile: true } },
        events: { orderBy: { createdAt: "desc" } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      }),
    ]);
    res.json({
      success: true,
      orders,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/orders/:id/cancel", authenticate, requireAdmin, async (req, res, next) => {
  try {
    if (!isObjectId(req.params.id)) throw new AppError("Invalid order ID", 400);
    const result = await cancelOrder({
      orderId: req.params.id,
      actor: "ADMIN",
    });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.patch("/orders/:id/status", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, trackingId, courierName, trackingUrl, note } = req.body;
    if (!isObjectId(id)) throw new AppError("Invalid order ID", 400);
    if (!["PROCESSING", "SHIPPED", "DELIVERED"].includes(status)) {
      throw new AppError("Manual updates may only set PROCESSING, SHIPPED, or DELIVERED", 400);
    }
    if (trackingId !== undefined && (typeof trackingId !== "string" || trackingId.trim().length > 120)) {
      throw new AppError("Tracking ID must be a string no longer than 120 characters", 400);
    }
    if (courierName !== undefined && (typeof courierName !== "string" || courierName.trim().length > 100)) {
      throw new AppError("Courier name must be a string no longer than 100 characters", 400);
    }
    if (trackingUrl !== undefined && typeof trackingUrl !== "string") {
      throw new AppError("Tracking URL must be a string", 400);
    }
    const cleanTrackingUrl = typeof trackingUrl === "string" ? trackingUrl.trim() : "";
    if (cleanTrackingUrl) {
      let parsedUrl;
      try {
        parsedUrl = new URL(cleanTrackingUrl);
      } catch {
        throw new AppError("Tracking URL must be a valid HTTP or HTTPS URL", 400);
      }
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new AppError("Tracking URL must use HTTP or HTTPS", 400);
      }
    }

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) throw new AppError("Order not found", 404);
    if (status === "SHIPPED" && !order.stockReserved) {
      throw new AppError("Order inventory must be confirmed before shipment", 409);
    }
    const validTransition = status === "PROCESSING"
      ? ["CONFIRMED", "PAID"].includes(order.status)
      : status === "SHIPPED"
        ? ["PROCESSING", "PAID", "CONFIRMED", "SHIPMENT_REVIEW"].includes(order.status) &&
          Boolean(trackingId || order.awbCode)
        : order.status === "SHIPPED";
    if (!validTransition) {
      throw new AppError(`Order cannot transition from ${order.status} to ${status}`, 409);
    }
    const cleanTrackingId = typeof trackingId === "string" ? trackingId.trim() : "";
    const cleanCourierName = typeof courierName === "string" ? courierName.trim() : "";
    const updatedOrder = await prisma.$transaction(async (tx) => {
        const updated = await tx.order.updateMany({
          where: { id, status: order.status },
          data: {
            status,
            ...(trackingId !== undefined ? { trackingId: cleanTrackingId || null } : {}),
            ...(courierName !== undefined ? { courierName: cleanCourierName || null } : {}),
            ...(trackingUrl !== undefined ? { trackingUrl: cleanTrackingUrl || null } : {}),
          },
        });
        if (updated.count !== 1) throw new AppError("Order status changed; please retry", 409);
      await tx.orderEvent.create({
        data: {
          orderId: id,
          type: "ADMIN_STATUS_UPDATE",
          status,
          message: typeof note === "string" && note.trim()
            ? note.trim().slice(0, 500)
            : status === "SHIPPED"
              ? `Order shipped${cleanCourierName ? ` with ${cleanCourierName}` : ""}; tracking ${cleanTrackingId || order.trackingId || order.awbCode}.`
              : `Order manually marked ${status.toLowerCase()}.`,
          actor: req.user.id,
        },
      });
      return tx.order.findUnique({
        where: { id },
        include: { items: true, events: { orderBy: { createdAt: "desc" } } },
      });
    });
    if (status === "SHIPPED" || status === "DELIVERED") await notifyOrderStatus(id, status);
    res.json({
      success: true,
      order: updatedOrder,
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/orders/:id/collection", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isObjectId(id)) throw new AppError("Invalid order ID", 400);

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) throw new AppError("Order not found", 404);
    if (order.paymentMethod !== "COD") {
      throw new AppError("Only cash-on-delivery orders can be marked as cash collected", 409);
    }
    if (order.status !== "DELIVERED") {
      throw new AppError("Mark the order delivered before recording COD collection", 409);
    }
    if (order.paidAt) throw new AppError("Cash collection is already recorded for this order", 409);

    const collectedAt = new Date();
    const collectedOrder = await prisma.$transaction(async (tx) => {
      const updated = await tx.order.updateMany({
        where: uncollectedCodOrderWhere(id),
        data: { paidAt: collectedAt },
      });
      if (updated.count !== 1) throw new AppError("Order collection changed; refresh and retry", 409);
      await recordOrderEvent(tx, {
        orderId: id,
        type: "COD_COLLECTED",
        status: "DELIVERED",
        message: `Cash on delivery of ₹${(order.totalAmountPaise / 100).toFixed(2)} recorded as collected.`,
        actor: req.user.id,
        amountPaise: order.totalAmountPaise,
        paymentMethod: "COD",
      });
      return tx.order.findUnique({
        where: { id },
        include: { items: true, events: { orderBy: { createdAt: "desc" } } },
      });
    });

    res.json({ success: true, order: collectedOrder });
  } catch (err) {
    next(err);
  }
});

if (config.razorpay.configured) router.post("/orders/:id/refund", authenticate, requireAdmin, async (req, res, next) => {
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
    const updatedOrder = await prisma.$transaction(async (tx) => {
      const updated = await tx.order.update({
        where: { id },
        data: {
          status: refundedAmountPaise === order.totalAmountPaise ? "REFUNDED" : order.status,
          refundedAmountPaise,
          refundReason: reason,
          refundIds: { push: refund.id },
        },
        include: { items: true },
      });
      await recordOrderEvent(tx, {
        orderId: id,
        type: "REFUND_INITIATED",
        status: updated.status,
        message: `Admin initiated a refund of ₹${(amountPaise / 100).toFixed(2)}: ${reason}`,
        actor: req.user.id,
        amountPaise,
        paymentMethod: order.paymentMethod,
        paymentInstrument: order.paymentInstrument,
      });
      return updated;
    });
    await notifyOrderStatus(id, "REFUNDED");
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
    if (!Number.isSafeInteger(stock) || stock < 0 || stock > 2_147_483_647) {
      throw new AppError("Stock must be a non-negative integer", 400);
    }

    const updatedProduct = await prisma.$transaction((tx) => setProductStock(tx, {
      productId: id,
      stock,
      actor: req.user.id,
      note: "Manual stock count adjustment.",
      reference: typeof req.body.reference === "string" ? req.body.reference.trim().slice(0, 100) : null,
    }));
    res.json({
      success: true,
      message: stock === 0 ? "Product marked out of stock" : "Inventory updated",
      product: formatProductWithStock(updatedProduct),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/products/:id/restock", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { quantity, reference, note } = req.body;
    if (!isObjectId(id)) throw new AppError("Invalid product ID", 400);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2_147_483_647) {
      throw new AppError("Restock quantity must be a positive whole number", 400);
    }
    if (reference !== undefined && (typeof reference !== "string" || reference.trim().length > 100)) {
      throw new AppError("Stock reference must be 100 characters or fewer", 400);
    }
    if (note !== undefined && (typeof note !== "string" || note.trim().length > 500)) {
      throw new AppError("Stock note must be 500 characters or fewer", 400);
    }

    const product = await prisma.$transaction(async (tx) => {
      const current = await tx.product.findUnique({ where: { id } });
      if (!current) throw new AppError("Product not found", 404);
      const stockBefore = current.stock ?? current.quantity ?? 0;
      const stockAfter = stockBefore + quantity;
      if (stockAfter > 2_147_483_647) throw new AppError("Restock exceeds the supported stock limit", 400);
      return setProductStock(tx, {
        productId: id,
        stock: stockAfter,
        actor: req.user.id,
        note: typeof note === "string" && note.trim()
          ? note.trim()
          : "Stock received into inventory.",
        reference: typeof reference === "string" && reference.trim() ? reference.trim() : null,
        increaseType: "RESTOCK_IN",
      });
    });
    res.status(201).json({
      success: true,
      message: `Received ${quantity} units of ${product.name}`,
      product: formatProductWithStock(product),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/inventory/movements", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const page = Number(req.query.page || 1);
    const pageSize = 50;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new AppError("Page must be a positive integer", 400);
    }
    if (search.length > 100) {
      throw new AppError("Inventory search must be 100 characters or fewer", 400);
    }
    const where = search
      ? {
          OR: [
            { type: { contains: search } },
            { reference: { contains: search } },
            { note: { contains: search } },
            { product: { is: { name: { contains: search } } } },
            { order: { is: { orderNumber: { contains: search } } } },
          ],
        }
      : {};
    const [total, movements] = await Promise.all([
      prisma.productInventoryMovement.count({ where }),
      prisma.productInventoryMovement.findMany({
        where,
        include: {
          product: { select: { id: true, name: true } },
          order: { select: { id: true, orderNumber: true, recipientName: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    res.json({
      success: true,
      movements,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
