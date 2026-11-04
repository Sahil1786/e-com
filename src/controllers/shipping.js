const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const {
  getShippingEstimate,
  createAndAssignShipment,
  trackByAwb,
} = require("../services/shiprocket");

// Helper: Calculate total weight (kg) & package dimensions from items
function calculatePackageMetrics(cartItems) {
  let totalWeightGrams = 0;
  let maxLengthCm = 10;
  let maxBreadthCm = 10;
  let totalHeightCm = 0;

  for (const item of cartItems) {
    const qty = item.quantity || 1;
    const p = item.product || {};
    totalWeightGrams += (p.weightGrams || 500) * qty;
    maxLengthCm = Math.max(maxLengthCm, p.lengthCm || 10);
    maxBreadthCm = Math.max(maxBreadthCm, p.breadthCm || 10);
    totalHeightCm += (p.heightCm || 5) * qty;
  }

  return {
    weightKg: Math.max(totalWeightGrams / 1000, 0.5),
    lengthCm: maxLengthCm,
    breadthCm: maxBreadthCm,
    heightCm: Math.max(totalHeightCm, 10),
  };
}

// 1. GET SHIPPING COST & DELIVERY ESTIMATE BEFORE ORDER CONFIRMATION
// POST /v1/user/shipping/estimate
router.post("/shipping/estimate", async (req, res, next) => {
  try {
    const { deliveryPincode, userId } = req.body;

    if (!/^\d{6}$/.test(String(deliveryPincode))) {
      return res.status(400).json({
        success: false,
        error: "Valid 6-digit customer delivery pincode is required",
      });
    }

    // Fetch user's cart items with product weight & dimensions
    const cartItems = await prisma.cartItem.findMany({
      where: { userId },
      include: { product: true },
    });

    const metrics = calculatePackageMetrics(cartItems);

    const estimate = await getShippingEstimate({
      pickupPincode: process.env.WAREHOUSE_PINCODE,
      deliveryPincode,
      ...metrics,
    });

    res.json({
      success: true,
      pickupPincode: process.env.WAREHOUSE_PINCODE,
      deliveryPincode,
      packageMetrics: metrics,
      estimate,
    });
  } catch (err) {
    next(err);
  }
});

// 2. CONFIRM ORDER & ASSIGN DELIVERY PARTNER + AWB TRACKING
// POST /v1/user/orders/:orderId/confirm-delivery
router.post("/orders/:orderId/confirm-delivery", async (req, res, next) => {
  try {
    const { orderId } = req.params;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: { product: true },
        },
      },
    });

    if (!order) {
      return res.status(404).json({ success: false, error: "Order not found" });
    }

    const metrics = calculatePackageMetrics(order.items);

    // Create shipment in Shiprocket & assign courier AWB
    const shipment = await createAndAssignShipment(order, order.items, metrics);

    // Save tracking details back to MongoDB Order
    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
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

    res.json({
      success: true,
      message: "Delivery partner assigned and pickup scheduled",
      order: updatedOrder,
      shipment,
    });
  } catch (err) {
    next(err);
  }
});

// 3. LIVE ORDER TRACKING ENDPOINT
// GET /v1/user/orders/:orderId/track
router.get("/orders/:orderId/track", async (req, res, next) => {
  try {
    const { orderId } = req.params;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order || !order.awbCode) {
      return res.status(404).json({
        success: false,
        error: "Tracking AWB not assigned yet for this order",
      });
    }

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

// POST /v1/webhooks/shiprocket
router.post("/webhooks/shiprocket", async (req, res) => {
    try {
      const { awb, current_status } = req.body;
      if (!awb) return res.sendStatus(200);
  
      const statusMap = {
        "PICKED UP": "SHIPPED",
        "IN TRANSIT": "SHIPPED",
        "OUT FOR DELIVERY": "SHIPPED",
        "DELIVERED": "DELIVERED",
        "CANCELED": "CANCELLED",
        "RTO DELIVERED": "REFUNDED",
      };
  
      const mappedStatus = statusMap[current_status?.toUpperCase()];
      if (mappedStatus) {
        await prisma.order.updateMany({
          where: { awbCode: String(awb) },
          data: { status: mappedStatus },
        });
      }
  
      res.status(200).json({ received: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

module.exports = router;