/**
 * BowaGO — User Seed Script
 * ─────────────────────────
 * Creates one user for every role and sub-role combination.
 *
 * Usage:
 *   node scripts/seed-users.js
 *
 * Place this file at: bowago-backend/scripts/seed-users.js
 * Requires: DATABASE_URL in .env  |  bcryptjs installed
 *
 * All seeded accounts use password:  Admin@1234!
 * (Change SEED_PASSWORD below before running in production)
 */

require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

// ─── Config ────────────────────────────────────────────────────────────────────
const SEED_PASSWORD = "Admin@1234!";
const EMAIL_DOMAIN = "bowago.dev"; // change to your actual domain

// ─── User definitions ──────────────────────────────────────────────────────────
const USERS = [
  // ── Customers ──────────────────────────────────────────────────────────────
  {
    firstName: "Alice",
    lastName: "Customer",
    email: `customer.alice@${EMAIL_DOMAIN}`,
    phone: "+2348000000001",
    role: "CUSTOMER",
    adminSubRole: null,
    description: "Standard end customer",
  },
  {
    firstName: "Bob",
    lastName: "Customer",
    email: `customer.bob@${EMAIL_DOMAIN}`,
    phone: "+2348000000002",
    role: "CUSTOMER",
    adminSubRole: null,
    description: "Standard end customer (second account)",
  },

  // ── Super Admin ────────────────────────────────────────────────────────────
  {
    firstName: "Super",
    lastName: "Admin",
    email: `superadmin@${EMAIL_DOMAIN}`,
    phone: "+2348000000010",
    role: "ADMIN",
    adminSubRole: "SUPER_ADMIN",
    description: "Full system access — manages roles, rates, all data",
  },

  // ── Logistics Manager (legacy default admin) ───────────────────────────────
  {
    firstName: "Logistics",
    lastName: "Manager",
    email: `logistics@${EMAIL_DOMAIN}`,
    phone: "+2348000000011",
    role: "ADMIN",
    adminSubRole: "LOGISTICS_MANAGER",
    description: "Legacy default admin role — full operational access",
  },

  // ── Role Admin (custom — capabilities set separately via /admin/roles) ─────
  {
    firstName: "Role",
    lastName: "Admin",
    email: `roleadmin@${EMAIL_DOMAIN}`,
    phone: "+2348000000012",
    role: "ADMIN",
    adminSubRole: "ROLE_ADMIN",
    description: "Custom admin — capabilities assigned by SUPER_ADMIN",
  },

  // ── CS Agent ───────────────────────────────────────────────────────────────
  {
    firstName: "Chioma",
    lastName: "Agent",
    email: `agent@${EMAIL_DOMAIN}`,
    phone: "+2348000000013",
    role: "ADMIN",
    adminSubRole: "ROLE_AGENT",
    description: "CS rep — read/update tickets, view customers and shipments",
  },

  // ── Company Master ─────────────────────────────────────────────────────────
  {
    firstName: "Emeka",
    lastName: "Master",
    email: `master@${EMAIL_DOMAIN}`,
    phone: "+2348000000014",
    role: "ADMIN",
    adminSubRole: "ROLE_MASTER",
    description: "Company master — manages team, assigns company roles",
  },

  // ── Dispatcher ─────────────────────────────────────────────────────────────
  {
    firstName: "Dayo",
    lastName: "Dispatcher",
    email: `dispatcher@${EMAIL_DOMAIN}`,
    phone: "+2348000000015",
    role: "ADMIN",
    adminSubRole: "ROLE_DISPATCHER",
    description: "Company dispatcher — create shipments, update status",
  },

  // ── Finance ────────────────────────────────────────────────────────────────
  {
    firstName: "Fatima",
    lastName: "Finance",
    email: `finance@${EMAIL_DOMAIN}`,
    phone: "+2348000000016",
    role: "ADMIN",
    adminSubRole: "ROLE_FINANCE",
    description: "Company finance — view/pay invoices, download reports",
  },

  // ── Company User ───────────────────────────────────────────────────────────
  {
    firstName: "Uche",
    lastName: "CompanyUser",
    email: `companyuser@${EMAIL_DOMAIN}`,
    phone: "+2348000000017",
    role: "ADMIN",
    adminSubRole: "ROLE_USER",
    description: "End customer via company context",
  },
];

// ─── Seed ──────────────────────────────────────────────────────────────────────
async function seed() {
  console.log("\n🌱  BowaGO User Seed Script");
  console.log("─".repeat(55));

  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 12);
  let created = 0;
  let skipped = 0;
  const results = [];

  for (const user of USERS) {
    const existing = await prisma.user.findUnique({
      where: { email: user.email },
    });

    if (existing) {
      console.log(`  ⏭  SKIP   ${user.email} (already exists)`);
      skipped++;
      results.push({ ...user, status: "skipped", id: existing.id });
      continue;
    }

    const created_user = await prisma.user.create({
      data: {
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        passwordHash,
        role: user.role,
        adminSubRole: user.adminSubRole,
        isEmailVerified: true, // skip OTP verification for seed accounts
        isActive: true,
        authProvider: "EMAIL",
      },
    });

    console.log(
      `  ✅  CREATE ${user.email}  [${user.role}${user.adminSubRole ? ` / ${user.adminSubRole}` : ""}]`,
    );
    created++;
    results.push({ ...user, status: "created", id: created_user.id });
  }

  // ─── Summary table ──────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(55));
  console.log(
    `  Total: ${USERS.length} users  |  Created: ${created}  |  Skipped: ${skipped}`,
  );
  console.log("─".repeat(55));
  console.log("\n📋  Seeded Accounts\n");
  console.log(
    "  Role".padEnd(12) +
      "Sub-Role".padEnd(22) +
      "Email".padEnd(38) +
      "Password",
  );
  console.log("  " + "─".repeat(85));

  for (const r of results) {
    const role = r.role.padEnd(10);
    const sub = (r.adminSubRole ?? "—").padEnd(20);
    const email = r.email.padEnd(36);
    const status =
      r.status === "skipped" ? "  (existing)" : `  ${SEED_PASSWORD}`;
    console.log(`  ${role}  ${sub}  ${email}${status}`);
  }

  console.log("\n🔐  Default password for all new accounts:  " + SEED_PASSWORD);
  console.log("⚠️   Change passwords before going to production!\n");
}

seed()
  .catch((err) => {
    console.error("\n❌  Seed failed:", err.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
