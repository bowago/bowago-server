const { PrismaClient } = require("@prisma/client");

// ─── Connection pool tuning ─────────────────────────────────────────────────
// Neon serverless Postgres closes idle connections after ~5 minutes of
// inactivity.  We tell Prisma to:
//   • Keep at most 5 connections in the pool (Neon free tier allows ~10)
//   • Timeout connection acquisition after 10s (not hang forever)
//   • Set socket timeout to 15s so stale sockets surface quickly
//
// These are appended to DATABASE_URL as query params if not already present.
function buildConnectionUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL environment variable is not set");
  const sep = url.includes("?") ? "&" : "?";
  // Only append if not already configured
  if (url.includes("connection_limit")) return url;
  return `${url}${sep}connection_limit=5&pool_timeout=30&connect_timeout=30`;
}

const basePrisma = new PrismaClient({
  datasourceUrl: buildConnectionUrl(),
  log:
    process.env.NODE_ENV === "development"
      ? ["error", "warn"] // removed "query" — it floods logs and slows dev
      : ["error"],
});

// ─── Auto-reconnect on stale Neon connection ─────────────────────────────────
// Neon's serverless pooler closes idle sockets. When Prisma reuses a dead
// socket it throws "Error { kind: Closed }". We catch this, force a fresh
// connection, and retry once. A second failure propagates normally.
function isClosedConnectionError(err) {
  return (
    err?.message?.includes("kind: Closed") ||
    err?.message?.includes("Connection closed") ||
    err?.message?.includes("Can't reach database server") ||
    err?.code === "P1017" ||
    err?.code === "P1001"
  );
}

let reconnecting = false;

const prisma = basePrisma.$extends({
  query: {
    async $allOperations({ model, operation, args, query }) {
      try {
        return await query(args);
      } catch (err) {
        if (!isClosedConnectionError(err)) throw err;

        // Avoid multiple concurrent reconnects hammering the DB
        if (!reconnecting) {
          reconnecting = true;
          console.warn(
            `⚠️  Stale Neon connection on ${model ?? "??"}.${operation} — reconnecting...`,
          );
          try {
            await basePrisma.$disconnect();
            // Brief pause before reconnecting
            await new Promise((r) => setTimeout(r, 200));
            await basePrisma.$connect();
          } catch (reconnErr) {
            console.error("Reconnect failed:", reconnErr.message);
          } finally {
            reconnecting = false;
          }
        } else {
          // Wait for the in-progress reconnect to finish
          await new Promise((r) => setTimeout(r, 500));
        }

        // Retry once with a fresh connection
        return query(args);
      }
    },
  },
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// Ensure the pool is cleanly closed when the process exits, so Neon doesn't
// hold onto zombie connections.
process.on("beforeExit", async () => {
  await basePrisma.$disconnect();
});
process.on("SIGINT", async () => {
  await basePrisma.$disconnect();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await basePrisma.$disconnect();
  process.exit(0);
});

module.exports = { prisma };
