const { PrismaClient } = require('../generated/prisma');
const bcrypt = require('bcryptjs');
const config = require('../src/config');

const prisma = new PrismaClient();

async function main() {
  const password = process.env.MAIN_ADMIN_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error('MAIN_ADMIN_PASSWORD must be set and at least 12 characters long');
  }
  if (!/^[6-9]\d{9}$/.test(config.mainAdmin.mobile)) {
    throw new Error('Set MAIN_ADMIN_MOBILE to a valid 10-digit Indian number; administrator login requires OTP');
  }
  const email = config.mainAdmin.email;
  const mobile = config.mainAdmin.mobile;
  const passwordHash = await bcrypt.hash(password, 12);

  const admin = await prisma.user.upsert({
    where: email ? { email } : { mobile },
    update: { mobile: mobile || undefined, role: 'ADMIN', passwordHash },
    create: {
      name: 'Main Admin',
      email: email || null,
      mobile: mobile || null,
      passwordHash,
      role: 'ADMIN',
    },
  });

  const defaultCoupons = [
    { code: 'NEW10', type: 'FLAT', value: 1000 },
    { code: 'NEW20', type: 'PERCENT', value: 20 },
  ];
  for (const coupon of defaultCoupons) {
    await prisma.coupon.upsert({
      where: { code: coupon.code },
      update: {
        type: coupon.type,
        value: coupon.value,
        minOrderPaise: 0,
        maxDiscountPaise: null,
        usageLimit: null,
        expiresAt: null,
        productId: null,
        isActive: true,
      },
      create: {
        ...coupon,
        minOrderPaise: 0,
        maxDiscountPaise: null,
        usageLimit: null,
        expiresAt: null,
      },
    });
  }

  console.log(`Main Admin Seeded -> ID: ${admin.id} | Mobile: ${admin.mobile} | Email: ${admin.email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());