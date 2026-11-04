const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const config = require('../src/config');

const prisma = new PrismaClient();

async function main() {
  const password = process.env.MAIN_ADMIN_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error('MAIN_ADMIN_PASSWORD must be set and at least 12 characters long');
  }
  if (!config.mainAdmin.email && !config.mainAdmin.mobile) {
    throw new Error('Set MAIN_ADMIN_EMAIL or MAIN_ADMIN_MOBILE before seeding the admin');
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

  console.log(`Main Admin Seeded -> ID: ${admin.id} | Mobile: ${admin.mobile} | Email: ${admin.email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());