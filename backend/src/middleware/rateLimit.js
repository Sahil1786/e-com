const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

function otpRateLimitKey(req) {
  const mobile = String(req.body?.mobile || "").replace(/\D/g, "").slice(-10);
  if (/^[6-9]\d{9}$/.test(mobile)) return `mobile:${mobile}`;

  const identifier = String(req.body?.identifier || "").trim().toLowerCase();
  if (identifier) return `identifier:${identifier.slice(0, 254)}`;

  return `ip:${ipKeyGenerator(req.ip)}`;
}

function createLimiter(windowMs, limit, message, keyGenerator) {
  return rateLimit({
    windowMs,
    limit,
    ...(keyGenerator ? { keyGenerator } : {}),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { success: false, error: message },
  });
}

module.exports = {
  apiLimiter: createLimiter(15 * 60 * 1000, 600, "Too many requests. Try again later."),
  otpSendLimiter: createLimiter(
    15 * 60 * 1000,
    3,
    "Too many OTP requests. Try again later.",
    otpRateLimitKey
  ),
  otpVerifyLimiter: createLimiter(
    15 * 60 * 1000,
    10,
    "Too many OTP attempts. Request a new OTP later.",
    otpRateLimitKey
  ),
  checkoutLimiter: createLimiter(60 * 1000, 10, "Too many checkout requests. Try again shortly."),
  otpRateLimitKey,
};
