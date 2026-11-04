const express = require("express");
const prisma = require("../prisma");
const config = require("../config");
const { authenticate, requireAdmin } = require("../middleware/auth");
const upload = require("../middleware/upload");
const { uploadToCloudinary } = require("../utils/cloudinary");
const { AppError } = require("../middleware/error");

const router = express.Router();

// // Public: List all active products
// router.get("/products", async (req, res, next) => {
//   try {
//     // 1. Remove the filter first so it grabs ALL products in the collection
//     const products = await prisma.product.findMany();
//     res.json({ success: true, products });
//   } catch (err) {
//     next(err);
//   }
// });
// // Public: Single product detail
// router.get("/products/:id", async (req, res, next) => {
//   try {
//     const { id } = req.params;

//     // Optional: Prevent Prisma from crashing if someone passes an invalid 24-char hex ObjectId
//     if (!/^[0-9a-fA-F]{24}$/.test(id)) {
//       throw new AppError("Invalid product ID format", 400);
//     }

//     const product = await prisma.product.findFirst({
//       where: {
//         id: id, // Keep as a String! Do NOT wrap in Number()
//         OR: [
//           { isDeleted: false },
//           { isDeleted: { isSet: false } }, // Matches existing Atlas docs without isDeleted
//         ],
//       },
//     });

//     if (!product) throw new AppError("Product not found", 404);

//     res.json({ success: true, product });
//   } catch (err) {
//     next(err);
//   }
// });

// Helper to format stock status for any product document
function formatProductWithStock(product) {
  // Supports both `stock` (schema.prisma) and `quantity` (your existing Atlas docs)
  const availableStock = product.stock ?? product.quantity ?? 0;

  let stockStatus = "OUT_OF_STOCK";
  if (availableStock > 5) {
    stockStatus = "IN_STOCK";
  } else if (availableStock > 0) {
    stockStatus = "LOW_STOCK"; // e.g., "Only 3 left in stock!"
  }

  return {
    ...product,
    availableStock,
    inStock: availableStock > 0,
    canBuy: availableStock > 0,
    stockStatus, // "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK"
  };
}

// GET /v1/user/products
router.get("/products", async (req, res, next) => {
  try {
    const rawProducts = await prisma.product.findMany({
      where: {
        OR: [{ isDeleted: false }, { isDeleted: { isSet: false } }],
      },
    });

    const products = rawProducts.map(formatProductWithStock);
    res.json({ success: true, products });
  } catch (err) {
    next(err);
  }
});

// GET /v1/user/products/:id
router.get("/products/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
      return res.status(400).json({ success: false, error: "Invalid product ID" });
    }

    const product = await prisma.product.findFirst({
      where: {
        id,
        OR: [{ isDeleted: false }, { isDeleted: { isSet: false } }],
      },
    });

    if (!product) {
      return res.status(404).json({ success: false, error: "Product not found" });
    }

    res.json({
      success: true,
      product: formatProductWithStock(product),
    });
  } catch (err) {
    next(err);
  }
});

// Admin: Add Product (uploads image or video to Cloudinary)
router.post(
  "/products",
  authenticate,
  requireAdmin,
  upload.single("file"),
  async (req, res, next) => {
    try {
      const { name, description, pricePaise, gstRate, hsnCode, stock } = req.body;
      const gst = Number(gstRate);
      if (!config.validGstSlabs.includes(gst)) {
        throw new AppError(`Invalid GST rate. Allowed: ${config.validGstSlabs.join(", ")}%`);
      }

      let mediaUrl = null;
      let mediaType = "image";

      if (req.file) {
        const uploadResult = await uploadToCloudinary(req.file.buffer, "ecommerce_products");
        mediaUrl = uploadResult.secure_url;
        mediaType = uploadResult.resource_type === "video" ? "video" : "image";
      }

      const product = await prisma.product.create({
        data: {
          name,
          description: description || "",
          pricePaise: Number(pricePaise),
          gstRate: gst,
          hsnCode: hsnCode || "9983",
          stock: Number(stock || 0),
          imageUrl: mediaUrl,
          mediaType,
        },
      });
      res.status(201).json({ success: true, product });
    } catch (err) {
      next(err);
    }
  }
);

// Admin: Edit Product
router.put(
  "/products/:id",
  authenticate,
  requireAdmin,
  upload.single("file"),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const existing = await prisma.product.findUnique({ where: { id } });
      if (!existing) throw new AppError("Product not found", 404);

      const { name, description, pricePaise, gstRate, hsnCode, stock } = req.body;
      let gst = existing.gstRate;
      if (gstRate !== undefined) {
        gst = Number(gstRate);
        if (!config.validGstSlabs.includes(gst)) {
          throw new AppError(`Invalid GST rate. Allowed: ${config.validGstSlabs.join(", ")}%`);
        }
      }

      let mediaUrl = existing.imageUrl;
      let mediaType = existing.mediaType;

      if (req.file) {
        const uploadResult = await uploadToCloudinary(req.file.buffer, "ecommerce_products");
        mediaUrl = uploadResult.secure_url;
        mediaType = uploadResult.resource_type === "video" ? "video" : "image";
      }

      const product = await prisma.product.update({
        where: { id },
        data: {
          name: name ?? existing.name,
          description: description ?? existing.description,
          pricePaise: pricePaise !== undefined ? Number(pricePaise) : existing.pricePaise,
          gstRate: gst,
          hsnCode: hsnCode ?? existing.hsnCode,
          stock: stock !== undefined ? Number(stock) : existing.stock,
          imageUrl: mediaUrl,
          mediaType,
        },
      });
      res.json({ success: true, product });
    } catch (err) {
      next(err);
    }
  }
);

// Admin: Soft Delete Product
router.delete("/products/:id", authenticate, requireAdmin, async (req, res, next) => {
  try {
    await prisma.product.update({
      where: { id: Number(req.params.id) },
      data: { isDeleted: true },
    });
    res.json({ success: true, message: "Product removed" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;