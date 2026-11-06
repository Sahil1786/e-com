const express = require("express");
const crypto = require("crypto");
const prisma = require("../prisma");
const config = require("../config");
const { authenticate, requireAdmin } = require("../middleware/auth");
const { AppError } = require("../middleware/error");
const { calculateCartAndTax, validateCoupon } = require("../utils/gst");
const { shippingChargeFor } = require("../utils/orderWorkflow");
const {
  calculatePackageMetrics,
  createAndAssignShipment,
  trackByAwb,
} = require("../../services/shiprocket");
const { isObjectId, recordOrderEvent } = require("../utils/orderWorkflow");
const { notifyOrderStatus } = require("../utils/email");
const { getCurrentStoreSettings } = require("../utils/storeSettings");

const userRouter = express.Router();
const adminRouter = express.Router();
const webhookRouter = express.Router();

userRouter.post("/shipping/estimate", authenticate, async (req, res, next) => {
  try {
    const { deliveryPincode, couponCode, state } = req.body;
    if (!/^[1-9]\d{5}$/.test(String(deliveryPincode || ""))) {
      throw new AppError("A valid 6-digit delivery pincode is required", 400);
    }

    const cartItems = await prisma.cartItem.findMany({
      where: { userId: req.user.id },
      include: { product: true },
    });
    const activeItems = cartItems.filter((item) => item.product.isDeleted !== true);
    if (activeItems.length === 0) throw new AppError("Your cart is empty", 400);

    const metrics = calculatePackageMetrics(activeItems);
    const coupon = couponCode
      ? await prisma.coupon.findUnique({ where: { code: String(couponCode).trim().toUpperCase() } })
      : null;
    const subtotalPaise = activeItems.reduce((sum, item) => {
      const price = item.product.pricePaise ?? Math.round((item.product.price || 0) * 100);
      return sum + price * item.quantity;
    }, 0);
    if (couponCode) validateCoupon(coupon, activeItems, subtotalPaise);
    const summary = calculateCartAndTax(activeItems, coupon, state);
    const storeSettings = await getCurrentStoreSettings();
    const shippingChargePaise = shippingChargeFor(summary, storeSettings);
    const estimate = {
      serviceable: true,
      method: "free-shipping-threshold",
      estimatedCostPaise: shippingChargePaise,
      estimatedCostRupees: shippingChargePaise / 100,
    };
    res.json({
      success: true,
      ...(config.shiprocket.enabled ? { pickupPincode: config.shiprocket.warehousePincode } : {}),
      deliveryPincode,
      packageMetrics: metrics,
      estimate,
      summary: {
        ...summary,
        shippingChargePaise,
        totalAmountPaise: summary.totalAmountPaise + shippingChargePaise,
      },
    });
  } catch (err) {
    next(err);
  }
});

if (config.shiprocket.enabled) {
  userRouter.get("/orders/:orderId/track", authenticate, async (req, res, next) => {
    try {
      if (!isObjectId(req.params.orderId)) throw new AppError("Invalid order ID", 400);
      const order = await prisma.order.findFirst({
        where: { id: req.params.orderId, userId: req.user.id },
      });
      if (!order) throw new AppError("Order not found", 404);
      if (!order.awbCode) throw new AppError("Tracking is not available yet", 404);

      const liveTracking = await trackByAwb(order.awbCode);
      res.json({
        success: true,
        orderStatus: order.status,
        courierName: order.courierName,
        awbCode: order.awbCode,
        trackingUrl: order.trackingUrl,
        liveTracking: liveTracking.tracking_data,
      });
    } catch (err) {
      next(err);
    }
  });
}

if (config.shiprocket.enabled) {
  adminRouter.post("/orders/:orderId/ship", authenticate, requireAdmin, async (req, res, next) => {
    try {
      const { orderId } = req.params;
      if (!isObjectId(orderId)) throw new AppError("Invalid order ID", 400);
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
          items: { include: { product: true } },
          user: { select: { email: true } },
        },
      });
      if (!order) throw new AppError("Order not found", 404);
      if (!["PAID", "CONFIRMED"].includes(order.status)) {
        throw new AppError("Only paid online or confirmed COD orders may be shipped", 409);
      }
      if (!order.stockReserved) {
        throw new AppError("Order inventory is not confirmed", 409);
      }
      if (order.shipmentId) throw new AppError("A shipment is already assigned to this order", 409);

      const claimed = await prisma.order.updateMany({
        where: { id: order.id, status: order.status, shipmentId: null },
        data: { status: "SHIPMENT_PENDING" },
      });
      if (claimed.count !== 1) {
        throw new AppError("Shipment is already being processed for this order", 409);
      }

      const metrics = calculatePackageMetrics(order.items);
      let shipment;
      try {
        shipment = await createAndAssignShipment(order, order.items, metrics);
      } catch (err) {
        await prisma.order.updateMany({
          where: { id: order.id, status: "SHIPMENT_PENDING" },
          data: { status: "SHIPMENT_REVIEW" },
        });
        throw err;
      }
      const updatedOrder = await prisma.$transaction(async (tx) => {
        const updated = await tx.order.updateMany({
          where: { id: order.id, status: "SHIPMENT_PENDING" },
          data: {
            status: "PROCESSING",
            totalWeightKg: metrics.weightKg,
            shiprocketOrderId: shipment.shiprocketOrderId,
            shipmentId: shipment.shipmentId,
            awbCode: shipment.awbCode,
            courierName: shipment.courierName,
            trackingId: shipment.awbCode,
            trackingUrl: shipment.trackingUrl,
          },
        });
        if (updated.count !== 1) {
          throw new AppError(
            "Shipment was created, but the order changed concurrently. Reconcile this shipment with Shiprocket.",
            409
          );
        }
        await recordOrderEvent(tx, {
          orderId: order.id,
          type: "SHIPMENT_CREATED",
          status: "PROCESSING",
          message: `Shipment created with ${shipment.courierName || "courier"}; tracking ${shipment.awbCode}.`,
          actor: req.user.id,
        });
        return tx.order.findUnique({
          where: { id: order.id },
          include: { items: true, events: { orderBy: { createdAt: "desc" } } },
        });
      });
      res.json({ success: true, order: updatedOrder, shipment });
    } catch (err) {
      next(err);
    }
  });

  adminRouter.get("/orders/:orderId/track", authenticate, requireAdmin, async (req, res, next) => {
    try {
      if (!isObjectId(req.params.orderId)) throw new AppError("Invalid order ID", 400);
      const order = await prisma.order.findUnique({ where: { id: req.params.orderId } });
      if (!order) throw new AppError("Order not found", 404);
      if (!order.awbCode) throw new AppError("Tracking is not available yet", 404);
      const liveTracking = await trackByAwb(order.awbCode);
      res.json({ success: true, orderStatus: order.status, liveTracking: liveTracking.tracking_data });
    } catch (err) {
      next(err);
    }
  });

  webhookRouter.post("/shiprocket", async (req, res, next) => {
    try {
      const configuredToken = config.shiprocket.webhookToken;
      const receivedToken = req.get("x-shiprocket-token") || "";
      const expected = Buffer.from(configuredToken);
      const received = Buffer.from(receivedToken);
      if (
        !configuredToken ||
        expected.length !== received.length ||
        !crypto.timingSafeEqual(expected, received)
      ) {
        throw new AppError("Invalid Shiprocket webhook credentials", 401);
      }

      const awbCode = req.body?.awb;
      const currentStatus = String(req.body?.current_status || "").toUpperCase();
      if (!awbCode || !currentStatus) {
        throw new AppError("Shiprocket webhook is missing AWB or status", 400);
      }
      const statusMap = {
        "PICKED UP": "SHIPPED",
        "IN TRANSIT": "SHIPPED",
        "OUT FOR DELIVERY": "SHIPPED",
        DELIVERED: "DELIVERED",
        CANCELED: "RETURNING",
        CANCELLED: "RETURNING",
        "RTO INITIATED": "RETURNING",
        "RTO DELIVERED": "RETURNED",
      };
      const status = statusMap[currentStatus];
      if (status) {
        const orders = await prisma.order.findMany({
          where: {
            awbCode: String(awbCode),
            status: { in: ["PROCESSING", "SHIPPED", "RETURNING"] },
          },
        });
        for (const order of orders) {
          await prisma.$transaction(async (tx) => {
            const updated = await tx.order.updateMany({
              where: { id: order.id, status: order.status },
              data: { status },
            });
            if (updated.count !== 1) return;
            await recordOrderEvent(tx, {
              orderId: order.id,
              type: "SHIPROCKET_STATUS",
              status,
              message: `Courier tracking updated order to ${status.toLowerCase()}.`,
            });
          });
          if (status === "SHIPPED" || status === "DELIVERED") {
            await notifyOrderStatus(order.id, status);
          }
        }
      }
      res.status(200).json({ received: true });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { userRouter, adminRouter, webhookRouter };
