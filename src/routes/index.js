const express = require("express");
const router = express.Router();

const loginRoutes = require("../controllers/login.js");
const productRoutes = require("../controllers/product.js");
const cartRoutes = require("../controllers/cart.js");
const couponRoutes = require("../controllers/coupon.js");
const orderRoutes = require("../controllers/order.js");
const paymentRoutes = require("../controllers/payment.js");
const shippingRoutes = require("../controllers/shipping.js");
const adminRoutes = require("../controllers/admin.js");
const dashboardRoutes = require("../controllers/dashboard.js");
const config = require("../config.js");

// Authentication: customer endpoints and compatibility aliases under /admin.
router.use("/auth", loginRoutes);
router.use("/admin", loginRoutes);

// Public catalog and customer cart, coupon, order, and COD checkout routes.
router.use("/user", productRoutes);
router.use("/user", cartRoutes);
router.use("/user", couponRoutes);
router.use("/user", orderRoutes);
router.use("/user", paymentRoutes.codRouter);

// Online payment endpoints are mounted only after Razorpay is configured.
if (config.razorpay.enabled) {
  router.use("/user", paymentRoutes.router);
  router.use("/webhooks", paymentRoutes.webhookRouter);
}

// Admin product, coupon, order-management, and dashboard routes.
router.use("/admin", productRoutes);
router.use("/admin", couponRoutes);
router.use("/admin", adminRoutes);
router.use("/admin", dashboardRoutes);
router.use("/user", shippingRoutes.userRouter);
// Shipment creation, live tracking, and the provider webhook require Shiprocket.
if (config.shiprocket.enabled) {
  router.use("/admin", shippingRoutes.adminRouter);
  router.use("/webhooks", shippingRoutes.webhookRouter);
}

module.exports = router;