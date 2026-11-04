const express = require("express");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const prisma = require("../prisma");
const config = require("../config");
const { authenticate } = require("../middleware/auth");
const { calculateCartAndTax } = require("../utils/gst");
const { AppError } = require("../middleware/error");

const router = express.Router();

const razorpay = new Razorpay({
  key_id: config.razorpay.keyId,
  key_secret: config.razorpay.keySecret,
});

// Helper: Validate coupon if provided
async function resolveValidCoupon(code) {
  if (!code) return null;
  const coupon = await prisma.coupon.findUnique({
    where: { code: code.trim().toUpperCase() },
  });
  if (!coupon || !coupon.isActive) {
    throw new AppError("Invalid or inactive coupon code", 400);
  }
  if (coupon.expiresAt && new Date() > new Date(coupon.expiresAt)) {
    throw new AppError("Coupon has expired", 400);
  }
  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
    throw new AppError("Coupon usage limit reached", 400);
  }
  return coupon;
}

// ---------------------------------------------------------------------------
// 1. CREATE RAZORPAY ORDER (Supports BOTH Direct "Buy Now" & "Cart Checkout")
// ---------------------------------------------------------------------------
router.post("/checkout/create-order", authenticate, async (req, res, next) => {
  try {
    const {
      mode = "CART", // "DIRECT" (Buy Now from Product) or "CART" (From Cart)
      productId,     // Required only when mode === "DIRECT"
      quantity = 1,  // Used when mode === "DIRECT"
      couponCode,
      state,
      shippingAddress,
    } = req.body;

    let itemsToProcess = [];

    if (mode === "DIRECT") {
      // --- FLOW A: DIRECT BUY NOW FROM PRODUCT PAGE ---
      const qty = Number(quantity);
      if (!productId || isNaN(qty) || qty < 1) {
        throw new AppError("Valid productId and quantity >= 1 are required for Buy Now", 400);
      }

      const product = await prisma.product.findFirst({
        where: { id: Number(productId), isDeleted: false },
      });
      if (!product) throw new AppError("Product not found", 404);
      if (product.stock < qty) {
        throw new AppError(`Only ${product.stock} units available in stock`, 400);
      }

      // Format identically to cartItems so calculateCartAndTax works seamlessly
      itemsToProcess = [
        {
          productId: product.id,
          quantity: qty,
          product,
        },
      ];
    } else {
      // --- FLOW B: CHECKOUT FROM CART ---
      const cartItems = await prisma.cartItem.findMany({
        where: { userId: req.user.id },
        include: { product: true },
      });

      itemsToProcess = cartItems.filter((item) => !item.product.isDeleted);
      if (itemsToProcess.length === 0) {
        throw new AppError("Your cart is empty", 400);
      }

      // Validate stock for every item in the cart
      for (const item of itemsToProcess) {
        if (item.product.stock < item.quantity) {
          throw new AppError(
            `Insufficient stock for "${item.product.name}". Available: ${item.product.stock}`,
            400
          );
        }
      }
    }

    // Validate Coupon & Calculate GST + Total in Paise
    const coupon = await resolveValidCoupon(couponCode);
    const summary = calculateCartAndTax(itemsToProcess, coupon, state);

    // Ensure payable amount in paise (adjust property name if your calculateCartAndTax uses grandTotalPaise / totalPaise)
    const payablePaise = Math.round(
      summary.grandTotalPaise ?? summary.totalPaise ?? summary.payablePaise
    );

    if (!payablePaise || payablePaise < 100) {
      throw new AppError("Minimum order payable amount must be at least ₹1 (100 paise)", 400);
    }

    // Create Order on Razorpay
    const rzpOrder = await razorpay.orders.create({
      amount: payablePaise, // Already in paise!
      currency: "INR",
      receipt: `rcpt_${req.user.id}_${Date.now()}`,
      notes: {
        userId: String(req.user.id),
        checkoutMode: mode,
        couponCode: coupon ? coupon.code : "",
      },
    });

    // Save PENDING Order in Database
    const dbOrder = await prisma.order.create({
      data: {
        userId: req.user.id,
        razorpayOrderId: rzpOrder.id,
        checkoutMode: mode, // "DIRECT" or "CART"
        status: "PENDING",
        subtotalPaise: summary.subtotalPaise ?? 0,
        discountPaise: summary.discountPaise ?? 0,
        cgstPaise: summary.cgstPaise ?? 0,
        sgstPaise: summary.sgstPaise ?? 0,
        igstPaise: summary.igstPaise ?? 0,
        totalPaise: payablePaise,
        couponId: coupon ? coupon.id : null,
        buyerState: state || config.seller.state,
        shippingAddress: shippingAddress || "",
        items: {
          create: itemsToProcess.map((item) => ({
            productId: item.product.id,
            name: item.product.name,
            hsnCode: item.product.hsnCode,
            quantity: item.quantity,
            unitPricePaise: item.product.pricePaise,
            gstRate: item.product.gstRate,
          })),
        },
      },
      include: { items: true },
    });

    res.status(201).json({
      success: true,
      mode,
      razorpayKeyId: config.razorpay.keyId,
      razorpayOrderId: rzpOrder.id,
      amountPaise: payablePaise,
      currency: "INR",
      order: dbOrder,
      summary,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 2. VERIFY RAZORPAY PAYMENT SIGNATURE & FINALIZE ORDER
// ---------------------------------------------------------------------------
router.post("/checkout/verify-payment", authenticate, async (req, res, next) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      throw new AppError("Missing Razorpay payment verification details", 400);
    }

    // 1. Verify HMAC SHA256 Signature
    const bodyText = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac("sha256", config.razorpay.keySecret)
      .update(bodyText)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      throw new AppError("Invalid payment signature", 400);
    }

    // 2. Fetch the pending order
    const order = await prisma.order.findUnique({
      where: { razorpayOrderId: razorpay_order_id },
      include: { items: true },
    });

    if (!order || order.userId !== req.user.id) {
      throw new AppError("Order not found", 404);
    }

    if (order.status === "PAID") {
      return res.json({ success: true, message: "Order already verified", order });
    }

    // 3. Atomic Transaction: Mark Order PAID + Deduct Stock + Clear Cart (if CART mode)
    const updatedOrder = await prisma.$transaction(async (tx) => {
      // Deduct stock for each purchased item
      for (const item of order.items) {
        const prod = await tx.product.findUnique({ where: { id: item.productId } });
        if (!prod || prod.stock < item.quantity) {
          throw new AppError(`Stock ran out for ${item.name}`, 400);
        }
        await tx.product.update({
          where: { id: item.productId },
          data: { stock: { decrement: item.quantity } },
        });
      }

      // Increment coupon usage count if a coupon was applied
      if (order.couponId) {
        await tx.coupon.update({
          where: { id: order.couponId },
          data: { usedCount: { increment: 1 } },
        });
      }

      // ONLY clear user's cart if the payment came from the CART flow!
      // If the user clicked "Buy Now" on a single product, leave their existing cart untouched.
      if (order.checkoutMode === "CART") {
        await tx.cartItem.deleteMany({
          where: { userId: req.user.id },
        });
      }

      // Update order status to PAID
      return await tx.order.update({
        where: { id: order.id },
        data: {
          status: "PAID",
          razorpayPaymentId: razorpay_payment_id,
          razorpaySignature: razorpay_signature,
          paidAt: new Date(),
        },
        include: { items: true },
      });
    });

    res.json({
      success: true,
      message: "Payment verified and order confirmed",
      order: updatedOrder,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;