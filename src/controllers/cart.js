const express = require("express");
const prisma = require("../prisma");
const { authenticate } = require("../middleware/auth");
const { calculateCartAndTax } = require("../utils/gst");
const { AppError } = require("../middleware/error");

const router = express.Router();

router.get("/cart", authenticate, async (req, res, next) => {
  try {
    const cartItems = await prisma.cartItem.findMany({
      where: { userId: req.user.id },
      include: { product: true },
    });
    const activeItems = cartItems.filter((item) => item.product.isDeleted !== true);
    const summary = calculateCartAndTax(activeItems, null, req.query.state);
    res.json({ success: true, cartItems: activeItems, summary });
  } catch (err) {
    next(err);
  }
});

router.post("/cart", authenticate, async (req, res, next) => {
  try {
    const { productId, quantity = 1 } = req.body;
    const qty = Number(quantity);
    if (!/^[0-9a-fA-F]{24}$/.test(String(productId || "")) ||
        !Number.isSafeInteger(qty) || qty < 1) {
      throw new AppError("Valid productId and positive integer quantity are required", 400);
    }

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product || product.isDeleted === true) {
      throw new AppError("Product not found", 404);
    }

    const availableStock = product.stock ?? product.quantity ?? 0;
    const existingCartItem = await prisma.cartItem.findUnique({
      where: {
        userId_productId: { userId: req.user.id, productId },
      },
    });
    const requestedQuantity = (existingCartItem?.quantity || 0) + qty;

    if (requestedQuantity > availableStock) {
      throw new AppError(
        `Only ${availableStock} unit(s) of "${product.name}" are available`,
        400
      );
    }

    const cartItem = await prisma.cartItem.upsert({
      where: {
        userId_productId: { userId: req.user.id, productId },
      },
      update: { quantity: requestedQuantity },
      create: { userId: req.user.id, productId, quantity: qty },
    });

    res.json({ success: true, cartItem });
  } catch (err) {
    next(err);
  }
});

router.delete("/cart/:productId", authenticate, async (req, res, next) => {
  try {
    if (!/^[0-9a-fA-F]{24}$/.test(req.params.productId)) {
      throw new AppError("Invalid product ID", 400);
    }
    await prisma.cartItem.deleteMany({
      where: { userId: req.user.id, productId: req.params.productId },
    });
    res.json({ success: true, message: "Item removed from cart" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
