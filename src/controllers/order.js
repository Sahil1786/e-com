const express = require("express");
const prisma = require("../prisma");
const { authenticate } = require("../middleware/auth");
const { calculateCartAndTax } = require("../utils/gst");
const { generateInvoicePdf } = require("../utils/invoicePdf");
const { AppError } = require("../middleware/error");

const router = express.Router();

// 1. Checkout
// router.post("/orders/checkout", authenticate, async (req, res, next) => {
//   try {
//     const { recipientName, phone, addressLine, city, state, pincode, buyerGstin, couponCode } =
//       req.body;

//     if (!recipientName || !addressLine || !city || !state) {
//       throw new AppError("Recipient name, address, city, and state are required");
//     }
//     if (!/^[6-9]\d{9}$/.test(String(phone))) {
//       throw new AppError("Invalid 10-digit Indian mobile number");
//     }
//     if (!/^[1-9][0-9]{5}$/.test(String(pincode))) {
//       throw new AppError("Invalid 6-digit Indian pincode");
//     }

//     const order = await prisma.$transaction(async (tx) => {
//       const cartItems = await tx.cartItem.findMany({
//         where: { userId: req.user.id },
//         include: { product: true },
//       });

//       if (cartItems.length === 0) throw new AppError("Cart is empty");

//       for (const item of cartItems) {
//         if (item.product.isDeleted) {
//           throw new AppError(`Product "${item.product.name}" is no longer available`);
//         }
//         if (item.product.stock < item.quantity) {
//           throw new AppError(`Insufficient stock for "${item.product.name}"`);
//         }
//       }

//       let coupon = null;
//       if (couponCode) {
//         coupon = await tx.coupon.findUnique({
//           where: { code: couponCode.trim().toUpperCase() },
//         });
//       }

//       const calc = calculateCartAndTax(cartItems, coupon, state);

//       for (const item of cartItems) {
//         await tx.product.update({
//           where: { id: item.productId },
//           data: { stock: { decrement: item.quantity } },
//         });
//       }

//       if (coupon) {
//         await tx.coupon.update({
//           where: { id: coupon.id },
//           data: { usedCount: { increment: 1 } },
//         });
//       }

//       const newOrder = await tx.order.create({
//         data: {
//           userId: req.user.id,
//           status: "PENDING",
//           subtotalPaise: calc.subtotalPaise,
//           discountPaise: calc.discountPaise,
//           taxableAmountPaise: calc.taxableAmountPaise,
//           cgstPaise: calc.cgstPaise,
//           sgstPaise: calc.sgstPaise,
//           igstPaise: calc.igstPaise,
//           totalGstPaise: calc.totalGstPaise,
//           totalAmountPaise: calc.totalAmountPaise,
//           recipientName,
//           phone: String(phone),
//           addressLine,
//           city,
//           state: state.trim().toUpperCase(),
//           pincode: String(pincode),
//           buyerGstin: buyerGstin || null,
//           couponId: coupon ? coupon.id : null,
//           items: { create: calc.items },
//         },
//         include: { items: true },
//       });

//       await tx.cartItem.deleteMany({ where: { userId: req.user.id } });
//       return newOrder;
//     });

//     res.status(201).json({ success: true, order });
//   } catch (err) {
//     next(err);
//   }
// });
// POST /v1/user/orders/checkout
router.post("/orders/checkout", async (req, res, next) => {
    try {
      const {
        userId,
        recipientName,
        phone,
        addressLine,
        city,
        state,
        pincode,
      } = req.body;
  
      // Fetch user's cart with products
      const cartItems = await prisma.cartItem.findMany({
        where: { userId },
        include: { product: true },
      });
  
      if (cartItems.length === 0) {
        return res.status(400).json({ success: false, error: "Your cart is empty" });
      }
  
      // Run stock verification + stock deduction + order creation inside an atomic transaction
      const order = await prisma.$transaction(async (tx) => {
        let subtotalPaise = 0;
        let totalGstPaise = 0;
        const orderItemsData = [];
  
        for (const item of cartItems) {
          // Re-fetch fresh product inside transaction
          const product = await tx.product.findUnique({
            where: { id: item.productId },
          });
  
          const availableStock = product?.stock ?? product?.quantity ?? 0;
  
          if (!product || product.isDeleted || availableStock <= 0) {
            throw new Error(`"${item.product.name}" is Out of Stock and cannot be purchased.`);
          }
  
          if (availableStock < item.quantity) {
            throw new Error(
              `Insufficient stock for "${product.name}". Requested: ${item.quantity}, Available: ${availableStock}`
            );
          }
  
          // Atomic stock deduction: only updates if stock is still >= item.quantity
          const deductResult = await tx.product.updateMany({
            where: {
              id: product.id,
              stock: { gte: item.quantity },
            },
            data: {
              stock: { decrement: item.quantity },
            },
          });
  
          if (deductResult.count === 0) {
            throw new Error(`"${product.name}" just went Out of Stock! Please update your cart.`);
          }
  
          // Calculate price & GST
          const unitPricePaise = product.pricePaise ?? (product.price * 100);
          const gstRate = product.gstRate ?? 18;
          const taxableValuePaise = unitPricePaise * item.quantity;
          const itemGstPaise = Math.round((taxableValuePaise * gstRate) / 100);
          const cgstPaise = Math.round(itemGstPaise / 2);
          const sgstPaise = itemGstPaise - cgstPaise;
  
          subtotalPaise += taxableValuePaise;
          totalGstPaise += itemGstPaise;
  
          orderItemsData.push({
            productId: product.id,
            productName: product.name,
            hsnCode: product.hsnCode || "9983",
            quantity: item.quantity,
            unitPricePaise,
            gstRate,
            taxableValuePaise,
            cgstPaise,
            sgstPaise,
            igstPaise: 0,
            totalPaise: taxableValuePaise + itemGstPaise,
          });
        }
  
        // Create the confirmed order
        const newOrder = await tx.order.create({
          data: {
            userId,
            status: "PAID",
            subtotalPaise,
            taxableAmountPaise: subtotalPaise,
            cgstPaise: Math.round(totalGstPaise / 2),
            sgstPaise: totalGstPaise - Math.round(totalGstPaise / 2),
            totalGstPaise,
            totalAmountPaise: subtotalPaise + totalGstPaise,
            recipientName,
            phone,
            addressLine,
            city,
            state,
            pincode,
            items: {
              create: orderItemsData,
            },
          },
          include: { items: true },
        });
  
        // Clear customer's cart after successful stock deduction
        await tx.cartItem.deleteMany({ where: { userId } });
  
        return newOrder;
      });
  
      res.status(201).json({
        success: true,
        message: "Order confirmed and stock updated",
        order,
      });
    } catch (err) {
      res.status(400).json({
        success: false,
        error: err.message,
      });
    }
  });

// 2. Pay Order
router.post("/orders/:id/pay", authenticate, async (req, res, next) => {
  try {
    const orderId = Number(req.params.id);
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });

    if (!order || order.userId !== req.user.id) throw new AppError("Order not found", 404);
    if (order.status !== "PENDING") {
      throw new AppError(`Order cannot be paid in ${order.status} status`);
    }

    const year = new Date().getFullYear();
    const invoiceNumber = `INV-${year}-${String(order.id).padStart(6, "0")}`;

    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: "PAID",
        invoiceNumber,
        paymentId: `pay_mock_${Date.now()}`,
        paidAt: new Date(),
      },
      include: { items: true },
    });

    res.json({ success: true, order: updatedOrder });
  } catch (err) {
    next(err);
  }
});

// 3. Cancel Order
// router.post("/orders/:id/cancel", authenticate, async (req, res, next) => {
//   try {
//     const orderId = Number(req.params.id);

//     const updated = await prisma.$transaction(async (tx) => {
//       const order = await tx.order.findUnique({
//         where: { id: orderId },
//         include: { items: true },
//       });

//       if (!order || order.userId !== req.user.id) throw new AppError("Order not found", 404);
//       if (!["PENDING", "PAID", "PROCESSING"].includes(order.status)) {
//         throw new AppError("Order cannot be cancelled once shipped or delivered");
//       }

//       const wasPaid = ["PAID", "PROCESSING"].includes(order.status);

//       for (const item of order.items) {
//         await tx.product.update({
//           where: { id: item.productId },
//           data: { stock: { increment: item.quantity } },
//         });
//       }

//       if (order.couponId) {
//         await tx.coupon.update({
//           where: { id: order.couponId },
//           data: { usedCount: { decrement: 1 } },
//         });
//       }

//       return tx.order.update({
//         where: { id: orderId },
//         data: {
//           status: wasPaid ? "REFUNDED" : "CANCELLED",
//           refundedAmountPaise: wasPaid ? order.totalAmountPaise : 0,
//           refundReason: "Cancelled by customer",
//         },
//         include: { items: true },
//       });
//     });

//     res.json({ success: true, order: updated });
//   } catch (err) {
//     next(err);
//   }
// });
// POST /v1/user/orders/:orderId/cancel
router.post("/orders/:orderId/cancel", async (req, res, next) => {
    try {
      const { orderId } = req.params;
  
      const cancelledOrder = await prisma.$transaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: orderId },
          include: { items: true },
        });
  
        if (!order) throw new Error("Order not found");
        if (order.status === "CANCELLED" || order.status === "DELIVERED") {
          throw new Error(`Order cannot be cancelled in ${order.status} state`);
        }
  
        // Restore stock for each item in the order
        for (const item of order.items) {
          await tx.product.update({
            where: { id: item.productId },
            data: {
              stock: { increment: item.quantity },
            },
          });
        }
  
        // Mark order as CANCELLED
        return tx.order.update({
          where: { id: orderId },
          data: { status: "CANCELLED" },
        });
      });
  
      res.json({
        success: true,
        message: "Order cancelled and product stock restored",
        order: cancelledOrder,
      });
    } catch (err) {
      next(err);
    }
  });
// 4. View Customer Order History
router.get("/orders/my", authenticate, async (req, res, next) => {
  try {
    const orders = await prisma.order.findMany({
      where: { userId: req.user.id },
      include: { items: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, orders });
  } catch (err) {
    next(err);
  }
});

// 5. Download Invoice PDF
router.get("/orders/:id/invoice", authenticate, async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: Number(req.params.id) },
      include: { items: true },
    });

    if (!order) throw new AppError("Order not found", 404);
    if (req.user.role !== "ADMIN" && order.userId !== req.user.id) {
      throw new AppError("Unauthorized to view this invoice", 403);
    }
    if (!order.invoiceNumber) {
      throw new AppError("Invoice is generated only after payment", 400);
    }

    generateInvoicePdf(order, res);
  } catch (err) {
    next(err);
  }
});

module.exports = router;