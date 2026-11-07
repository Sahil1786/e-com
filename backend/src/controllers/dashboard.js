const express = require("express");
const prisma = require("../prisma");
const { authenticate, requireAdmin } = require("../middleware/auth");
const { AppError } = require("../middleware/error");
const { getDateRange, summarizeCollections } = require("../utils/collectionReport");
// Remove the old require('../utils/analytics') if it's there

const router = express.Router();

router.get("/analytics", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const range = getDateRange(req.query);
    const page = Number(req.query.page || 1);
    const pageSize = 50;
    const search = typeof req.query.search === "string" ? req.query.search.trim().toLowerCase() : "";
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new AppError("Page must be a positive integer", 400);
    }
    if (search.length > 100) throw new AppError("Analytics search must be 100 characters or fewer", 400);
    if (range.toExclusive.getTime() - range.from.getTime() > 366 * 24 * 60 * 60 * 1000) {
      throw new AppError("Analytics date range cannot exceed 366 days", 400);
    }

    const events = await prisma.orderEvent.findMany({
      where: {
        createdAt: { gte: range.from, lt: range.toExclusive },
        type: {
          in: [
            "PAYMENT_CONFIRMED",
            "COD_COLLECTED",
            "REFUND_INITIATED",
            "PAYMENT_REFUNDED",
            "ORDER_CANCELLED",
          ],
        },
      },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            recipientName: true,
            paymentId: true,
            paymentMethod: true,
            paymentInstrument: true,
            refundedAmountPaise: true,
            totalAmountPaise: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    const report = summarizeAnalyticsEvents(events);
    const transactions = report.transactions.filter((transaction) => {
      if (!search) return true;
      return [
        transaction.order?.orderNumber,
        transaction.order?.id,
        transaction.order?.recipientName,
        transaction.order?.paymentId,
        transaction.paymentMethod,
        transaction.paymentInstrument,
        transaction.type,
        transaction.message,
      ].filter(Boolean).join(" ").toLowerCase().includes(search);
    });

    res.json({
      success: true,
      dateRange: { from: range.fromDate, to: range.toDate },
      totals: report.totals,
      daily: report.daily,
      transactions: transactions.slice((page - 1) * pageSize, page * pageSize),
      pagination: {
        page,
        pageSize,
        total: transactions.length,
        totalPages: Math.ceil(transactions.length / pageSize),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/dashboard", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const range = getDateRange(req.query);

    const [
      collectedOrders,
      readyToShipCount,
      inTransitCount,
      deliveredCount,
      paymentPendingCount,
      processingCount,
      refundPendingCount,
      cancelledCount,
      codCollectionPendingCount,
      customerCount,
    ] = await Promise.all([
      prisma.order.findMany({
        where: { paidAt: { gte: range.from, lt: range.toExclusive } },
        select: {
          paymentMethod: true,
          paymentInstrument: true,
          totalAmountPaise: true,
          refundedAmountPaise: true,
          totalGstPaise: true,
          paidAt: true,
          status: true,
        },
      }),
      prisma.order.count({ where: { status: { in: ["CONFIRMED", "PAID", "PROCESSING"] } } }),
      prisma.order.count({ where: { status: "SHIPPED" } }),
      prisma.order.count({ where: { status: "DELIVERED" } }),
      prisma.order.count({ where: { status: "PENDING" } }),
      prisma.order.count({ where: { status: "PROCESSING" } }),
      prisma.order.count({ where: { status: "REFUND_PENDING" } }),
      prisma.order.count({ where: { status: "CANCELLED" } }),
      prisma.order.count({
        where: {
          paymentMethod: "COD",
          status: "DELIVERED",
          OR: [{ paidAt: null }, { paidAt: { isSet: false } }],
        },
      }),
      prisma.user.count({ where: { role: "CUSTOMER" } }),
    ]);
    const collectionReport = summarizeCollections(collectedOrders);

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
      dateRange: { from: range.fromDate, to: range.toDate },
      customerCount,
      totals: collectionReport.totals,
      pipeline: {
        ordersReadyToShip: readyToShipCount,
        ordersInTransit: inTransitCount,
        deliveredOrders: deliveredCount,
        paymentPendingOrders: paymentPendingCount,
        processingOrders: processingCount,
        refundPendingOrders: refundPendingCount,
        cancelledOrders: cancelledCount,
        codCollectionPendingOrders: codCollectionPendingCount,
      },
      salesByDate: collectionReport.salesByDate,
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

router.get("/customers", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const page = Number(req.query.page || 1);
    const pageSize = 50;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new AppError("Page must be a positive integer", 400);
    }
    if (search.length > 100) throw new AppError("Customer search must be 100 characters or fewer", 400);

    const where = {
      role: "CUSTOMER",
      ...(search
        ? {
            OR: [
              { name: { contains: search } },
              { email: { contains: search } },
              { mobile: { contains: search } },
            ],
          }
        : {}),
    };
    const [total, customers] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          mobile: true,
          email: true,
          createdAt: true,
          _count: { select: { orders: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.json({
      success: true,
      customers,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;