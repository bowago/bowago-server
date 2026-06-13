const { PrismaClient } = require("@prisma/client");
require("dotenv").config();

const basePrisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL,
  log:
    process.env.NODE_ENV === "development"
      ? ["query", "error", "warn"]
      : ["error"],
});

// ============================================================================
// Neon auto-reconnect extension
// ============================================================================
// Neon's serverless Postgres closes idle connections after a few minutes of
// inactivity. Prisma's connection pool can hold onto a now-dead socket and
// throw "Error in PostgreSQL connection: Error { kind: Closed, cause: None }"
// on the next query — even though the database itself is fine.
//
// This Client Extension (the Prisma 5+/6+ replacement for the removed $use
// middleware) catches that specific error, forces Prisma to disconnect and
// reconnect (opening a fresh socket), then retries the query once. Without
// this, every request hitting a stale connection 500s until the process
// restarts.
// ============================================================================
const prisma = basePrisma.$extends({
  query: {
    async $allOperations({ model, operation, args, query }) {
      try {
        return await query(args);
      } catch (err) {
        const isClosedConnection =
          err?.message?.includes("kind: Closed") ||
          err?.message?.includes("Connection closed") ||
          err?.code === "P1017"; // Prisma: "Server has closed the connection"

        if (!isClosedConnection) throw err;

        console.warn(
          `⚠️  Stale DB connection detected on ${model}.${operation} — reconnecting and retrying once...`,
        );

        await basePrisma.$disconnect();
        await basePrisma.$connect();

        // Retry the same query once with a fresh connection
        return query(args);
      }
    },
  },
});

module.exports = { prisma };
