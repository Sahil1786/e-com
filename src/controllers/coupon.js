const express = require("express");
const prisma = require("../prisma");
const { authenticate, requireAdmin } = require("../middleware/auth");
const { calculateCartAndTax } = require("../utils/gst");
const { AppError } = require("../middleware/error");

const router = express.Router();

// Customer: Preview Coupon Discount on Cart
router.post("/coupons/preview", authenticate, async (req, res, next) => {
  try {
    const { code, state } = req.body;
    if (!code) throw new AppError("Coupon code is required");

    const coupon = await prisma.coupon.findUnique({
      where: { code: code.trim().toUpperCase() },
    });

    const cartItems = await prisma.cartItem.findMany({
      where: { userId: req.user.id },
      include: { product: true },
    });
    if (cartItems.length === 0) throw new AppError("Your cart is empty");

    const summary = calculateCartAndTax(cartItems, coupon, state);
    res.json({ success: true, couponCode: coupon.code, summary });
  } catch (err) {
    next(err);
  }
});

// Admin: List All Coupons
router.get("/coupons", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const coupons = await prisma.coupon.findMany({ orderBy: { createdAt: "desc" } });
    res.json({ success: true, coupons });
  } catch (err) {
    next(err);
  }
});

// Admin: Create Coupon
router.post("/coupons", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { code, type, value, minOrderPaise, maxDiscountPaise, usageLimit, expiresAt, productId } =
      req.body;
    if (!["PERCENT", "FLAT"].includes(type)) {
      throw new AppError("Coupon type must be PERCENT or FLAT");
    }

    const coupon = await prisma.coupon.create({
      data: {
        code: code.trim().toUpperCase(),
        type,
        value: Number(value),
        minOrderPaise: Number(minOrderPaise || 0),
        maxDiscountPaise: maxDiscountPaise ? Number(maxDiscountPaise) : null,
        usageLimit: usageLimit ? Number(usageLimit) : null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        productId: productId ? Number(productId) : null,
      },
    });
    res.status(201).json({ success: true, coupon });
  } catch (err) {
    next(err);
  }
});

// Admin: Update / Disable Coupon
router.put("/coupons/:id", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { isActive, value, minOrderPaise, maxDiscountPaise, usageLimit, expiresAt } = req.body;

    const coupon = await prisma.coupon.update({
      where: { id },
      data: {
        isActive: isActive !== undefined ? Boolean(isActive) : undefined,
        value: value !== undefined ? Number(value) : undefined,
        minOrderPaise: minOrderPaise !== undefined ? Number(minOrderPaise) : undefined,
        maxDiscountPaise: maxDiscountPaise !== undefined ? Number(maxDiscountPaise) : undefined,
        usageLimit: usageLimit !== undefined ? Number(usageLimit) : undefined,
        expiresAt: expiresAt !== undefined ? (expiresAt ? new Date(expiresAt) : null) : undefined,
      },
    });
    res.json({ success: true, coupon });
  } catch (err) {
    next(err);
  }
});

module.exports = router;