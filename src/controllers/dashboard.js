const express = require("express");
const prisma = require("../prisma");
const { authenticate, requireAdmin } = require("../middleware/auth");

const router = express.Router();

// Admin Analytics Dashboard
router.get("/dashboard", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const paidOrders = await prisma.order.findMany({
      where: {
        status: { in: ["CONFIRMED", "PAID", "PROCESSING", "SHIPPED", "DELIVERED", "REFUNDED"] },
      },
    });

    let totalSalesPaise = 0;
    let totalRefundsPaise = 0;
    let totalGstCollectedPaise = 0;
    const salesByDateMap = {};

    for (const o of paidOrders) {
      totalSalesPaise += o.totalAmountPaise;
      totalRefundsPaise += o.refundedAmountPaise;
      if (o.status !== "REFUNDED") {
        totalGstCollectedPaise += o.totalGstPaise;
      }

      const dateKey = new Date(o.createdAt).toISOString().split("T")[0];
      if (!salesByDateMap[dateKey]) {
        salesByDateMap[dateKey] = { date: dateKey, grossPaise: 0, refundsPaise: 0, netPaise: 0 };
      }
      salesByDateMap[dateKey].grossPaise += o.totalAmountPaise;
      salesByDateMap[dateKey].refundsPaise += o.refundedAmountPaise;
      salesByDateMap[dateKey].netPaise += o.totalAmountPaise - o.refundedAmountPaise;
    }

    const [readyToShipCount, inTransitCount, deliveredCount] = await Promise.all([
      prisma.order.count({ where: { status: { in: ["CONFIRMED", "PAID", "PROCESSING"] } } }),
      prisma.order.count({ where: { status: "SHIPPED" } }),
      prisma.order.count({ where: { status: "DELIVERED" } }),
    ]);

    const topProductsRaw = await prisma.orderItem.groupBy({
      by: ["productId", "productName"],
      _sum: { quantity: true, totalPaise: true },
      orderBy: { _sum: { quantity: "desc" } },
      take: 5,
    });

    const lowStockProducts = await prisma.product.findMany({
      where: { isDeleted: false, stock: { lte: 5 } },
      orderBy: { stock: "asc" },
    });

    res.json({
      success: true,
      totals: {
        totalSalesPaise,
        totalRefundsPaise,
        netSalesPaise: totalSalesPaise - totalRefundsPaise,
        totalGstCollectedPaise,
      },
      pipeline: {
        ordersReadyToShip: readyToShipCount,
        ordersInTransit: inTransitCount,
        deliveredOrders: deliveredCount,
      },
      salesByDate: Object.values(salesByDateMap).sort((a, b) => a.date.localeCompare(b.date)),
      topSellingProducts: topProductsRaw.map((p) => ({
        productId: p.productId,
        productName: p.productName,
        unitsSold: p._sum.quantity,
        revenuePaise: p._sum.totalPaise,
      })),
      lowStockAlerts: lowStockProducts,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;