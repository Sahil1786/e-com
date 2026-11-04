require("dotenv").config();

const prisma = require("../src/prisma");

async function checkDatabase() {
  try {
    await prisma.$connect();
    await prisma.user.count();
    console.log("Database connection successful.");
  } catch (error) {
    const message = String(error.message || "Unknown database error")
      .replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, "[redacted MongoDB connection URL]");
    console.error("Database connection failed:", message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

checkDatabase();
