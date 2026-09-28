/**
 * seed-mode-rates.js
 *
 * [V1 Feature 1] Every existing PriceBand became `shipmentMode: LAND` by
 * default when the column was added (that's what all pre-V1 rates were,
 * in practice). But AIR and SEA now have zero bands of their own, so any
 * quote requesting those modes 404s with "Rate not found for AIR/SEA"
 * until an admin creates real ones.
 *
 * This script seeds a starter set of AIR and SEA bands by cloning every
 * active LAND band and applying a multiplier — AIR costs more (faster),
 * SEA costs less (slower). THESE ARE PLACEHOLDER RATIOS, not real pricing —
 * an admin should review and correct them via the Rate Management UI
 * (or POST /pricing/price-bands with shipmentMode) before relying on them
 * for real quotes. This just gets the platform off the ground for AIR/SEA
 * instead of hard-404ing on day one.
 *
 * Idempotent: skips a (zone, serviceType, minKg, maxKg, mode) combination
 * that already has a band, so it's safe to re-run after an admin has
 * started editing real AIR/SEA rates.
 *
 * Usage:
 *   node prisma/seed-mode-rates.js
 *   node prisma/seed-mode-rates.js --dry-run
 *   node prisma/seed-mode-rates.js --air-multiplier=3 --sea-multiplier=0.6
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes("--dry-run");

function argNumber(flag, fallback) {
  const found = process.argv.find((a) => a.startsWith(`--${flag}=`));
  if (!found) return fallback;
  const val = parseFloat(found.split("=")[1]);
  return Number.isNaN(val) ? fallback : val;
}

// Typical real-world ratios relative to land freight — placeholders only.
const AIR_MULTIPLIER = argNumber("air-multiplier", 2.5);
const SEA_MULTIPLIER = argNumber("sea-multiplier", 0.6);

async function main() {
  const landBands = await prisma.priceBand.findMany({
    where: { shipmentMode: "LAND", isActive: true },
  });

  if (landBands.length === 0) {
    console.log("No active LAND price bands found — nothing to clone from.");
    return;
  }

  console.log(`Found ${landBands.length} active LAND band(s).`);
  console.log(`AIR multiplier: ${AIR_MULTIPLIER}x, SEA multiplier: ${SEA_MULTIPLIER}x`);
  if (DRY_RUN) console.log("(dry run — no writes will be made)\n");

  const plan = [];
  for (const band of landBands) {
    for (const [mode, multiplier] of [["AIR", AIR_MULTIPLIER], ["SEA", SEA_MULTIPLIER]]) {
      const existing = await prisma.priceBand.findFirst({
        where: {
          shipmentMode: mode,
          zone: band.zone,
          serviceType: band.serviceType,
          minKg: band.minKg,
          maxKg: band.maxKg,
        },
      });
      if (existing) continue; // already has a band for this slot — leave it alone

      plan.push({
        label: band.label ? `${band.label} (${mode})` : null,
        zone: band.zone,
        pricePerKg: band.pricePerKg != null ? Math.round(band.pricePerKg * multiplier * 100) / 100 : null,
        basePrice: band.basePrice != null ? Math.round(band.basePrice * multiplier * 100) / 100 : null,
        fixedPricePerKgByZone: band.fixedPricePerKgByZone
          ? Object.fromEntries(
              Object.entries(band.fixedPricePerKgByZone).map(([z, price]) => [
                z,
                Math.round(Number(price) * multiplier * 100) / 100,
              ]),
            )
          : null,
        minKg: band.minKg,
        maxKg: band.maxKg,
        minTons: band.minTons,
        maxTons: band.maxTons,
        minCartons: band.minCartons,
        maxCartons: band.maxCartons,
        discountPercent: band.discountPercent,
        serviceType: band.serviceType,
        shipmentMode: mode,
        validFrom: band.validFrom,
        validUntil: band.validUntil,
        notes: `Auto-seeded from LAND band ${band.id} at ${multiplier}x — review and correct.`,
        isActive: true,
        createdBy: null,
      });
    }
  }

  if (plan.length === 0) {
    console.log("Nothing to seed — every LAND band already has AIR/SEA equivalents.");
    return;
  }

  console.log(`Will create ${plan.length} new band(s):`);
  for (const p of plan) {
    console.log(
      `  [${p.shipmentMode}] zone=${p.zone ?? "multi"} ${p.serviceType} ${p.minKg}-${p.maxKg ?? "∞"}kg → ` +
        `pricePerKg=${p.pricePerKg ?? "—"} basePrice=${p.basePrice ?? "—"}`,
    );
  }

  if (DRY_RUN) {
    console.log("\nDry run — no rows created.");
    return;
  }

  await prisma.priceBand.createMany({ data: plan });
  console.log(`\nDone — created ${plan.length} band(s). Review them in Rate Management before going live.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
