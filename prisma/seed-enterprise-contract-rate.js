/**
 * seed-enterprise-contract-rate.js
 *
 * Attaches a sample B2B contract rate to the Enterprise ROLE_MASTER account
 * created by seed-users.js (master@acme-enterprise.dev). A contract rate
 * assigned to a ROLE_MASTER automatically applies to their whole team
 * (pricing.service.js's getContractRate checks the user's own rate first,
 * then falls back to their masterId's rate) — so every Acme team member
 * seeded in seed-users.js (dispatcher/finance/agent/user) gets this rate
 * too, without a separate row each.
 *
 * Run this AFTER seed-users.js — it looks up the master account by email
 * and will fail with a clear message if that user doesn't exist yet.
 *
 * Safe to re-run — upserts by userId (a user can only have one contract
 * rate; that's a DB-level unique constraint).
 *
 * Usage:
 *   node prisma/seed-enterprise-contract-rate.js
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const MASTER_EMAIL = "master@acme-enterprise.dev";

async function main() {
  console.log(`\nLooking up Enterprise master account: ${MASTER_EMAIL}...\n`);

  const master = await prisma.user.findUnique({ where: { email: MASTER_EMAIL } });
  if (!master) {
    console.error(
      `✗ No user found with email "${MASTER_EMAIL}". Run prisma/seed-users.js first.\n`,
    );
    process.exit(1);
  }
  if (master.role !== "ENTERPRISE" || master.enterpriseRole !== "ROLE_MASTER") {
    console.error(
      `✗ ${MASTER_EMAIL} exists but isn't an Enterprise ROLE_MASTER ` +
        `(role=${master.role}, enterpriseRole=${master.enterpriseRole}). ` +
        `Contract rates should be assigned to the org owner, not a team member ` +
        `— it applies to the whole team automatically via their masterId.\n`,
    );
    process.exit(1);
  }

  // Need at least one internal admin to attribute createdBy to. Use whichever
  // SUPER_ADMIN exists (seed-users.js creates super.admin@bowago.dev).
  const admin = await prisma.user.findFirst({
    where: { role: "ADMIN", adminSubRole: "SUPER_ADMIN" },
  });
  if (!admin) {
    console.error(
      "✗ No internal SUPER_ADMIN found to attribute this contract rate to. " +
        "Run prisma/seed-users.js first.\n",
    );
    process.exit(1);
  }

  const contractRate = await prisma.contractRate.upsert({
    where: { userId: master.id },
    update: {
      label: "Acme Logistics Ltd — Annual Contract",
      serviceType: null, // applies to all service types
      discountPercent: 15,
      fixedPricePerKgByZone: null,
      isActive: true,
      validFrom: new Date(),
      validUntil: null, // no expiry
      notes: "Seeded example enterprise contract rate — 15% off standard pricing, all zones.",
      createdBy: admin.id,
    },
    create: {
      userId: master.id,
      label: "Acme Logistics Ltd — Annual Contract",
      serviceType: null,
      discountPercent: 15,
      fixedPricePerKgByZone: null,
      isActive: true,
      validFrom: new Date(),
      validUntil: null,
      notes: "Seeded example enterprise contract rate — 15% off standard pricing, all zones.",
      createdBy: admin.id,
    },
  });

  console.log(`✓ Contract rate attached to ${MASTER_EMAIL} (id: ${contractRate.id})`);
  console.log(`  ${contractRate.discountPercent}% off standard pricing, all service types, all zones.`);
  console.log(
    `  This applies automatically to every Acme team member (dispatcher/finance/agent/user) ` +
      `seeded in seed-users.js, via their masterId pointing back to this account.\n`,
  );

  console.log(
    "To create a FIXED price-per-zone contract instead of a percentage discount, " +
      "edit this script's `discountPercent: 15` to e.g.:\n" +
      "    fixedPricePerKgByZone: { \"1\": 150, \"2\": 120, \"3\": 100, \"4\": 90 },\n" +
      "    discountPercent: null,\n",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
