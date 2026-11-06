const express = require("express");
const prisma = require("../prisma");
const { authenticate } = require("../middleware/auth");
const { AppError } = require("../middleware/error");
const { isObjectId } = require("../utils/orderWorkflow");
const { generateInvoicePdf } = require("../utils/invoicePdf");
const { cancelOrder } = require("../utils/cancelOrder");

const router = express.Router();

router.post("/orders/:orderId/cancel", authenticate, async (req, res, next) => {
  try {
    const { orderId } = req.params;
    if (!isObjectId(orderId)) throw new AppError("Invalid order ID", 400);
    const result = await cancelOrder({
      orderId,
      expectedUserId: req.user.id,
      actor: "CUSTOMER",
    });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.get("/orders/my", authenticate, async (req, res, next) => {
  try {
    const orders = await prisma.order.findMany({
      where: { userId: req.user.id },
      include: { items: true, events: { orderBy: { createdAt: "desc" } } },
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
      include: { items: true, events: { orderBy: { createdAt: "desc" } } },
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
