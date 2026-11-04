const express = require("express");
const crypto = require("crypto");
const prisma = require("../prisma");
const config = require("../config");
const { authenticate } = require("../middleware/auth");
const { calculateCartAndTax, validateCoupon } = require("../utils/gst");
const { AppError } = require("../middleware/error");
const {
  isObjectId,
  validateShippingAddress,
  invoiceNumberFor,
  reserveInventory,
} = require("../utils/orderWorkflow");
const { calculatePackageMetrics, getShippingEstimate } = require("../../services/shiprocket");
const { getRazorpay } = require("../../services/razorpay");
const { checkoutLimiter } = require("../middleware/rateLimit");

const router = express.Router();
const codRouter = express.Router();
const webhookRouter = express.Router();

async function getCheckoutItems(userId, mode, productId, quantity) {
  if (mode === "DIRECT") {
    if (!isObjectId(productId) || !Number.isSafeInteger(quantity) || quantity < 1) {
      throw new AppError("Valid productId and positive integer quantity are required", 400);
    }
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product || product.isDeleted === true) {
      throw new AppError("Product not found", 404);
    }
    return [{ productId: product.id, quantity, product }];
  }

  if (mode !== "CART") throw new AppError("Checkout mode must be CART or DIRECT", 400);
  const items = await prisma.cartItem.findMany({
    where: { userId },
    include: { product: true },
  });
  const activeItems = items.filter((item) => item.product.isDeleted !== true);
  if (activeItems.length === 0) throw new AppError("Your cart is empty", 400);
  return activeItems;
}

function assertCheckoutStock(items) {
  for (const item of items) {
    const availableStock = item.product.stock ?? item.product.quantity ?? 0;
    if (availableStock < item.quantity) {
      throw new AppError(
        `Insufficient stock for "${item.product.name}". Available: ${availableStock}`,
        409
      );
    }
  }
}

async function getCoupon(code, items, subtotalPaise) {
  if (!code) return null;
  const coupon = await prisma.coupon.findUnique({
    where: { code: String(code).trim().toUpperCase() },
  });
  validateCoupon(coupon, items, subtotalPaise);
  return coupon;
}

function orderTotals(summary, shippingChargePaise) {
  const totalAmountPaise = summary.totalAmountPaise + shippingChargePaise;
  if (!Number.isSafeInteger(totalAmountPaise) || totalAmountPaise < 100) {
    throw new AppError("Minimum order payable amount must be at least ₹1", 400);
  }
  return totalAmountPaise;
}

function orderData({ userId, address, summary, coupon, shippingChargePaise, metrics, mode, paymentMethod }) {
  return {
    userId,
    status: "PENDING",
    paymentMethod,
    checkoutMode: mode,
    subtotalPaise: summary.subtotalPaise,
    discountPaise: summary.discountPaise,
    taxableAmountPaise: summary.taxableAmountPaise,
    cgstPaise: summary.cgstPaise,
    sgstPaise: summary.sgstPaise,
    igstPaise: summary.igstPaise,
    totalGstPaise: summary.totalGstPaise,
    totalAmountPaise: orderTotals(summary, shippingChargePaise),
    recipientName: address.recipientName,
    phone: address.phone,
    addressLine: address.addressLine,
    city: address.city,
    state: address.state,
    pincode: address.pincode,
    buyerGstin: address.buyerGstin,
    couponId: coupon?.id || null,
    shippingChargePaise,
    totalWeightKg: metrics.weightKg,
    items: { create: summary.items },
  };
}

async function incrementCouponUsage(tx, couponId) {
  if (!couponId) return;
  const coupon = await tx.coupon.findUnique({ where: { id: couponId } });
  if (!coupon || !coupon.isActive || (coupon.expiresAt && coupon.expiresAt < new Date()) ||
      (coupon.usageLimit !== null && coupon.usageLimit !== undefined &&
        coupon.usedCount >= coupon.usageLimit)) {
    throw new AppError("Coupon is no longer available", 409);
  }
  const updated = await tx.coupon.updateMany({
    where: { id: couponId, isActive: true, usedCount: coupon.usedCount },
    data: { usedCount: { increment: 1 } },
  });
  if (updated.count !== 1) throw new AppError("Coupon was just used; please retry", 409);
}

function safeEqualHex(expected, actual) {
  if (!/^[a-f0-9]{64}$/i.test(actual || "")) return false;
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  return expectedBuffer.length === actualBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

async function processCapturedPayment({
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
    userId,
  }) {
    const order = await prisma.order.findUnique({
      where: { razorpayOrderId },
      include: { items: true },
    });
    if (!order || (userId && order.userId !== userId)) {
      throw new AppError("Order not found", 404);
    }
    if (
      ["PAID", "REFUNDED", "PAYMENT_REVIEW"].includes(order.status) &&
      order.paymentId === razorpayPaymentId
    ) {
      return {
        order,
        alreadyProcessed: true,
        refunded: order.status === "REFUNDED",
        needsReview: order.status === "PAYMENT_REVIEW",
      };
    }

    const razorpay = getRazorpay();
    const payment = await razorpay.payments.fetch(razorpayPaymentId);
    if (
      payment.order_id !== razorpayOrderId ||
      payment.amount !== order.totalAmountPaise ||
      payment.currency !== "INR" ||
      payment.status !== "captured"
    ) {
      throw new AppError("Razorpay payment is not captured for the expected amount", 409);
    }

    const persistRefundReview = async (reason) => {
      await prisma.order.updateMany({
        where: {
          id: order.id,
          status: { in: ["PENDING", "CANCEL_REQUESTED", "CANCELLED"] },
        },
        data: {
          status: "PAYMENT_REVIEW",
          paymentId: razorpayPaymentId,
          razorpaySignature: razorpaySignature || undefined,
          paidAt: new Date(),
          refundReason: reason,
        },
      });
      return prisma.order.findUnique({ where: { id: order.id }, include: { items: true } });
    };

    if (["CANCELLED", "CANCEL_REQUESTED"].includes(order.status)) {
      try {
        const refund = await razorpay.payments.refund(razorpayPaymentId, {
          amount: order.totalAmountPaise,
          notes: { internalOrderId: order.id, reason: "Payment captured after order cancellation" },
        });
        await prisma.order.updateMany({
          where: { id: order.id, status: { in: ["CANCELLED", "CANCEL_REQUESTED"] } },
          data: {
            status: "REFUNDED",
            paymentId: razorpayPaymentId,
            razorpaySignature: razorpaySignature || undefined,
            paidAt: new Date(),
            refundedAmountPaise: order.totalAmountPaise,
            refundReason: "Payment captured after cancellation; full refund initiated",
            refundIds: { push: refund.id },
          },
        });
        return {
          order: await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } }),
          refunded: true,
        };
      } catch (err) {
        return {
          order: await persistRefundReview(
            "Captured payment after cancellation requires manual refund reconciliation"
          ),
          needsReview: true,
        };
      }
    }
    if (order.status !== "PENDING") {
      throw new AppError(`Order cannot be paid in ${order.status} status`, 409);
    }

    try {
      const updatedOrder = await prisma.$transaction(async (tx) => {
        const freshOrder = await tx.order.findUnique({
          where: { id: order.id },
          include: { items: true },
        });
        if (freshOrder.status === "PAID" && freshOrder.paymentId === razorpayPaymentId) {
          return freshOrder;
        }
        if (freshOrder.status !== "PENDING") {
          throw new AppError(`Order cannot be paid in ${freshOrder.status} status`, 409);
        }

        await reserveInventory(tx, freshOrder.items);
        await incrementCouponUsage(tx, freshOrder.couponId);

        if (freshOrder.checkoutMode === "CART") {
          await tx.cartItem.deleteMany({
            where: {
              userId: freshOrder.userId,
              productId: { in: freshOrder.items.map((item) => item.productId) },
            },
          });
        }

        const changed = await tx.order.updateMany({
          where: { id: freshOrder.id, status: "PENDING" },
          data: {
            status: "PAID",
            paymentId: razorpayPaymentId,
            razorpaySignature: razorpaySignature || undefined,
            paidAt: new Date(),
            invoiceNumber: invoiceNumberFor(freshOrder.id),
            stockReserved: true,
          },
        });
        if (changed.count !== 1) throw new AppError("Order payment was already processed", 409);
        return tx.order.findUnique({ where: { id: freshOrder.id }, include: { items: true } });
      });
      return { order: updatedOrder };
    } catch (err) {
      if (err.statusCode !== 409) throw err;
      try {
        const refund = await razorpay.payments.refund(razorpayPaymentId, {
          amount: order.totalAmountPaise,
          notes: { internalOrderId: order.id, reason: "Inventory unavailable after payment" },
        });
        await prisma.order.updateMany({
          where: { id: order.id, status: { in: ["PENDING", "CANCEL_REQUESTED", "CANCELLED"] } },
          data: {
            status: "REFUNDED",
            paymentId: razorpayPaymentId,
            razorpaySignature: razorpaySignature || undefined,
            paidAt: new Date(),
            refundedAmountPaise: order.totalAmountPaise,
            refundReason: "Payment automatically refunded because inventory was unavailable",
            refundIds: { push: refund.id },
          },
        });
        return {
          order: await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } }),
          refunded: true,
        };
      } catch (refundErr) {
        const reviewOrder = await persistRefundReview(
          "Captured payment requires manual refund reconciliation"
        );
        return { order: reviewOrder, needsReview: true };
      }
    }
}

router.post("/checkout/create-order", checkoutLimiter, authenticate, async (req, res, next) => {
  try {
    const { mode = "CART", productId, quantity = 1, couponCode } = req.body;
    const normalizedMode = String(mode).toUpperCase();
    const address = validateShippingAddress(req.body.shippingAddress || req.body);
    const items = await getCheckoutItems(
      req.user.id,
      normalizedMode,
      productId,
      Number(quantity)
    );
    assertCheckoutStock(items);

    const coupon = await getCoupon(
      couponCode,
      items,
      items.reduce(
        (sum, item) => sum + (item.product.pricePaise ?? Math.round((item.product.price || 0) * 100)) * item.quantity,
        0
      )
    );
    const summary = calculateCartAndTax(items, coupon, address.state);
    const metrics = calculatePackageMetrics(items);
    const estimate = config.shiprocket.enabled
      ? await getShippingEstimate({ deliveryPincode: address.pincode, ...metrics })
      : {
          serviceable: true,
          method: "configured",
          estimatedCostPaise: config.shippingChargePaise,
          estimatedCostRupees: config.shippingChargePaise / 100,
        };
    const data = orderData({
      userId: req.user.id,
      address,
      summary,
      coupon,
      shippingChargePaise: estimate.estimatedCostPaise,
      metrics,
      mode: normalizedMode,
      paymentMethod: "RAZORPAY",
    });
    const order = await prisma.order.create({
      data,
      include: { items: true },
    });

    let razorpayOrder;
    try {
      razorpayOrder = await getRazorpay().orders.create({
        amount: data.totalAmountPaise,
        currency: "INR",
        receipt: order.id,
        notes: {
          userId: req.user.id,
          internalOrderId: order.id,
          checkoutMode: normalizedMode,
        },
      });
      await prisma.order.update({
        where: { id: order.id },
        data: { razorpayOrderId: razorpayOrder.id },
      });
    } catch (err) {
      await prisma.order.delete({ where: { id: order.id } });
      throw err;
    }

    res.status(201).json({
      success: true,
      mode: normalizedMode,
      razorpayKeyId: config.razorpay.keyId,
      razorpayOrderId: razorpayOrder.id,
      amountPaise: data.totalAmountPaise,
      currency: "INR",
      shippingEstimate: estimate,
      order: { ...order, razorpayOrderId: razorpayOrder.id },
      summary: { ...summary, shippingChargePaise: estimate.estimatedCostPaise, totalAmountPaise: data.totalAmountPaise },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/checkout/verify-payment", checkoutLimiter, authenticate, async (req, res, next) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (
      typeof razorpay_order_id !== "string" ||
      !/^order_[A-Za-z0-9]+$/.test(razorpay_order_id) ||
      typeof razorpay_payment_id !== "string" ||
      !/^pay_[A-Za-z0-9]+$/.test(razorpay_payment_id) ||
      typeof razorpay_signature !== "string"
    ) {
      throw new AppError("Missing Razorpay payment verification details", 400);
    }

    const signature = crypto
      .createHmac("sha256", config.razorpay.keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");
    if (!safeEqualHex(signature, razorpay_signature)) {
      throw new AppError("Invalid payment signature", 400);
    }

    const result = await processCapturedPayment({
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      razorpaySignature: razorpay_signature,
      userId: req.user.id,
    });
    res.status(result.needsReview ? 202 : 200).json({
      success: !result.refunded && !result.needsReview,
      message: result.refunded
        ? "Payment was received after cancellation or inventory changed; a refund was initiated"
        : result.needsReview
          ? "Payment requires refund reconciliation; support has been notified"
          : result.alreadyProcessed
            ? "Payment already verified"
            : "Payment verified and order confirmed",
      order: result.order,
    });
  } catch (err) {
    next(err);
  }
});

webhookRouter.post("/razorpay", async (req, res, next) => {
  try {
    const webhookSecret = config.razorpay.webhookSecret;
    const receivedSignature = req.get("x-razorpay-signature") || "";
    if (!webhookSecret || !Buffer.isBuffer(req.rawBody)) {
      throw new AppError("Razorpay webhook is not configured correctly", 503);
    }
    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(req.rawBody)
      .digest("hex");
    if (!safeEqualHex(expectedSignature, receivedSignature)) {
      throw new AppError("Invalid Razorpay webhook signature", 401);
    }
    if (req.body?.event !== "payment.captured") {
      return res.status(200).json({ received: true, ignored: true });
    }

    const payment = req.body?.payload?.payment?.entity;
    if (
      typeof payment?.order_id !== "string" ||
      typeof payment?.id !== "string" ||
      !/^order_[A-Za-z0-9]+$/.test(payment.order_id) ||
      !/^pay_[A-Za-z0-9]+$/.test(payment.id)
    ) {
      throw new AppError("Captured-payment webhook payload is invalid", 400);
    }
    const result = await processCapturedPayment({
      razorpayOrderId: payment.order_id,
      razorpayPaymentId: payment.id,
    });
    res.status(200).json({
      received: true,
      orderStatus: result.order.status,
      ...(result.needsReview ? { needsReview: true } : {}),
    });
  } catch (err) {
    next(err);
  }
});

codRouter.post("/orders/cod", checkoutLimiter, authenticate, async (req, res, next) => {
  try {
    const { mode = "CART", productId, quantity = 1, couponCode } = req.body;
    const normalizedMode = String(mode).toUpperCase();
    const address = validateShippingAddress(req.body.shippingAddress || req.body);
    const items = await getCheckoutItems(
      req.user.id,
      normalizedMode,
      productId,
      Number(quantity)
    );
    assertCheckoutStock(items);

    const coupon = await getCoupon(
      couponCode,
      items,
      items.reduce(
        (sum, item) => sum + (item.product.pricePaise ?? Math.round((item.product.price || 0) * 100)) * item.quantity,
        0
      )
    );
    const summary = calculateCartAndTax(items, coupon, address.state);
    const metrics = calculatePackageMetrics(items);
    const data = orderData({
      userId: req.user.id,
      address,
      summary,
      coupon,
      shippingChargePaise: config.shippingChargePaise,
      metrics,
      mode: normalizedMode,
      paymentMethod: "COD",
    });

    const order = await prisma.$transaction(async (tx) => {
      const createData = { ...data };
      const created = await tx.order.create({
        data: { ...createData, status: "CONFIRMED" },
      });
      await reserveInventory(tx, summary.items);
      await incrementCouponUsage(tx, coupon?.id);
      if (normalizedMode === "CART") {
        await tx.cartItem.deleteMany({
          where: {
            userId: req.user.id,
            productId: { in: summary.items.map((item) => item.productId) },
          },
        });
      }
      return tx.order.update({
        where: { id: created.id },
        data: {
          stockReserved: true,
          invoiceNumber: invoiceNumberFor(created.id),
        },
        include: { items: true },
      });
    });

    res.status(201).json({
      success: true,
      message: "Cash-on-delivery order confirmed",
      shippingChargePaise: config.shippingChargePaise,
      order,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, codRouter, webhookRouter };
