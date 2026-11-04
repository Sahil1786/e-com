const express = require("express");
const prisma = require("../prisma");
const { authenticate, requireAdmin } = require("../middleware/auth");
const { AppError } = require("../middleware/error");

const router = express.Router();

// Admin: View All Orders (optional ?status=PAID)
router.get("/orders", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const where = req.query.status ? { status: String(req.query.status).toUpperCase() } : {};
    const orders = await prisma.order.findMany({
      where,
      include: {
        items: true,
        user: { select: { id: true, name: true, email: true, mobile: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, orders });
  } catch (err) {
    next(err);
  }
});

// Admin: Update Order Status (PROCESSING, SHIPPED + trackingId, DELIVERED)
router.patch("/orders/:id/status", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const orderId = Number(req.params.id);
    const { status, trackingId } = req.body;
    const allowedStatuses = ["PROCESSING", "SHIPPED", "DELIVERED"];

    if (!allowedStatuses.includes(status)) {
      throw new AppError(`Allowed status updates: ${allowedStatuses.join(", ")}`);
    }
    if (status === "SHIPPED" && !trackingId) {
      throw new AppError("Tracking ID is required when marking an order as SHIPPED");
    }

    const order = await prisma.order.update({
      where: { id: orderId },
      data: {
        status,
        trackingId: trackingId !== undefined ? trackingId : undefined,
      },
      include: { items: true },
    });

    res.json({ success: true, order });
  } catch (err) {
    next(err);
  }
});

// Admin: Partial or Full Refund
router.post("/orders/:id/refund", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const orderId = Number(req.params.id);
    const { amountPaise, reason } = req.body;
    const refundIncrement = Number(amountPaise);

    if (!refundIncrement || refundIncrement <= 0) {
      throw new AppError("Valid positive refund amount in paise is required");
    }

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new AppError("Order not found", 404);
    if (["PENDING", "CANCELLED"].includes(order.status)) {
      throw new AppError("Cannot refund an unpaid order");
    }

    const totalRefunded = order.refundedAmountPaise + refundIncrement;
    if (totalRefunded > order.totalAmountPaise) {
      throw new AppError("Total refund cannot exceed total order paid amount");
    }

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: {
        refundedAmountPaise: totalRefunded,
        refundReason: reason || order.refundReason || "Admin refund adjustment",
        status: totalRefunded === order.totalAmountPaise ? "REFUNDED" : order.status,
      },
      include: { items: true },
    });

    res.json({ success: true, order: updated });
  } catch (err) {
    next(err);
  }
});
// PATCH /v1/admin/products/:id/stock
router.patch("/admin/products/:id/stock", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { stock } = req.body; // Pass { "stock": 0 } for Out of Stock, or { "stock": 50 } to restock

    if (typeof stock !== "number" || stock < 0) {
      return res.status(400).json({
        success: false,
        error: "Stock must be a non-negative number (0 or greater)",
      });
    }

    const updatedProduct = await prisma.product.update({
      where: { id },
      data: { stock },
    });

    res.json({
      success: true,
      message: stock === 0 ? "Product marked Out of Stock" : "Inventory updated",
      product: formatProductWithStock(updatedProduct),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;