/**
 * seed-users.js
 *
 * Creates one user per role/sub-role across all three worlds (Internal
 * Admin, Enterprise, Customer) so you can log in and test the RBAC split
 * end-to-end on the fresh database.
 *
 * Usage:
 *   node prisma/seed-users.js
 *
 * All seeded users share the same password (see PASSWORD below) — change
 * it after first login, or edit PASSWORD before running in anything but a
 * throwaway/dev environment.
 */
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const PASSWORD = "Password123!";

async function upsertUser({
  email,
  firstName,
  lastName,
  role,
  adminSubRole = null,
  enterpriseRole = null,
  masterId = null,
  phone = null,
}) {
  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  const user = await prisma.user.upsert({
    where: { email },
    update: {
      role,
      adminSubRole,
      enterpriseRole,
      masterId,
    },
    create: {
      email,
      phone,
      firstName,
      lastName,
      passwordHash,
      role,
      adminSubRole,
      enterpriseRole,
      masterId,
      authProvider: "EMAIL",
      isEmailVerified: true,
      isPhoneVerified: !!phone,
      isActive: true,
    },
  });
  console.log(
    `  ✓ ${role}${adminSubRole ? "/" + adminSubRole : ""}${enterpriseRole ? "/" + enterpriseRole : ""}  ${email}  (id: ${user.id})`,
  );
  return user;
}

async function main() {
  console.log(`\nSeeding users — all passwords: "${PASSWORD}"\n`);

  // ── Internal BowaGo Administration ──────────────────────────────────────
  console.log("Internal Admin:");
  const superAdmin = await upsertUser({
    email: "super.admin@bowago.dev",
    firstName: "Super",
    lastName: "Admin",
    role: "ADMIN",
    adminSubRole: "SUPER_ADMIN",
  });

  await upsertUser({
    email: "logistics.manager@bowago.dev",
    firstName: "Logistics",
    lastName: "Manager",
    role: "ADMIN",
    adminSubRole: "LOGISTICS_MANAGER",
  });

  const roleAdmin = await upsertUser({
    email: "role.admin@bowago.dev",
    firstName: "Custom",
    lastName: "Admin",
    role: "ADMIN",
    adminSubRole: "ROLE_ADMIN",
  });

  // Grant the ROLE_ADMIN test user a representative set of capabilities so
  // there's something meaningful to test capability-gated routes with.
  await prisma.adminRolePermission.upsert({
    where: { userId: roleAdmin.id },
    update: {},
    create: {
      userId: roleAdmin.id,
      canManageRates: true,
      canManageShipments: true,
      canManageTickets: true,
      canViewAnalytics: true,
      canManageSurcharges: true,
      roleLabel: "Ops & Rates Admin",
      createdBy: superAdmin.id,
    },
  });
  console.log(
    "    → granted canManageRates/Shipments/Tickets/Analytics/Surcharges to role.admin@bowago.dev",
  );

  // ── Enterprise tenant (one company, all five roles) ─────────────────────
  console.log("\nEnterprise (Acme Logistics Ltd):");
  const master = await upsertUser({
    email: "master@acme-enterprise.dev",
    firstName: "Acme",
    lastName: "Owner",
    role: "ENTERPRISE",
    enterpriseRole: "ROLE_MASTER",
  });
  // The master's own company profile fields (optional, but nice for testing
  // the Company Settings page)
  http: await prisma.user.update({
    where: { id: master.id },
    data: {
      companyName: "Acme Logistics Ltd",
      industry: "Retail",
      companyEmail: "hello@acme-enterprise.dev",
      companyCity: "Abuja",
      companyCountry: "Nigeria",
    },
  });

  await upsertUser({
    email: "dispatcher@acme-enterprise.dev",
    firstName: "Acme",
    lastName: "Dispatcher",
    role: "ENTERPRISE",
    enterpriseRole: "ROLE_DISPATCHER",
    masterId: master.id,
  });

  await upsertUser({
    email: "finance@acme-enterprise.dev",
    firstName: "Acme",
    lastName: "Finance",
    role: "ENTERPRISE",
    enterpriseRole: "ROLE_FINANCE",
    masterId: master.id,
  });

  await upsertUser({
    email: "agent@acme-enterprise.dev",
    firstName: "Acme",
    lastName: "Agent",
    role: "ENTERPRISE",
    enterpriseRole: "ROLE_AGENT",
    masterId: master.id,
  });

  await upsertUser({
    email: "user@acme-enterprise.dev",
    firstName: "Acme",
    lastName: "TeamMember",
    role: "ENTERPRISE",
    enterpriseRole: "ROLE_USER",
    masterId: master.id,
  });

  // ── Customer ──────────────────────────────────────────────────────────────
  console.log("\nCustomer:");
  await upsertUser({
    email: "customer@bowago.dev",
    firstName: "Test",
    lastName: "Customer",
    role: "CUSTOMER",
    phone: "+2348000000001",
  });

  console.log(
    "\nDone. Log in with any email above and password: " + PASSWORD + "\n",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
