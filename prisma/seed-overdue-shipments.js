/**
 * Seed: overdue shipments for delay-alert demo
 * ─────────────────────────────────────────────
 * Creates ~2 overdue shipments for each user below, so they show up in
 * GET /api/delay-alerts (getDelayedShipments) and can be used to demo
 * sendDelayAlert (in-app notification + email) from the admin panel.
 *
 * "Overdue" per delayAlert.controller.js#getDelayedShipments means:
 *   status in [CONFIRMED, PICKED_UP, IN_TRANSIT]  AND  estimatedDelivery < now
 *
 * Usage:
 *   node prisma/seed-overdue-shipments.js
 *
 * Safe to re-run — it only ever adds new shipments (unique trackingNumber
 * per run), it never touches existing data.
 */

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// ─── Users pulled from the exported users (1).json ───────────────────────────
// Only id/firstName/lastName/email are needed to create shipments as this
// customer. Every user in the export gets shipments, admin/enterprise roles
// included, so the whole list is populated for the demo.
const USERS = [
  {
    id: "13b87cd9-de15-457e-b813-9f446a0561e7",
    firstName: "Test",
    lastName: "Customer",
    email: "customer@bowago.dev",
  },
  {
    id: "2694172a-1e87-40c8-bfcf-4f9f71e48887",
    firstName: "Caleb",
    lastName: "Opule",
    email: "opulecalebtins@gmail.com",
  },
  {
    id: "2710b835-8828-4d65-87c5-050b421f1a08",
    firstName: "Logistics",
    lastName: "Manager",
    email: "logistics.manager@bowago.dev",
  },
  {
    id: "44cd56f1-a526-4c99-8208-4a1459dd9f4f",
    firstName: "Acme",
    lastName: "TeamMember",
    email: "user@acme-enterprise.dev",
  },
  {
    id: "5be5b405-2c21-4bc8-a852-092cef376e71",
    firstName: "Ogheneoruese",
    lastName: "Ophorokpa",
    email: "esetrem@gmail.com",
  },
  {
    id: "7b075575-d37d-4b89-b754-52d61ed67ba3",
    firstName: "Super",
    lastName: "Admin",
    email: "super.admin@bowago.dev",
  },
  {
    id: "806abb58-4e78-4bb8-b6dc-ced2d2e0b7d2",
    firstName: "Acme",
    lastName: "Agent",
    email: "agent@acme-enterprise.dev",
  },
  {
    id: "8849398b-fc73-449a-82c7-f7629fd4f2f1",
    firstName: "OK",
    lastName: "OK",
    email: "app.bowago@gmail.com",
  },
  {
    id: "994a0887-272d-4bb9-af3c-cc9120962ef0",
    firstName: "Acme",
    lastName: "Owner",
    email: "master@acme-enterprise.dev",
  },
  {
    id: "a690deb6-aa8f-4c77-a012-50a47acbed4e",
    firstName: "Acme",
    lastName: "Dispatcher",
    email: "dispatcher@acme-enterprise.dev",
  },
  {
    id: "b12d27fb-2278-4171-a827-ed8a07a5c6aa",
    firstName: "Custom",
    lastName: "Admin",
    email: "role.admin@bowago.dev",
  },
  {
    id: "b2155a4e-00a6-463f-b783-78c6e09f91c0",
    firstName: "Acme",
    lastName: "Finance",
    email: "finance@acme-enterprise.dev",
  },
  {
    id: "c6c96ec0-5bd1-404d-8150-7fe6b782cbae",
    firstName: "Odumade",
    lastName: "Ibukunoluwa Olanrewaju",
    email: "lanreodumade@gmail.com",
  },
  {
    id: "f940dbe6-edd0-42a7-81a3-6d93c5faf036",
    firstName: "technical",
    lastName: "yehgs",
    email: "yehgs.co.uk@gmail.com",
  },
];

// Statuses eligible for the overdue/delay-alert list
const OVERDUE_STATUSES = ["CONFIRMED", "PICKED_UP", "IN_TRANSIT"];

const CITIES = [
  { city: "Abuja", state: "FCT" },
  { city: "Lagos", state: "Lagos" },
  { city: "Port Harcourt", state: "Rivers" },
  { city: "Kano", state: "Kano" },
  { city: "Ibadan", state: "Oyo" },
  { city: "Enugu", state: "Enugu" },
  { city: "Benin City", state: "Edo" },
];

const DELAY_REASONS = [
  "Vehicle breakdown en route",
  "Bad weather along the route corridor",
  "Customs/checkpoint hold-up",
  "High volume backlog at the transit hub",
  "Route diversion due to road closure",
];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateTrackingNumber() {
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `BG-${ymd}-${rand}`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

async function main() {
  console.log(`Seeding overdue shipments for ${USERS.length} users...`);

  let created = 0;

  for (const user of USERS) {
    // 2 overdue shipments per user, with slightly different staleness so
    // the "overdue" list looks realistic (some 1 day late, some a week late).
    const overdueSpecs = [
      { daysLate: randomInt(1, 3), status: randomFrom(OVERDUE_STATUSES) },
      { daysLate: randomInt(4, 9), status: randomFrom(OVERDUE_STATUSES) },
    ];

    for (const spec of overdueSpecs) {
      const origin = randomFrom(CITIES);
      let destination = randomFrom(CITIES);
      while (destination.city === origin.city) destination = randomFrom(CITIES);

      const trackingNumber = generateTrackingNumber();
      const weight = Math.round((Math.random() * 18 + 1) * 10) / 10; // 1–19kg
      const quotedPrice = Math.round((weight * 850 + 1500) / 50) * 50; // rough NGN estimate
      const pickupDate = daysAgo(spec.daysLate + 3);
      const estimatedDelivery = daysAgo(spec.daysLate); // in the past → overdue
      const reason = randomFrom(DELAY_REASONS);

      const shipment = await prisma.shipment.create({
        data: {
          trackingNumber,
          customerId: user.id,

          senderName: "BowaGO Warehouse",
          senderPhone: "+2348000000000",
          senderAddress: `${origin.city} Logistics Hub, Plot 12`,
          senderCity: origin.city,
          senderState: origin.state,

          recipientName: `${user.firstName} ${user.lastName}`.trim(),
          recipientPhone: "+2348011122233",
          recipientAddress: `${destination.city} Delivery Point, 4 Market Rd`,
          recipientCity: destination.city,
          recipientState: destination.state,

          description: "Demo shipment seeded for delay-alert testing",
          weight,
          weightUnit: "KG",
          cartons: 1,

          serviceType: "STANDARD",
          quotedPrice,
          currency: "NGN",

          status: spec.status,
          paymentStatus: "PAID",

          pickupDate,
          estimatedDelivery,

          trackingHistory: {
            create: [
              {
                status: "BOOKED",
                description: "Shipment booked and confirmed",
                updatedBy: user.id,
                createdAt: pickupDate,
              },
              {
                status: spec.status,
                description: `Currently ${spec.status.replace("_", " ").toLowerCase()} — running behind schedule`,
                updatedBy: user.id,
              },
            ],
          },
        },
      });

      // Seed a DelayAlert record too, so it's clear (and query-able) that
      // these are the shipments meant to be used for the delay-alert demo.
      await prisma.delayAlert.upsert({
        where: { shipmentId: shipment.id },
        update: {},
        create: {
          shipmentId: shipment.id,
          reason,
        },
      });

      created++;
      console.log(
        `  ✓ ${trackingNumber}  ${user.email.padEnd(30)}  status=${spec.status}  ETA=${estimatedDelivery.toISOString().slice(0, 10)} (${spec.daysLate}d overdue)`,
      );
    }
  }

  console.log(
    `\nDone. Created ${created} overdue shipments across ${USERS.length} users.`,
  );
  console.log(
    "They will now appear in GET /api/delay-alerts (getDelayedShipments).",
  );
  console.log(
    "Use POST /api/delay-alerts with { shipmentIds, reason, message } to send the delay alert.",
  );
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
