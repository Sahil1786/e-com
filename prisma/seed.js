const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const config = require('../src/config');

const prisma = new PrismaClient();

async function main() {
  const email = config.mainAdmin.email;
  const mobile = config.mainAdmin.mobile;
  const passwordHash = await bcrypt.hash('Admin@123', 10);

  const admin = await prisma.user.upsert({
    where: { email },
    update: { mobile, role: 'ADMIN' },
    create: {
      name: 'Main Admin',
      email,
      mobile,
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