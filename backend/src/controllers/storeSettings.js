const express = require("express");
const { authenticate, requireAdmin } = require("../middleware/auth");
const { AppError } = require("../middleware/error");
const { getCurrentStoreSettings, saveStoreSettings } = require("../utils/storeSettings");

const router = express.Router();
const maxPaise = 2_147_483_647;
const allowedFields = new Set([
  "shippingChargePaise",
  "codChargePaise",
  "brandName",
  "logoUrl",
]);

function validateStoreSettingsChanges(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("Settings must be provided as an object", 400);
  }
  if (Object.keys(body).some((field) => !allowedFields.has(field))) {
    throw new AppError("Only store branding and delivery charges can be changed", 400);
  }

  const changes = {};
  for (const field of ["shippingChargePaise", "codChargePaise"]) {
    if (body[field] === undefined) continue;
    if (!Number.isSafeInteger(body[field]) || body[field] < 0 || body[field] > maxPaise) {
      throw new AppError(`${field} must be a non-negative whole number of paise`, 400);
    }
    changes[field] = body[field];
  }
  if (body.brandName !== undefined) {
    if (typeof body.brandName !== "string" || !body.brandName.trim() || body.brandName.trim().length > 80) {
      throw new AppError("brandName must contain between 1 and 80 characters", 400);
    }
    changes.brandName = body.brandName.trim();
  }
  if (body.logoUrl !== undefined) {
    if (typeof body.logoUrl !== "string" || body.logoUrl.length > 2048) {
      throw new AppError("logoUrl must be a valid HTTPS URL or empty", 400);
    }
    const logoUrl = body.logoUrl.trim();
    if (logoUrl) {
      let parsedUrl;
      try {
        parsedUrl = new URL(logoUrl);
      } catch {
        throw new AppError("logoUrl must be a valid HTTPS URL or empty", 400);
      }
      if (parsedUrl.protocol !== "https:" || !parsedUrl.hostname || parsedUrl.username || parsedUrl.password) {
        throw new AppError("logoUrl must be a valid HTTPS URL or empty", 400);
      }
    }
    changes.logoUrl = logoUrl || null;
  }
  if (Object.keys(changes).length === 0) {
    throw new AppError("Provide branding or delivery charges to update", 400);
  }
  return changes;
}

router.get("/store-settings", authenticate, requireAdmin, async (req, res, next) => {
  try {
    res.json({ success: true, settings: await getCurrentStoreSettings() });
  } catch (err) {
    next(err);
  }
});

router.put("/store-settings", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const changes = validateStoreSettingsChanges(req.body);
    const settings = await saveStoreSettings(changes);
    res.json({ success: true, settings });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.validateStoreSettingsChanges = validateStoreSettingsChanges;
