// const dotenv = require("dotenv");
// const path = require("path");
// const express = require("express");
// const cors = require("cors");
// const cookieParser = require("cookie-parser");
// const helmet = require("helmet");

// dotenv.config({ path: path.resolve(__dirname, "../.env") });

// const mainRouter = require("./src/routes/index.js");
// const { errorHandler } = require("./src/middleware/error.js");
// const config = require("./src/config.js");
// const prisma = require("./src/prisma.js");
// const { apiLimiter } = require("./src/middleware/rateLimit.js");
// const { AppError } = require("./src/middleware/error.js");
// const { isConfigured: emailConfigured } = require("./src/utils/email.js");
// const { loadStoreSettings } = require("./src/utils/storeSettings.js");

// const app = express();
// const port = Number(config.port);

// function sanitizeErrorMessage(error) {
//   return String(error.message || "Unknown error")
//     .replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, "[redacted MongoDB connection URL]");
// }

// app.use(helmet());
// if (config.trustProxy > 0) app.set("trust proxy", config.trustProxy);
// app.use(express.json({
//   limit: "1mb",
//   verify: (req, res, body) => {
//     if (req.originalUrl.split("?")[0] === "/v1/webhooks/razorpay") {
//       req.rawBody = Buffer.from(body);
//     }
//   },
// }));
// app.use(express.urlencoded({ extended: true, limit: "1mb" }));
// app.use(cookieParser());

// const defaultOrigins = [
//   "http://localhost:5173",
//   "http://127.0.0.1:5173",
//   "http://localhost:3000",
//   "http://127.0.0.1:5174",
// "  http://localhost:5173/"
// ];

// const allowedOrigins = config.nodeEnv === "production"
//   ? config.allowedOrigins
//   : [...defaultOrigins, ...config.allowedOrigins];
// app.get("/", (req, res) => {
//   res.send("Welcome to the BusyBox API!");
// });
// app.get("/health", (req, res) => {
//   res.json({ success: true });
// });
// app.use(
//   cors({
//     origin: function (origin, callback) {
//       if (!origin) {
//         return callback(null, true);
//       }

//       if (allowedOrigins.includes(origin)) {
//         callback(null, true);
//       } else {
//         return callback(new AppError("Origin is not allowed", 403));
//       }
//     },
//     credentials: true,
//     methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
//     allowedHeaders: ["Content-Type", "Authorization"],
//   })
// );

// app.use("/v1", apiLimiter, mainRouter);
// app.use(errorHandler);

// async function start() {
//   if (!Number.isInteger(port) || port < 1 || port > 65535) {
//     throw new Error("PORT must be an integer between 1 and 65535");
//   }
//   if (!config.jwtSecret || config.jwtSecret.length < 32) {
//     throw new Error("JWT_SECRET must be configured with at least 32 characters");
//   }
//   if (!Number.isInteger(config.trustProxy) || config.trustProxy < 0) {
//     throw new Error("TRUST_PROXY must be a non-negative integer hop count");
//   }
//   if (
//     !Number.isInteger(config.msg91.otpExpiryMinutes) ||
//     config.msg91.otpExpiryMinutes < 1 ||
//     config.msg91.otpExpiryMinutes > 15
//   ) {
//     throw new Error("MSG91_OTP_EXPIRY_MINUTES must be between 1 and 15");
//   }
//   if (!Number.isSafeInteger(config.shippingChargePaise) || config.shippingChargePaise < 0 ||
//       config.shippingChargePaise > 2_147_483_647) {
//     throw new Error("SHIPPING_CHARGE_PAISE must be a non-negative integer amount in paise");
//   }
//   if (!Number.isSafeInteger(config.codChargePaise) || config.codChargePaise < 0 ||
//       config.codChargePaise > 2_147_483_647) {
//     throw new Error("COD_CHARGE_PAISE must be a non-negative integer amount in paise");
//   }
//   if (config.mainAdmin.mobile && !/^[6-9]\d{9}$/.test(config.mainAdmin.mobile)) {
//     throw new Error("MAIN_ADMIN_MOBILE must be a 10-digit Indian mobile number");
//   }
//   if (config.nodeEnv === "production") {
//     const required = {
//       DATABASE_URL: process.env.DATABASE_URL,
//       ALLOWED_ORIGINS: config.allowedOrigins.length > 0,
//       MAIN_ADMIN_EMAIL_OR_MOBILE: config.mainAdmin.email || config.mainAdmin.mobile,
//       MAIN_ADMIN_PASSWORD: process.env.MAIN_ADMIN_PASSWORD,
//       MSG91_AUTH_KEY: config.msg91.authKey,
//       MSG91_TEMPLATE_ID: config.msg91.templateId,
//       SELLER_NAME: config.seller.name,
//       SELLER_ADDRESS: config.seller.address,
//       SELLER_GSTIN: config.seller.gstin,
//     };
//     if (config.razorpay.enabled) {
//       required.RAZORPAY_KEY_ID = config.razorpay.keyId;
//       required.RAZORPAY_KEY_SECRET = config.razorpay.keySecret;
//       required.RAZORPAY_WEBHOOK_SECRET = config.razorpay.webhookSecret;
//     }
//     if (config.shiprocket.enabled) {
//       required.SHIPROCKET_EMAIL = config.shiprocket.email;
//       required.SHIPROCKET_PASSWORD = config.shiprocket.password;
//       required.WAREHOUSE_PINCODE = config.shiprocket.warehousePincode;
//       required.SHIPROCKET_WEBHOOK_TOKEN = config.shiprocket.webhookToken;
//     }
//     const missing = Object.entries(required)
//       .filter(([, value]) => !value)
//       .map(([name]) => name);
//     if (missing.length > 0) {
//       throw new Error(`Missing production configuration: ${missing.join(", ")}`);
//     }
//     if (process.env.MAIN_ADMIN_PASSWORD.length < 12) {
//       throw new Error("MAIN_ADMIN_PASSWORD must be at least 12 characters");
//     }
//     if (config.shiprocket.enabled && !/^[1-9]\d{5}$/.test(config.shiprocket.warehousePincode)) {
//       throw new Error("WAREHOUSE_PINCODE must be a valid 6-digit Indian pincode");
//     }
//     if (!config.seller.state) {
//       throw new Error("SELLER_STATE must be configured");
//     }
//   }
//   try {
//     await prisma.$connect();
//     console.log("Database connected successfully.");
//     await loadStoreSettings();
//   } catch (error) {
//     throw new Error(`Database connection failed: ${sanitizeErrorMessage(error)}`, { cause: error });
//   }
//   const server = await new Promise((resolve, reject) => {
//     const listener = app.listen(port, () => resolve(listener));
//     listener.once("error", reject);
//   });
//   console.log(`Server is running on port ${port}`);
//   console.log("Admin sign-in: run `npm run admin` in another terminal; it prints the exact login URL.");
//   console.log(
//     emailConfigured
//       ? "Customer email notifications are configured."
//       : "Customer email notifications are disabled; configure EMAIL_USER and EMAIL_PASS to enable them."
//   );

//   const shutdown = () => {
//     server.close(async (err) => {
//       if (err) {
//         console.error("Server shutdown failed:", err.message);
//         process.exitCode = 1;
//       }
//       await prisma.$disconnect();
//     });
//   };
//   process.once("SIGINT", shutdown);
//   process.once("SIGTERM", shutdown);
//   return server;
// }

// if (require.main === module) {
//   start().catch((err) => {
//     if (err.code === "EADDRINUSE") {
//       console.error(`Port ${port} is already in use. This process did not start another server.`);
//       console.error("If your backend is already running, leave it running and open the admin link from `npm run admin`.");
//     } else {
//       console.error("Server startup failed:", sanitizeErrorMessage(err));
//     }
//     process.exitCode = 1;
//   });
// }

// module.exports = { app, start };
const dotenv = require("dotenv");
const path = require("path");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const mainRouter = require("./src/routes/index.js");
const { errorHandler } = require("./src/middleware/error.js");
const config = require("./src/config.js");
const prisma = require("./src/prisma.js");
const { apiLimiter } = require("./src/middleware/rateLimit.js");
const { AppError } = require("./src/middleware/error.js");
const { isConfigured: emailConfigured } = require("./src/utils/email.js");
const { loadStoreSettings } = require("./src/utils/storeSettings.js");

const app = express();
const port = Number(config.port);

function sanitizeErrorMessage(error) {
  return String(error.message || "Unknown error")
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, "[redacted MongoDB connection URL]");
}

app.use(helmet());
if (config.trustProxy > 0) app.set("trust proxy", config.trustProxy);
app.use(express.json({
  limit: "1mb",
  verify: (req, res, body) => {
    if (req.originalUrl.split("?")[0] === "/v1/webhooks/razorpay") {
      req.rawBody = Buffer.from(body);
    }
  },
}));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());

const defaultOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5174",
  "https://naju-phi.vercel.app"
];

// Always include defaultOrigins even in production
const allowedOrigins = [
  ...defaultOrigins, 
  ...(Array.isArray(config.allowedOrigins) ? config.allowedOrigins : [])
];

app.get("/", (req, res) => {
  res.send("Welcome to the BusyBox API!");
});
app.get("/health", (req, res) => {
  res.json({ success: true });
});

// Extremely forgiving CORS configuration
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (e.g., mobile apps, proxies)
      if (!origin) {
        return callback(null, true);
      }

      // Allow if it is in our array OR if it is any Vercel domain
      if (allowedOrigins.includes(origin) || origin.endsWith(".vercel.app")) {
        callback(null, true);
      } else {
        // Logs exactly what URL was blocked so you can debug it in Render logs
        console.error(`CORS BLOCKED ORIGIN: "${origin}"`);
        return callback(new AppError(`Origin is not allowed by CORS: ${origin}`, 403));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use("/v1", apiLimiter, mainRouter);
app.use(errorHandler);

async function start() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  if (!config.jwtSecret || config.jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must be configured with at least 32 characters");
  }
  if (!Number.isInteger(config.trustProxy) || config.trustProxy < 0) {
    throw new Error("TRUST_PROXY must be a non-negative integer hop count");
  }
  if (
    !Number.isInteger(config.msg91.otpExpiryMinutes) ||
    config.msg91.otpExpiryMinutes < 1 ||
    config.msg91.otpExpiryMinutes > 15
  ) {
    throw new Error("MSG91_OTP_EXPIRY_MINUTES must be between 1 and 15");
  }
  if (!Number.isSafeInteger(config.shippingChargePaise) || config.shippingChargePaise < 0 ||
      config.shippingChargePaise > 2_147_483_647) {
    throw new Error("SHIPPING_CHARGE_PAISE must be a non-negative integer amount in paise");
  }
  if (!Number.isSafeInteger(config.codChargePaise) || config.codChargePaise < 0 ||
      config.codChargePaise > 2_147_483_647) {
    throw new Error("COD_CHARGE_PAISE must be a non-negative integer amount in paise");
  }
  if (config.mainAdmin.mobile && !/^[6-9]\d{9}$/.test(config.mainAdmin.mobile)) {
    throw new Error("MAIN_ADMIN_MOBILE must be a 10-digit Indian mobile number");
  }
  if (config.nodeEnv === "production") {
    const required = {
      DATABASE_URL: process.env.DATABASE_URL,
      ALLOWED_ORIGINS: allowedOrigins.length > 0,
      MAIN_ADMIN_EMAIL_OR_MOBILE: config.mainAdmin.email || config.mainAdmin.mobile,
      MAIN_ADMIN_PASSWORD: process.env.MAIN_ADMIN_PASSWORD,
      MSG91_AUTH_KEY: config.msg91.authKey,
      MSG91_TEMPLATE_ID: config.msg91.templateId,
      SELLER_NAME: config.seller.name,
      SELLER_ADDRESS: config.seller.address,
      SELLER_GSTIN: config.seller.gstin,
    };
    if (config.razorpay.enabled) {
      required.RAZORPAY_KEY_ID = config.razorpay.keyId;
      required.RAZORPAY_KEY_SECRET = config.razorpay.keySecret;
      required.RAZORPAY_WEBHOOK_SECRET = config.razorpay.webhookSecret;
    }
    if (config.shiprocket.enabled) {
      required.SHIPROCKET_EMAIL = config.shiprocket.email;
      required.SHIPROCKET_PASSWORD = config.shiprocket.password;
      required.WAREHOUSE_PINCODE = config.shiprocket.warehousePincode;
      required.SHIPROCKET_WEBHOOK_TOKEN = config.shiprocket.webhookToken;
    }
    const missing = Object.entries(required)
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(`Missing production configuration: ${missing.join(", ")}`);
    }
    if (process.env.MAIN_ADMIN_PASSWORD.length < 12) {
      throw new Error("MAIN_ADMIN_PASSWORD must be at least 12 characters");
    }
    if (config.shiprocket.enabled && !/^[1-9]\d{5}$/.test(config.shiprocket.warehousePincode)) {
      throw new Error("WAREHOUSE_PINCODE must be a valid 6-digit Indian pincode");
    }
    if (!config.seller.state) {
      throw new Error("SELLER_STATE must be configured");
    }
  }
  try {
    await prisma.$connect();
    console.log("Database connected successfully.");
    await loadStoreSettings();
  } catch (error) {
    throw new Error(`Database connection failed: ${sanitizeErrorMessage(error)}`, { cause: error });
  }
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, () => resolve(listener));
    listener.once("error", reject);
  });
  console.log(`Server is running on port ${port}`);
  console.log("Admin sign-in: run `npm run admin` in another terminal; it prints the exact login URL.");
  console.log(
    emailConfigured
      ? "Customer email notifications are configured."
      : "Customer email notifications are disabled; configure EMAIL_USER and EMAIL_PASS to enable them."
  );

  const shutdown = () => {
    server.close(async (err) => {
      if (err) {
        console.error("Server shutdown failed:", err.message);
        process.exitCode = 1;
      }
      await prisma.$disconnect();
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}

if (require.main === module) {
  start().catch((err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. This process did not start another server.`);
      console.error("If your backend is already running, leave it running and open the admin link from `npm run admin`.");
    } else {
      console.error("Server startup failed:", sanitizeErrorMessage(err));
    }
    process.exitCode = 1;
  });
}

module.exports = { app, start };