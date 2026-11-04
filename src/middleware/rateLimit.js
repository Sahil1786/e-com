const { rateLimit } = require("express-rate-limit");

function createLimiter(windowMs, limit, message) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { success: false, error: message },
  });
}

module.exports = {
  apiLimiter: createLimiter(15 * 60 * 1000, 600, "Too many requests. Try again later."),
  otpSendLimiter: createLimiter(15 * 60 * 1000, 3, "Too many OTP requests. Try again later."),
  otpVerifyLimiter: createLimiter(15 * 60 * 1000, 10, "Too many OTP attempts. Request a new OTP later."),
  checkoutLimiter: createLimiter(60 * 1000, 10, "Too many checkout requests. Try again shortly."),
};
