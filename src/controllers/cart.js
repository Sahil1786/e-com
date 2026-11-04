const express = require("express");
const prisma = require("../prisma");
const { authenticate } = require("../middleware/auth");
const { calculateCartAndTax } = require("../utils/gst");
const { AppError } = require("../middleware/error");

const router = express.Router();

// View Cart + GST breakdown
router.get("/cart", authenticate, async (req, res, next) => {
  try {
    const cartItems = await prisma.cartItem.findMany({
      where: { userId: req.user.id },
      include: { product: true },
    });
    const activeItems = cartItems.filter((item) => !item.product.isDeleted);
    const summary = calculateCartAndTax(activeItems, null, req.query.state);
    res.json({ success: true, cartItems: activeItems, summary });
  } catch (err) {
    next(err);
  }
});

// Add or Update Cart Item Quantity
// router.post("/cart", authenticate, async (req, res, next) => {
//   try {
//     const { productId, quantity } = req.body;
//     const qty = Number(quantity);
//     if (!productId || isNaN(qty) || qty < 1) {
//       throw new AppError("Valid productId and quantity >= 1 required");
//     }

//     const product = await prisma.product.findFirst({
//       where: { id: Number(productId), isDeleted: false },
//     });
//     if (!product) throw new AppError("Product not found", 404);
//     if (product.stock < qty) throw new AppError(`Only ${product.stock} units in stock`);

//     const item = await prisma.cartItem.upsert({
//       where: { userId_productId: { userId: req.user.id, productId: product.id } },
//       update: { quantity: qty },
//       create: { userId: req.user.id, productId: product.id, quantity: qty },
//     });
//     res.json({ success: true, item });
//   } catch (err) {
//     next(err);
//   }
// });
// POST /v1/user/cart
router.post("/cart", async (req, res, next) => {
  try {
    const { userId, productId, quantity = 1 } = req.body;

    if (quantity <= 0) {
      return res.status(400).json({ success: false, error: "Quantity must be at least 1" });
    }

    const product = await prisma.product.findUnique({
      where: { id: productId },
    });

    if (!product || product.isDeleted) {
      return res.status(404).json({ success: false, error: "Product not found" });
    }

    const availableStock = product.stock ?? product.quantity ?? 0;

    // 1. Block immediately if stock is 0
    if (availableStock <= 0) {
      return res.status(400).json({
        success: false,
        error: `"${product.name}" is currently Out of Stock and cannot be purchased.`,
        stockStatus: "OUT_OF_STOCK",
      });
    }

    // 2. Check existing quantity in user's cart
    const existingCartItem = await prisma.cartItem.findUnique({
      where: {
        userId_productId: { userId, productId },
      },
    });

    const newTotalQuantity = (existingCartItem?.quantity || 0) + Number(quantity);

    // 3. Block if total requested quantity exceeds available stock
    if (newTotalQuantity > availableStock) {
      return res.status(400).json({
        success: false,
        error: `Only ${availableStock} unit(s) of "${product.name}" available in stock. You already have ${existingCartItem?.quantity || 0} in your cart.`,
        availableStock,
      });
    }

    const cartItem = await prisma.cartItem.upsert({
      where: {
        userId_productId: { userId, productId },
      },
      update: { quantity: newTotalQuantity },
      create: { userId, productId, quantity: Number(quantity) },
    });

    res.json({ success: true, cartItem });
  } catch (err) {
    next(err);
  }
});

// Remove Item from Cart
router.delete("/cart/:productId", authenticate, async (req, res, next) => {
  try {
    await prisma.cartItem.deleteMany({
      where: { userId: req.user.id, productId: Number(req.params.productId) },
    });
    res.json({ success: true, message: "Item removed from cart" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;