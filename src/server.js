require("express-async-errors");
require("dotenv").config();

const app = require("./app");
const { prisma } = require("./config/db");

const PORT = process.env.PORT || 5000;

async function start() {
  try {
    await prisma.$connect();
    console.log("✅ Database connected");

    app.listen(PORT, () => {
      console.log(
        `🚀 BowaGO API running on port ${PORT} [${process.env.NODE_ENV}]`,
      );
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err);
    process.exit(1);
  }
}

// Only start the server when not on Vercel (serverless)
if (process.env.VERCEL !== "1") {
  start();
} else {
  // Vercel just needs the export
  prisma.$connect().catch(console.error);
}

process.on("SIGTERM", async () => {
  await prisma.$disconnect();
  process.exit(0);
});

module.exports = app;
