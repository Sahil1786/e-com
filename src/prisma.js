const { PrismaClient } = require('@prisma/client');

console.log("🔍 DEBUG - DATABASE_URL is:", process.env.DATABASE_URL);

const prisma = new PrismaClient();

prisma.$connect()
  .then(() => {
    console.log('✅ Successfully connected to MongoDB Atlas via Prisma!');
  })
  .catch((error) => {
    console.error('❌ Database connection failed:', error.message);
  });

module.exports = prisma;