require('dotenv').config();

module.exports = {
  port: process.env.PORT || 4000,
  trustProxy: Number(process.env.TRUST_PROXY || 0),
  jwtSecret: process.env.JWT_SECRET || '',
  nodeEnv: process.env.NODE_ENV || 'development',
  mainAdmin: {
    mobile: (process.env.MAIN_ADMIN_MOBILE || '').trim(),
    email: (process.env.MAIN_ADMIN_EMAIL || '').trim().toLowerCase(),
  },
  msg91: {
    authKey: (process.env.MSG91_AUTH_KEY || '').trim(),
    templateId: (
      process.env.MSG91_TEMPLATE_ID ||
      process.env.MSG91_OTP_TEMPLATE_ID ||
      ''
    ).trim(),
    invoiceTemplateId: (process.env.MSG91_INVOICE_TEMPLATE_ID || '').trim(),
    otpExpiryMinutes: Number(process.env.MSG91_OTP_EXPIRY_MINUTES || 5),
  },
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
  },
  razorpay: {
    enabled: process.env.ENABLE_RAZORPAY === 'true',
    keyId: (process.env.RAZORPAY_KEY_ID || '').trim(),
    keySecret: (process.env.RAZORPAY_KEY_SECRET || '').trim(),
    webhookSecret: (process.env.RAZORPAY_WEBHOOK_SECRET || '').trim(),
  },
  seller: {
    name: process.env.SELLER_NAME || '',
    address: process.env.SELLER_ADDRESS || '',
    gstin: process.env.SELLER_GSTIN || '',
    state: (process.env.SELLER_STATE || 'KARNATAKA').trim().toUpperCase(),
  },
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  shiprocket: {
    enabled: process.env.ENABLE_SHIPROCKET === 'true',
    email: (process.env.SHIPROCKET_EMAIL || '').trim(),
    password: process.env.SHIPROCKET_PASSWORD || '',
    warehousePincode: (process.env.WAREHOUSE_PINCODE || '').trim(),
    pickupLocation: process.env.WAREHOUSE_PICKUP_LOCATION || 'Primary',
    webhookToken: process.env.SHIPROCKET_WEBHOOK_TOKEN || '',
  },
  shippingChargePaise: Number(process.env.SHIPPING_CHARGE_PAISE || 0),

  validGstSlabs: [0, 5, 12, 18, 28],
};