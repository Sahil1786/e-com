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
const accountRoutes = require("../controllers/account.js");
const storeSettingsRoutes = require("../controllers/storeSettings.js");
const config = require("../config.js");
const { getStoreSettings } = require("../utils/storeSettings.js");
const { authenticate, requireCustomer } = require("../middleware/auth.js");

// Public storefront capabilities; never expose provider credentials here.
router.get("/storefront/config", async (req, res, next) => {
  try {
    const storeSettings = getStoreSettings();
    res.json({
      success: true,
      payments: {
        cod: true,
        razorpay: config.razorpay.configured,
        razorpayKeyId: config.razorpay.configured ? config.razorpay.keyId : null,
      },
      shippingChargePaise: storeSettings.shippingChargePaise,
      codChargePaise: storeSettings.codChargePaise,
      freeShippingThresholdPaise: config.freeShippingThresholdPaise,
      brandName: storeSettings.brandName,
      logoUrl: storeSettings.logoUrl,
    });
  } catch (error) {
    next(error);
  }
});

// Keep customer and administrator authentication on distinct role-checked surfaces.
router.use("/auth", loginRoutes);
router.use("/admin", loginRoutes);

// The catalog is public; every other customer route requires a customer session.
router.use("/user", productRoutes);
if (!config.razorpay.configured) {
  router.post("/user/checkout/create-order", (req, res) => res.sendStatus(404));
}
router.use("/user", authenticate, requireCustomer);
router.use("/user", accountRoutes);
router.use("/user", cartRoutes);
router.use("/user", couponRoutes);
router.use("/user", orderRoutes);
router.use("/user", paymentRoutes.codRouter);

// Online payment endpoints are mounted only after Razorpay is configured.
if (config.razorpay.configured) {
  router.use("/user", paymentRoutes.router);
  router.use("/webhooks", paymentRoutes.webhookRouter);
}

// Admin product, coupon, order-management, and dashboard routes.
router.use("/admin", productRoutes);
router.use("/admin", couponRoutes);
router.use("/admin", adminRoutes);
router.use("/admin", dashboardRoutes);
router.use("/admin", storeSettingsRoutes);
router.use("/user", shippingRoutes.userRouter);
// Shipment creation, live tracking, and the provider webhook require Shiprocket.
if (config.shiprocket.enabled) {
  router.use("/admin", shippingRoutes.adminRouter);
  router.use("/webhooks", shippingRoutes.webhookRouter);
}

module.exports = router;