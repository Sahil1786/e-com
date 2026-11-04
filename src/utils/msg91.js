const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const config = require('../config');
const prisma = require('../prisma');
const { AppError } = require('../middleware/error');

const normalizeMobile = (mobile) => {
  const cleaned = String(mobile || '').replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(cleaned)) {
    throw new AppError('Invalid 10-digit Indian mobile number', 400);
  }
  return cleaned;
};

async function sendOtp(rawMobile, purpose = 'Login') {
  const mobile = normalizeMobile(rawMobile);
  const mobileWithCountry = `91${mobile}`;

  const hasLiveConfig = Boolean(config.msg91.authKey && config.msg91.templateId);
  if (!hasLiveConfig && config.nodeEnv === 'production') {
    throw new AppError('MSG91 is not configured for production OTP delivery', 503);
  }

  // Generate a random 6-digit OTP when live, or '123456' in dev fallback
  const plainOtp = hasLiveConfig
    ? String(crypto.randomInt(100000, 1000000))
    : '123456';

  const otpHash = await bcrypt.hash(plainOtp, 10);
  const expiresAt = new Date(Date.now() + config.msg91.otpExpiryMinutes * 60 * 1000);

  // Store the hashed OTP in Prisma so verifyOtp works reliably
  await prisma.otpVerification.upsert({
    where: { mobile },
    update: { otpHash, expiresAt, attemptCount: 0 },
    create: { mobile, otpHash, expiresAt, attemptCount: 0 },
  });

  // 1. Live MSG91 Flow API
  if (hasLiveConfig) {
    const response = await fetch('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authkey: config.msg91.authKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        template_id: config.msg91.templateId,
        short_url: '0',
        recipients: [
          {
            mobiles: mobileWithCountry,
            purpose: purpose,
            otp: plainOtp,
          },
        ],
      }),
    });

    const data = await response.json();
    if (data.type !== 'success') {
      throw new AppError(data.message || 'Failed to send OTP via MSG91', 400);
    }

    return { mobile, provider: 'MSG91' };
  }

  // 2. Local Dev Fallback (only runs if MSG91 keys are missing)
  console.log(`[DEV OTP] Mobile: ${mobile} | OTP: ${plainOtp}`);
  return { mobile, provider: 'DEV_FALLBACK', devOtp: plainOtp };
}

async function verifyOtp(rawMobile, otp) {
  const mobile = normalizeMobile(rawMobile);
  const cleanOtp = String(otp || '').trim();

  if (!/^\d{4,6}$/.test(cleanOtp)) {
    throw new AppError('Please enter a valid 4 to 6 digit OTP', 400);
  }

  const record = await prisma.otpVerification.findUnique({ where: { mobile } });
  if (!record || new Date() > new Date(record.expiresAt)) {
    throw new AppError('OTP has expired or was not requested', 401);
  }
  if (record.attemptCount >= 5) {
    await prisma.otpVerification.deleteMany({ where: { id: record.id } });
    throw new AppError('Too many incorrect OTP attempts. Request a new OTP.', 429);
  }

  const isValid = await bcrypt.compare(cleanOtp, record.otpHash);
  if (!isValid) {
    const updated = await prisma.otpVerification.updateMany({
      where: { id: record.id, attemptCount: record.attemptCount },
      data: { attemptCount: { increment: 1 } },
    });
    if (updated.count !== 1) {
      throw new AppError('OTP was already used or changed. Request a new OTP.', 409);
    }
    if (record.attemptCount + 1 >= 5) {
      await prisma.otpVerification.deleteMany({ where: { id: record.id } });
      throw new AppError('Too many incorrect OTP attempts. Request a new OTP.', 429);
    }
    throw new AppError('Invalid OTP', 401);
  }

  const consumed = await prisma.otpVerification.deleteMany({
    where: { id: record.id, otpHash: record.otpHash },
  });
  if (consumed.count !== 1) {
    throw new AppError('OTP was already used or changed. Request a new OTP.', 409);
  }
  return mobile;
}

module.exports = { normalizeMobile, sendOtp, verifyOtp };