require("express-async-errors");
// Only load .env file locally — on Vercel, env vars are injected by the platform
if (process.env.VERCEL !== "1") {
  require("dotenv").config();
}

const http = require("http");
const app = require("./app");
const { prisma } = require("./config/db");
const socketService = require("./services/socket.service");

const PORT = process.env.PORT || 5000;

// ─── Create HTTP server (needed to attach Socket.IO) ─────────────────────────
const httpServer = http.createServer(app);

// ─── Sprint 4: Initialize Socket.IO for real-time tracking ───────────────────
// Skipped on Vercel (serverless — persistent connections not supported).
// On local / Railway / Render / EC2 the WS server stays alive.
if (process.env.VERCEL !== "1") {
  socketService.init(httpServer);
}

// ─── Only start HTTP server when running locally ──────────────────────────────
// On Vercel (serverless), we just export the app — Vercel handles the server.
// Calling app.listen() inside a serverless function causes FUNCTION_INVOCATION_FAILED.
if (process.env.VERCEL !== "1") {
  async function start() {
    // Neon free tier cold-starts can take 10–20s. Retry up to 3 times before giving up.
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await prisma.$connect();
        break; // connected — exit retry loop
      } catch (err) {
        console.warn(`⚠️  DB connect attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
        if (attempt === MAX_RETRIES) {
          console.error("❌ Failed to start server after retries:", err);
          process.exit(1);
        }
        await new Promise((r) => setTimeout(r, 3000 * attempt)); // wait 3s, 6s
      }
    }

    console.log("✅ Database connected");
    httpServer.listen(PORT, () => {
      console.log(
        `🚀 BowaGO API running on port ${PORT} [${process.env.NODE_ENV || "development"}]`,
      );
      console.log(`📖 Swagger docs: http://localhost:${PORT}/api-docs`);
      console.log(`❤️  Health check: http://localhost:${PORT}/health`);
      console.log(`🔌 WebSocket (tracking): ws://localhost:${PORT}`);
    });
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

  // ─── Sprint 6: Ticket Escalation Job (PRD: 4-hour SLA) ───────────────────
  // Runs every 30 minutes. Finds IN_PROGRESS tickets older than 4 hours and
  // escalates them, notifying the team lead in-app.
  const { runEscalationJob } = require("./controllers/support.controller");
  const ESCALATION_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
  setInterval(async () => {
    try {
      const result = await runEscalationJob();
      if (result.escalated > 0) {
        console.log(`[Escalation] Auto-escalated ${result.escalated} stale ticket(s)`);
      }
    } catch (err) {
      console.error("[Escalation] Job failed:", err.message);
    }
  }, ESCALATION_INTERVAL_MS);
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
