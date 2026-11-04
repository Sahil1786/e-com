const express = require("express");
const router = express.Router();

const loginRoutes = require("../controllers/login.js");
const productRoutes = require("../controllers/product.js");
const cartRoutes = require("../controllers/cart.js");
const couponRoutes = require("../controllers/coupon.js");
const orderRoutes = require("../controllers/order.js");
const adminRoutes = require("../controllers/admin.js");
const dashboardRoutes = require("../controllers/dashboard.js");

// Shared / Auth Routes (/v1/auth/...) & (/v1/admin/login, etc.)
router.use("/auth", loginRoutes);
router.use("/admin", loginRoutes);

// Customer / Public Routes (/v1/user/...)
router.use("/user", productRoutes);
router.use("/user", cartRoutes);
router.use("/user", couponRoutes);
router.use("/user", orderRoutes);

// Admin Routes (/v1/admin/...)
router.use("/admin", productRoutes);
router.use("/admin", couponRoutes);
router.use("/admin", adminRoutes);
router.use("/admin", dashboardRoutes);

module.exports = router;