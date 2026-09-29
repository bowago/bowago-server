/**
 * seed-delivery-sla-air-sea.js — realistic, hand-picked Delivery SLA values
 * for AIR and SEA, matching the day ranges already configured for LAND
 * (Admin > Rates > Delivery SLA screenshot: Zone 1-4 × Express/Standard/Economy).
 *
 * This is NOT a multiplier bootstrap (see seed-mode-rates.js --bootstrap-sla
 * for that) — the day ranges below are explicit, reviewed numbers, the same
 * way an ops team would actually set them:
 *
 *   AIR  is faster than LAND at every zone, EXPRESS + STANDARD only.
 *   SEA  is slower than LAND at every zone, STANDARD + ECONOMY only.
 *
 * AIR+ECONOMY and SEA+EXPRESS are intentionally left NULL/unset — they are
 * not products BowaGO operates (mirrors the OPERATED convention in
 * seed-mode-rates.js). This script never invents an SLA for a combination
 * that has no ServiceOffering: exactly like the real admin endpoint
 * (PUT /pricing/delivery-sla), a row is only written once the offering it
 * belongs to already exists, so "no offering yet" always wins over "we have
 * a nice day range for it" — an SLA for a product that isn't sold would be
 * dead configuration.
 *
 * Usage:
 *   node prisma/seed-delivery-sla-air-sea.js            # dry run (default)
 *   node prisma/seed-delivery-sla-air-sea.js --apply
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const APPLY = process.argv.includes("--apply");

const MODE_LABEL = { AIR: "Air", LAND: "Land", SEA: "Sea" };

// Explicit day ranges per zone. Reviewed numbers, not derived from LAND by a
// multiplier — pattern mirrors the LAND table already live in Admin > Rates
// > Delivery SLA (Zone 1 = same state/nearby ... Zone 4 = far/remote).
//
//   AIR:  Zone 1 same-day/next-day Express, scaling out to a few days by
//         Zone 4 — still the fastest option at every zone.
//   SEA:  Zone 1 starts where LAND's slowest zone ends, scaling out to
//         several weeks by Zone 4 — always the slowest option.
// EXPRESS is absent from SEA and ECONOMY is absent from AIR: those are not
// products this platform sells (a SEA+EXPRESS or AIR+ECONOMY offering does
// not exist), so there is nothing to seed for them — left nullable/skipped,
// not zero-filled.
const SLA_TABLE = {
  AIR: {
    EXPRESS: {
      1: [0, 1], // "Same day – next day"
      2: [1, 1],
      3: [1, 2],
      4: [2, 3],
    },
    STANDARD: {
      1: [1, 1],
      2: [1, 2],
      3: [2, 3],
      4: [3, 4],
    },
    // ECONOMY: not offered on AIR — intentionally absent.
  },
  SEA: {
    STANDARD: {
      1: [3, 5],
      2: [5, 8],
      3: [8, 12],
      4: [12, 18],
    },
    ECONOMY: {
      1: [5, 8],
      2: [8, 12],
      3: [12, 18],
      4: [18, 25],
    },
    // EXPRESS: not offered on SEA — intentionally absent. This is the
    // "especially sea" nullable case: SEA+EXPRESS has no ServiceOffering,
    // so it is skipped below rather than seeded with an invented range.
  },
};

const label = (min, max) =>
  min === max
    ? `${min === 0 ? "Same day" : `${min} business day${min === 1 ? "" : "s"}`}`
    : min === 0
      ? `Same day – ${max} business day${max === 1 ? "" : "s"}`
      : `${min}–${max} business days`;

async function main() {
  const offerings = await prisma.serviceOffering.findMany({
    select: { shipmentMode: true, serviceType: true },
  });
  const isOffered = (mode, service) =>
    offerings.some((o) => o.shipmentMode === mode && o.serviceType === service);

  const plan = [];
  const skippedNoOffering = [];

  for (const mode of ["AIR", "SEA"]) {
    for (const [service, byZone] of Object.entries(SLA_TABLE[mode])) {
      if (!isOffered(mode, service)) {
        // Exactly the real upsertSLA rule: no ServiceOffering, no SLA row.
        // This is where SEA+EXPRESS (and any other undefined combo) drops
        // out — nullable by design, never guessed.
        skippedNoOffering.push(`${mode} + ${service}`);
        continue;
      }
      for (const [zoneStr, [minDays, maxDays]] of Object.entries(byZone)) {
        plan.push({
          zone: Number(zoneStr),
          shipmentMode: mode,
          serviceType: service,
          minDays,
          maxDays,
          label: label(minDays, maxDays),
        });
      }
    }
  }

  console.log(`Delivery SLA rows to upsert: ${plan.length}\n`);
  const byMode = { AIR: plan.filter((p) => p.shipmentMode === "AIR"), SEA: plan.filter((p) => p.shipmentMode === "SEA") };
  for (const mode of ["AIR", "SEA"]) {
    console.log(`${MODE_LABEL[mode]}:`);
    for (const row of byMode[mode]) {
      console.log(`  Zone ${row.zone} ${row.serviceType.padEnd(8)} ${row.label}`);
    }
    console.log("");
  }

  if (skippedNoOffering.length) {
    console.log("Skipped (no ServiceOffering defined yet — nothing to seed):");
    for (const combo of [...new Set(skippedNoOffering)]) console.log(`  - ${combo}`);
    console.log("");
  }

  if (!APPLY) {
    console.log("Dry run complete. Re-run with --apply to write these rows.");
    return;
  }

  for (const row of plan) {
    await prisma.deliverySLA.upsert({
      where: { zone_shipmentMode_serviceType: { zone: row.zone, shipmentMode: row.shipmentMode, serviceType: row.serviceType } },
      update: { minDays: row.minDays, maxDays: row.maxDays, label: row.label },
      create: row,
    });
  }
  console.log(`Done — ${plan.length} row(s) upserted. Review in Admin > Rates > Delivery SLA.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
