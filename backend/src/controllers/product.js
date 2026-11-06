const express = require("express");
const prisma = require("../prisma");
const config = require("../config");
const { authenticate, requireAdmin } = require("../middleware/auth");
const upload = require("../middleware/upload");
const { uploadToCloudinary } = require("../utils/cloudinary");
const { AppError } = require("../middleware/error");
const { recordInventoryMovement } = require("../utils/orderWorkflow");

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
    imageUrls: Array.isArray(product.imageUrls)
      ? product.imageUrls
      : product.imageUrl && product.mediaType !== "video"
        ? [product.imageUrl]
        : [],
    availableStock,
    inStock: availableStock > 0,
    canBuy: availableStock > 0,
    stockStatus, // "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK"
  };
}

function productUploads() {
  return upload.fields([
    { name: "images", maxCount: 7 },
    { name: "file", maxCount: 1 },
  ]);
}

function uploadedImages(req) {
  const images = req.files?.images || [];
  if (images.length > 7 || images.some((file) => !file.mimetype.startsWith("image/"))) {
    throw new AppError("Upload up to 7 product images", 400);
  }
  return images;
}

function keptImageUrls(value, existing) {
  if (value === undefined) {
    return Array.isArray(existing.imageUrls) && existing.imageUrls.length
      ? existing.imageUrls
      : existing.imageUrl && existing.mediaType !== "video"
        ? [existing.imageUrl]
        : [];
  }
  let urls;
  try {
    urls = JSON.parse(value);
  } catch {
    throw new AppError("Product image list is invalid", 400);
  }
  const existingUrls = new Set([
    ...(Array.isArray(existing.imageUrls) ? existing.imageUrls : []),
    ...(existing.imageUrl && existing.mediaType !== "video" ? [existing.imageUrl] : []),
  ]);
  if (!Array.isArray(urls) || urls.some((url) => typeof url !== "string" || !existingUrls.has(url))) {
    throw new AppError("Product image list is invalid", 400);
  }
  return [...new Set(urls)];
}

// GET /v1/user/products
router.get("/products", async (req, res, next) => {
  try {
    const rawProducts = await prisma.product.findMany({
      where: {
        OR: [{ isDeleted: false }, { isDeleted: { isSet: false } }],
      },
      orderBy: { createdAt: "desc" },
    });

    const products = rawProducts.map(formatProductWithStock);
    res.set("Cache-Control", "no-store");
    res.json({ success: true, products });
  } catch (err) {
    next(err);
  }
});

router.get("/products/popular", async (req, res, next) => {
  try {
    const orders = await prisma.order.findMany({
      where: { status: { in: ["CONFIRMED", "PAID", "PROCESSING", "SHIPPED", "DELIVERED"] } },
      select: { items: { select: { productId: true, quantity: true } } },
    });
    const unitsSoldByProduct = new Map();
    for (const order of orders) {
      for (const item of order.items) {
        unitsSoldByProduct.set(
          item.productId,
          (unitsSoldByProduct.get(item.productId) || 0) + item.quantity
        );
      }
    }

    const rankedProductIds = [...unitsSoldByProduct.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8)
      .map(([productId]) => productId);
    const rawProducts = rankedProductIds.length
      ? await prisma.product.findMany({
        where: {
          id: { in: rankedProductIds },
          OR: [{ isDeleted: false }, { isDeleted: { isSet: false } }],
        },
      })
      : [];
    const productsById = new Map(rawProducts.map((product) => [product.id, product]));
    const products = rankedProductIds
      .map((id) => productsById.get(id))
      .filter(Boolean)
      .map((product) => ({
        ...formatProductWithStock(product),
        unitsSold: unitsSoldByProduct.get(product.id),
      }));

    res.set("Cache-Control", "no-store");
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
  productUploads(),
  async (req, res, next) => {
    try {
      const { name, description, category, pricePaise, gstRate, hsnCode, stock } = req.body;
      const gst = Number(gstRate);
      const price = Number(pricePaise);
      const initialStock = Number(stock ?? 0);
      if (!name?.trim() || !Number.isSafeInteger(price) || price <= 0) {
        throw new AppError("Product name and positive integer pricePaise are required", 400);
      }
      if (!Number.isSafeInteger(initialStock) || initialStock < 0 || initialStock > 2_147_483_647) {
        throw new AppError("Stock must be a non-negative integer within the supported range", 400);
      }
      if (!config.validGstSlabs.includes(gst)) {
        throw new AppError(`Invalid GST rate. Allowed: ${config.validGstSlabs.join(", ")}%`);
      }

      const images = uploadedImages(req);
      if (req.files?.file?.length && images.length) {
        throw new AppError("Upload either product gallery images or one legacy media file", 400);
      }

      const imageUrls = [];
      for (const file of images) {
        const uploadResult = await uploadToCloudinary(file.buffer, "ecommerce_products");
        imageUrls.push(uploadResult.secure_url);
      }
      const legacyFile = req.files?.file?.[0];
      let mediaUrl = imageUrls[0] || null;
      let mediaType = "image";

      if (legacyFile) {
        const uploadResult = await uploadToCloudinary(legacyFile.buffer, "ecommerce_products");
        mediaUrl = uploadResult.secure_url;
        mediaType = uploadResult.resource_type === "video" ? "video" : "image";
        if (mediaType === "image") imageUrls.push(mediaUrl);
      }

      const product = await prisma.$transaction(async (tx) => {
        const created = await tx.product.create({
          data: {
            name: name.trim(),
            description: description || "",
            category: category?.trim() || null,
            pricePaise: price,
            gstRate: gst,
            hsnCode: hsnCode || "9983",
            stock: initialStock,
            imageUrl: mediaUrl,
            imageUrls,
            mediaType,
          },
        });
        if (initialStock > 0) {
          await recordInventoryMovement(tx, {
            productId: created.id,
            type: "OPENING_STOCK",
            quantity: initialStock,
            stockBefore: 0,
            stockAfter: initialStock,
            note: "Initial stock entered when the product was created.",
            actor: req.user.id,
          });
        }
        return created;
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
  productUploads(),
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!/^[0-9a-fA-F]{24}$/.test(id)) throw new AppError("Invalid product ID", 400);
      const existing = await prisma.product.findUnique({ where: { id } });
      if (!existing) throw new AppError("Product not found", 404);

      const { name, description, category, pricePaise, gstRate, hsnCode, stock } = req.body;
      const nextPrice = pricePaise !== undefined ? Number(pricePaise) : existing.pricePaise;
      const currentStock = existing.stock ?? existing.quantity ?? 0;
      if (stock !== undefined && Number(stock) !== currentStock) {
        throw new AppError("Use the inventory adjustment controls to change product stock", 400);
      }
      if (name !== undefined && !name.trim()) throw new AppError("Product name cannot be empty", 400);
      if (pricePaise !== undefined && (!Number.isSafeInteger(nextPrice) || nextPrice <= 0)) {
        throw new AppError("pricePaise must be a positive integer", 400);
      }
      let gst = existing.gstRate;
      if (gstRate !== undefined) {
        gst = Number(gstRate);
        if (!config.validGstSlabs.includes(gst)) {
          throw new AppError(`Invalid GST rate. Allowed: ${config.validGstSlabs.join(", ")}%`);
        }
      }

      const images = uploadedImages(req);
      const legacyFile = req.files?.file?.[0];
      if (legacyFile && images.length) {
        throw new AppError("Upload either product gallery images or one legacy media file", 400);
      }
      let imageUrls = keptImageUrls(req.body.imageUrls, existing);
      if (imageUrls.length + images.length > 7) {
        throw new AppError("A product can have at most 7 images", 400);
      }
      if (legacyFile?.mimetype.startsWith("image/") && imageUrls.length >= 7) {
        throw new AppError("A product can have at most 7 images", 400);
      }
      for (const file of images) {
        const uploadResult = await uploadToCloudinary(file.buffer, "ecommerce_products");
        imageUrls.push(uploadResult.secure_url);
      }
      if (legacyFile && !legacyFile.mimetype.startsWith("image/")) {
        const uploadResult = await uploadToCloudinary(legacyFile.buffer, "ecommerce_products");
        const product = await prisma.product.update({
          where: { id },
          data: {
            name: name !== undefined ? name.trim() : existing.name,
            description: description ?? existing.description,
            category: category !== undefined ? (category.trim() || null) : existing.category,
            pricePaise: nextPrice,
            gstRate: gst,
            hsnCode: hsnCode ?? existing.hsnCode,
            imageUrl: uploadResult.secure_url,
            imageUrls: [],
            mediaType: "video",
          },
        });
        return res.json({ success: true, product });
      }
      if (legacyFile) {
        const uploadResult = await uploadToCloudinary(legacyFile.buffer, "ecommerce_products");
        imageUrls.push(uploadResult.secure_url);
      }
      const mediaUrl = imageUrls[0] || (existing.mediaType === "video" ? existing.imageUrl : null);
      const mediaType = imageUrls.length ? "image" : existing.mediaType;

      const product = await prisma.product.update({
        where: { id },
        data: {
          name: name !== undefined ? name.trim() : existing.name,
          description: description ?? existing.description,
          category: category !== undefined ? (category.trim() || null) : existing.category,
          pricePaise: nextPrice,
          gstRate: gst,
          hsnCode: hsnCode ?? existing.hsnCode,
          imageUrl: mediaUrl,
          imageUrls,
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
    if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) {
      throw new AppError("Invalid product ID", 400);
    }
    await prisma.product.update({
      where: { id: req.params.id },
      data: { isDeleted: true },
    });
    res.json({ success: true, message: "Product removed" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;