require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

function normalizeConfiguredMobile(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  const mobile = digits.slice(-10);
  return /^[6-9]\d{9}$/.test(mobile) ? mobile : digits;
}

module.exports = {
  port: process.env.PORT || 4000,
  trustProxy: Number(process.env.TRUST_PROXY || 0),
  jwtSecret: process.env.JWT_SECRET || '',
  nodeEnv: process.env.NODE_ENV || 'development',
  mainAdmin: {
    mobile: normalizeConfiguredMobile(process.env.MAIN_ADMIN_MOBILE),
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
  email: {
    user: (process.env.EMAIL_USER || '').trim(),
    pass: (process.env.EMAIL_PASS || '').replace(/\s/g, ''),
    host: (process.env.SMTP_HOST || 'smtp.gmail.com').trim(),
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE === undefined
      ? Number(process.env.SMTP_PORT || 465) === 465
      : process.env.SMTP_SECURE === 'true',
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
    configured: process.env.ENABLE_RAZORPAY === 'true' &&
      Boolean(process.env.RAZORPAY_KEY_ID?.trim()) &&
      Boolean(process.env.RAZORPAY_KEY_SECRET?.trim()) &&
      Boolean(process.env.RAZORPAY_WEBHOOK_SECRET?.trim()),
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
  shippingChargePaise: Number(process.env.SHIPPING_CHARGE_PAISE || 9900),
  codChargePaise: Number(process.env.COD_CHARGE_PAISE || 10000),
  freeShippingThresholdPaise: 99900,

  validGstSlabs: [0, 5, 12, 18, 28],
};