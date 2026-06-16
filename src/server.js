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

  // ─── Neon keepalive ping ─────────────────────────────────────────────────
  // Neon's serverless Postgres closes idle connections after ~5 minutes.
  // In development with nodemon, the backend stays alive for hours, so we
  // ping every 4 minutes to keep the pool warm and avoid the cascade of
  // "Error { kind: Closed }" errors after a quiet period.
  const KEEPALIVE_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes
  setInterval(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      // Reconnect is handled by the $extends middleware in db.js — this is
      // just a best-effort warmup ping, so we suppress errors here.
    }
  }, KEEPALIVE_INTERVAL_MS);
  // ─────────────────────────────────────────────────────────────────────────

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
