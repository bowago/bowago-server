require("express-async-errors");
// Only load .env file locally — on Vercel, env vars are injected by the platform
if (process.env.VERCEL !== "1") {
  require("dotenv").config();
}

const app = require("./app");
const { prisma } = require("./config/db");

const PORT = process.env.PORT || 5000;

// ─── Only start HTTP server when running locally ──────────────────────────────
// On Vercel (serverless), we just export the app — Vercel handles the server.
// Calling app.listen() inside a serverless function causes FUNCTION_INVOCATION_FAILED.
if (process.env.VERCEL !== "1") {
  async function start() {
    try {
      await prisma.$connect();
      console.log("✅ Database connected");
      app.listen(PORT, () => {
        console.log(
          `🚀 BowaGO API running on port ${PORT} [${process.env.NODE_ENV || "development"}]`,
        );
        console.log(`📖 Swagger docs: http://localhost:${PORT}/api-docs`);
        console.log(`❤️  Health check: http://localhost:${PORT}/health`);
      });
    } catch (err) {
      console.error("❌ Failed to start server:", err);
      process.exit(1);
    }
  }

  start();

  process.on("SIGTERM", async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
} else {
  // Vercel: connect DB lazily (connection pooling handled by Neon)
  prisma.$connect().catch((err) => {
    console.error("DB connect error:", err);
  });
}

// Must export app for Vercel to use as a serverless handler
module.exports = app;
