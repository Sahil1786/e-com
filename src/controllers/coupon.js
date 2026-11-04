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
    const activeItems = cartItems.filter((item) => item.product.isDeleted !== true);
    if (activeItems.length === 0) throw new AppError("Your cart is empty");

    const summary = calculateCartAndTax(activeItems, coupon, state);
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
    if (typeof code !== "string" || !code.trim() || !["PERCENT", "FLAT"].includes(type)) {
      throw new AppError("Coupon type must be PERCENT or FLAT");
    }
    const numericValue = Number(value);
    if (!Number.isSafeInteger(numericValue) || numericValue <= 0 ||
        (type === "PERCENT" && numericValue > 100)) {
      throw new AppError("Coupon value must be a positive integer (percentage cannot exceed 100%)");
    }
    const minOrder = Number(minOrderPaise ?? 0);
    const maxDiscount = maxDiscountPaise === undefined || maxDiscountPaise === null
      ? null
      : Number(maxDiscountPaise);
    const limit = usageLimit === undefined || usageLimit === null || usageLimit === ""
      ? null
      : Number(usageLimit);
    if (!Number.isSafeInteger(minOrder) || minOrder < 0 ||
        (maxDiscount !== null && (!Number.isSafeInteger(maxDiscount) || maxDiscount < 0)) ||
        (limit !== null && (!Number.isSafeInteger(limit) || limit < 1))) {
      throw new AppError("Coupon thresholds and limits must be valid non-negative integers");
    }
    if (productId && (typeof productId !== "string" || !/^[0-9a-fA-F]{24}$/.test(productId))) {
      throw new AppError("Invalid product ID", 400);
    }

    const coupon = await prisma.coupon.create({
      data: {
        code: code.trim().toUpperCase(),
        type,
        value: numericValue,
        minOrderPaise: minOrder,
        maxDiscountPaise: maxDiscount,
        usageLimit: limit,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        productId: productId || null,
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
    const id = req.params.id;
    if (!/^[0-9a-fA-F]{24}$/.test(id)) throw new AppError("Invalid coupon ID", 400);
    const { isActive, value, minOrderPaise, maxDiscountPaise, usageLimit, expiresAt } = req.body;
    if (value !== undefined &&
        (!Number.isSafeInteger(Number(value)) || Number(value) <= 0)) {
      throw new AppError("Coupon value must be a positive integer", 400);
    }
    if (isActive !== undefined && typeof isActive !== "boolean") {
      throw new AppError("isActive must be a boolean", 400);
    }
    if (minOrderPaise !== undefined &&
        (!Number.isSafeInteger(Number(minOrderPaise)) || Number(minOrderPaise) < 0)) {
      throw new AppError("minOrderPaise must be a non-negative integer", 400);
    }
    if (maxDiscountPaise !== undefined && maxDiscountPaise !== null &&
        (!Number.isSafeInteger(Number(maxDiscountPaise)) || Number(maxDiscountPaise) < 0)) {
      throw new AppError("maxDiscountPaise must be a non-negative integer", 400);
    }
    if (usageLimit !== undefined && usageLimit !== null &&
        (!Number.isSafeInteger(Number(usageLimit)) || Number(usageLimit) < 1)) {
      throw new AppError("usageLimit must be a positive integer or null", 400);
    }
    const updatedExpiry = expiresAt === undefined
      ? undefined
      : expiresAt === null || expiresAt === ""
        ? null
        : new Date(expiresAt);
    if (updatedExpiry instanceof Date && Number.isNaN(updatedExpiry.getTime())) {
      throw new AppError("expiresAt must be a valid date", 400);
    }

    const coupon = await prisma.coupon.update({
      where: { id },
      data: {
        isActive: isActive !== undefined ? Boolean(isActive) : undefined,
        value: value !== undefined ? Number(value) : undefined,
        minOrderPaise: minOrderPaise !== undefined ? Number(minOrderPaise) : undefined,
        maxDiscountPaise: maxDiscountPaise !== undefined
          ? (maxDiscountPaise === null ? null : Number(maxDiscountPaise))
          : undefined,
        usageLimit: usageLimit !== undefined ? (usageLimit === null ? null : Number(usageLimit)) : undefined,
        expiresAt: updatedExpiry,
      },
    });
    res.json({ success: true, coupon });
  } catch (err) {
    next(err);
  }
});

module.exports = router;