require('dotenv').config();

module.exports = {
  port: process.env.PORT || 4000,
  jwtSecret: process.env.JWT_SECRET || 'fallback_secret',
  nodeEnv: process.env.NODE_ENV || 'development',
  mainAdmin: {
    mobile: (process.env.MAIN_ADMIN_MOBILE || '9876543210').trim(),
    email: (process.env.MAIN_ADMIN_EMAIL || 'admin@store.com').trim().toLowerCase(),
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
    keyId: (process.env.RAZORPAY_KEY_ID || '').trim(),
    keySecret: (process.env.RAZORPAY_KEY_SECRET || '').trim(),
  },
  seller: {
    name: process.env.SELLER_NAME || 'Acme India Retail Pvt Ltd',
    address: process.env.SELLER_ADDRESS || '42 Residency Road, Bengaluru, KA',
    gstin: process.env.SELLER_GSTIN || '29AABCU9603R1ZM',
    state: (process.env.SELLER_STATE || 'KARNATAKA').trim().toUpperCase(),
  },

  validGstSlabs: [0, 5, 12, 18, 28],
};