const express = require("express");
const prisma = require("../prisma");
const { authenticate, requireAdmin } = require("../middleware/auth");
const { calculateCartAndTax, validateCoupon } = require("../utils/gst");
const {
  shippingChargeFor,
  calculateOrderTotalPaise,
  isObjectId,
} = require("../utils/orderWorkflow");
const { getCurrentStoreSettings } = require("../utils/storeSettings");
const { AppError } = require("../middleware/error");

const router = express.Router();
const maxInteger = 2_147_483_647;

// Customer: Preview Coupon Discount on Cart
router.post("/coupons/preview", authenticate, async (req, res, next) => {
  try {
    const {
      code,
      state,
      mode = "CART",
      productId,
      quantity = 1,
      paymentMethod = "COD",
    } = req.body;
    if (!["COD", "ONLINE"].includes(paymentMethod)) {
      throw new AppError("Payment method must be COD or ONLINE", 400);
    }
    if (code !== undefined && code !== null && typeof code !== "string") {
      throw new AppError("Coupon code must be a string", 400);
    }

    const coupon = code?.trim()
      ? await prisma.coupon.findUnique({
          where: { code: code.trim().toUpperCase() },
        })
      : null;
    let activeItems;
    if (mode === "DIRECT") {
      if (!isObjectId(productId) || !Number.isSafeInteger(quantity) || quantity < 1) {
        throw new AppError("Valid productId and quantity are required for direct checkout", 400);
      }
      const product = await prisma.product.findUnique({ where: { id: productId } });
      if (!product || product.isDeleted === true) throw new AppError("Product not found", 404);
      activeItems = [{ productId: product.id, quantity, product }];
    } else if (mode === "CART") {
      const cartItems = await prisma.cartItem.findMany({
        where: { userId: req.user.id },
        include: { product: true },
      });
      activeItems = cartItems.filter((item) => item.product.isDeleted !== true);
    } else {
      throw new AppError("Checkout mode must be CART or DIRECT", 400);
    }
    if (activeItems.length === 0) throw new AppError("Your cart is empty");
    if (coupon) {
      validateCoupon(coupon, activeItems, activeItems.reduce((sum, item) => {
        const unitPricePaise = item.product.pricePaise ?? Math.round((item.product.price || 0) * 100);
        return sum + unitPricePaise * item.quantity;
      }, 0));
    }

    const summary = calculateCartAndTax(activeItems, coupon, state);
    const storeSettings = await getCurrentStoreSettings();
    const shippingChargePaise = shippingChargeFor(summary, storeSettings);
    const codChargePaise = paymentMethod === "COD" ? storeSettings.codChargePaise : 0;
    res.json({
      success: true,
      couponCode: coupon?.code || null,
      summary: {
        ...summary,
        shippingChargePaise,
        codChargePaise,
        totalAmountPaise: calculateOrderTotalPaise(summary, shippingChargePaise, codChargePaise),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/coupons/available", authenticate, async (req, res, next) => {
  try {
    const now = new Date();
    const allVisibleCoupons = await prisma.coupon.findMany({
      where: { isActive: true },
      select: {
        id: true,
        code: true,
        isVisible: true,
        type: true,
        value: true,
        minOrderPaise: true,
        maxDiscountPaise: true,
        usageLimit: true,
        usedCount: true,
        expiresAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    const coupons = allVisibleCoupons.filter((coupon) =>
      coupon.isVisible !== false &&
      (!coupon.expiresAt || coupon.expiresAt > now) &&
      (coupon.usageLimit === null || coupon.usageLimit === undefined ||
        coupon.usedCount < coupon.usageLimit)
    );
    res.json({ success: true, coupons });
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
    const {
      code,
      type,
      value,
      minOrderPaise,
      maxDiscountPaise,
      usageLimit,
      expiresAt,
      productId,
      isActive = true,
      isVisible = true,
    } = req.body;
    if (typeof code !== "string" || !/^[A-Z0-9_-]{2,32}$/i.test(code.trim()) ||
        !["PERCENT", "FLAT"].includes(type)) {
      throw new AppError("Enter a 2–32 character coupon code and a valid coupon type", 400);
    }
    if (typeof isActive !== "boolean" || typeof isVisible !== "boolean") {
      throw new AppError("isActive and isVisible must be booleans", 400);
    }
    const numericValue = Number(value);
    if (!Number.isSafeInteger(numericValue) || numericValue <= 0 || numericValue > maxInteger ||
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
    if (!Number.isSafeInteger(minOrder) || minOrder < 0 || minOrder > maxInteger ||
        (maxDiscount !== null && (!Number.isSafeInteger(maxDiscount) || maxDiscount < 0 || maxDiscount > maxInteger)) ||
        (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > maxInteger))) {
      throw new AppError("Coupon thresholds and limits must be valid non-negative integers");
    }
    if (productId && (typeof productId !== "string" || !/^[0-9a-fA-F]{24}$/.test(productId))) {
      throw new AppError("Invalid product ID", 400);
    }
    const expiry = expiresAt ? new Date(expiresAt) : null;
    if (expiry && Number.isNaN(expiry.getTime())) {
      throw new AppError("expiresAt must be a valid date", 400);
    }

    const coupon = await prisma.coupon.create({
      data: {
        code: code.trim().toUpperCase(),
        type,
        value: numericValue,
        minOrderPaise: minOrder,
        maxDiscountPaise: maxDiscount,
        usageLimit: limit,
        expiresAt: expiry,
        productId: productId || null,
        isActive,
        isVisible,
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
    const {
      isActive,
      isVisible,
      value,
      minOrderPaise,
      maxDiscountPaise,
      usageLimit,
      expiresAt,
    } = req.body;
    if (isVisible !== undefined && typeof isVisible !== "boolean") {
      throw new AppError("isVisible must be a boolean", 400);
    }
    if (value !== undefined &&
        (!Number.isSafeInteger(Number(value)) || Number(value) <= 0 || Number(value) > maxInteger)) {
      throw new AppError("Coupon value must be a positive integer", 400);
    }
    if (isActive !== undefined && typeof isActive !== "boolean") {
      throw new AppError("isActive must be a boolean", 400);
    }
    if (minOrderPaise !== undefined &&
        (!Number.isSafeInteger(Number(minOrderPaise)) || Number(minOrderPaise) < 0 || Number(minOrderPaise) > maxInteger)) {
      throw new AppError("minOrderPaise must be a non-negative integer", 400);
    }
    if (maxDiscountPaise !== undefined && maxDiscountPaise !== null &&
        (!Number.isSafeInteger(Number(maxDiscountPaise)) || Number(maxDiscountPaise) < 0 || Number(maxDiscountPaise) > maxInteger)) {
      throw new AppError("maxDiscountPaise must be a non-negative integer", 400);
    }
    if (usageLimit !== undefined && usageLimit !== null &&
        (!Number.isSafeInteger(Number(usageLimit)) || Number(usageLimit) < 1 || Number(usageLimit) > maxInteger)) {
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

    const existingCoupon = await prisma.coupon.findUnique({ where: { id } });
    if (!existingCoupon) throw new AppError("Coupon not found", 404);
    const nextValue = value !== undefined ? Number(value) : existingCoupon.value;
    if (existingCoupon.type === "PERCENT" && nextValue > 100) {
      throw new AppError("Percentage coupon value cannot exceed 100%", 400);
    }

    const coupon = await prisma.coupon.update({
      where: { id },
      data: {
        isActive: isActive !== undefined ? Boolean(isActive) : undefined,
        isVisible: isVisible !== undefined ? isVisible : undefined,
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