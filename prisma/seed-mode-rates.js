/**
 * seed-mode-rates.js  —  BOOTSTRAP data for AIR / SEA offerings.
 *
 * Multipliers are allowed here (and only here): production pricing is managed
 * independently per mode / service / zone / weight band in Rate Management.
 * Everything this script creates is a STARTING POINT for an admin to review.
 *
 * What changed vs the old script:
 *   - It no longer clones a LAND band into every service of every mode. Only
 *     combinations BowaGO actually operates (OPERATED below, editable) are
 *     defined as offerings, so e.g. SEA + EXPRESS never comes into existence.
 *   - Cloned bands are created INACTIVE unless --activate is passed, so a
 *     placeholder multiplier can never silently become a live price.
 *   - Placeholder (₦0) source bands are skipped.
 *   - SLAs are optional (--bootstrap-sla) and derived from the LAND SLA of the
 *     same zone+service using explicit day scales; they are ordinary SLA rows
 *     in the admin UI and must be reviewed.
 *
 * Usage:
 *   node prisma/seed-mode-rates.js                       # dry run (default)
 *   node prisma/seed-mode-rates.js --apply
 *   node prisma/seed-mode-rates.js --apply --activate --bootstrap-sla
 *   node prisma/seed-mode-rates.js --apply --air-multiplier=3 --sea-multiplier=0.6
 *   node prisma/seed-mode-rates.js --apply --air-days=0.5 --sea-days=2.5
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const APPLY = process.argv.includes("--apply");
const ACTIVATE = process.argv.includes("--activate");
const BOOTSTRAP_SLA = process.argv.includes("--bootstrap-sla");

function argNumber(flag, fallback) {
  const found = process.argv.find((a) => a.startsWith(`--${flag}=`));
  if (!found) return fallback;
  const val = parseFloat(found.split("=")[1]);
  return Number.isNaN(val) ? fallback : val;
}

// Bootstrap ratios relative to LAND. Placeholders — an admin sets real values.
const RATE_MULTIPLIER = { AIR: argNumber("air-multiplier", 2.5), SEA: argNumber("sea-multiplier", 0.6) };
const DAY_SCALE = { AIR: argNumber("air-days", 0.5), SEA: argNumber("sea-days", 2.5) };

// The products BowaGO operates. NOT every mode x service pair — edit to match
// the business. This script only bootstraps rates/SLAs for the non-LAND ones.
const OPERATED = [
  { mode: "AIR", service: "EXPRESS" },
  { mode: "AIR", service: "STANDARD" },
  { mode: "LAND", service: "EXPRESS" },
  { mode: "LAND", service: "STANDARD" },
  { mode: "LAND", service: "ECONOMY" },
  { mode: "SEA", service: "STANDARD" },
  { mode: "SEA", service: "ECONOMY" },
];

const MODE_LABEL = { AIR: "Air", LAND: "Land", SEA: "Sea" };
const SERVICE_LABEL = { EXPRESS: "Express", STANDARD: "Standard", ECONOMY: "Economy" };

const usable = (b) =>
  (b.pricePerKg && b.pricePerKg > 0) ||
  (b.basePrice && b.basePrice > 0) ||
  (b.fixedPricePerKgByZone && Object.values(b.fixedPricePerKgByZone).some((v) => Number(v) > 0));

const round2 = (n) => Math.round(n * 100) / 100;

async function main() {
  console.log(APPLY ? "MODE: APPLY\n" : "MODE: DRY RUN — pass --apply to write\n");

  // 1. Offerings
  const existingOfferings = await prisma.serviceOffering.findMany();
  const have = new Set(existingOfferings.map((o) => `${o.shipmentMode}|${o.serviceType}`));
  const newOfferings = OPERATED.filter((o) => !have.has(`${o.mode}|${o.service}`)).map((o, i) => ({
    shipmentMode: o.mode,
    serviceType: o.service,
    displayName: `${MODE_LABEL[o.mode]} ${SERVICE_LABEL[o.service]}`,
    // Inactive until rates + SLA are reviewed; the admin activates it.
    isActive: false,
    sortOrder: 100 + i,
    notes: "Bootstrapped by seed-mode-rates — review rates and SLA, then activate.",
  }));
  console.log(`Offerings to define: ${newOfferings.length}`);
  newOfferings.forEach((o) => console.log(`  + ${o.shipmentMode} + ${o.serviceType} (inactive)`));
  if (APPLY && newOfferings.length) {
    await prisma.serviceOffering.createMany({ data: newOfferings, skipDuplicates: true });
  }

  // 2. Bands cloned from LAND for defined non-LAND offerings
  const landBands = await prisma.priceBand.findMany({ where: { shipmentMode: "LAND", isActive: true } });
  const sourceBands = landBands.filter(usable);
  console.log(`\nUsable active LAND bands: ${sourceBands.length} (skipped ${landBands.length - sourceBands.length} unpriced)`);

  const bandPlan = [];
  for (const { mode, service } of OPERATED.filter((o) => o.mode !== "LAND")) {
    const mult = RATE_MULTIPLIER[mode];
    for (const band of sourceBands.filter((b) => b.serviceType === service)) {
      const exists = await prisma.priceBand.findFirst({
        where: { shipmentMode: mode, serviceType: service, zone: band.zone, minKg: band.minKg, maxKg: band.maxKg },
      });
      if (exists) continue;
      bandPlan.push({
        label: band.label ? `${band.label} (${mode})` : null,
        zone: band.zone,
        pricePerKg: band.pricePerKg != null ? round2(band.pricePerKg * mult) : null,
        basePrice: band.basePrice != null ? round2(band.basePrice * mult) : null,
        fixedPricePerKgByZone: band.fixedPricePerKgByZone
          ? Object.fromEntries(Object.entries(band.fixedPricePerKgByZone).map(([z, p]) => [z, round2(Number(p) * mult)]))
          : null,
        minKg: band.minKg,
        maxKg: band.maxKg,
        minTons: band.minTons,
        maxTons: band.maxTons,
        minCartons: band.minCartons,
        maxCartons: band.maxCartons,
        serviceType: service,
        shipmentMode: mode,
        validFrom: band.validFrom,
        validUntil: band.validUntil,
        notes: `BOOTSTRAP: ${mult}x LAND band ${band.id}. Review and correct before relying on it.`,
        isActive: ACTIVATE,
      });
    }
  }
  console.log(`Bands to create: ${bandPlan.length} (${ACTIVATE ? "ACTIVE" : "inactive"})`);
  if (APPLY && bandPlan.length) await prisma.priceBand.createMany({ data: bandPlan });

  // 3. SLAs (optional)
  if (BOOTSTRAP_SLA) {
    const landSlas = await prisma.deliverySLA.findMany({ where: { shipmentMode: "LAND" } });
    const slaPlan = [];
    for (const { mode, service } of OPERATED.filter((o) => o.mode !== "LAND")) {
      const scale = DAY_SCALE[mode];
      for (const l of landSlas.filter((s) => s.serviceType === service)) {
        const exists = await prisma.deliverySLA.findFirst({
          where: { zone: l.zone, shipmentMode: mode, serviceType: service },
        });
        if (exists) continue;
        const minDays = Math.max(1, Math.round(l.minDays * scale));
        const maxDays = Math.max(minDays, Math.ceil(l.maxDays * scale));
        slaPlan.push({
          zone: l.zone,
          shipmentMode: mode,
          serviceType: service,
          minDays,
          maxDays,
          label: minDays === maxDays ? `${minDays} business day${minDays === 1 ? "" : "s"}` : `${minDays}–${maxDays} business days`,
        });
      }
    }
    console.log(`\nSLAs to create (bootstrap, x${DAY_SCALE.AIR} air / x${DAY_SCALE.SEA} sea of LAND): ${slaPlan.length}`);
    slaPlan.slice(0, 20).forEach((s) => console.log(`  + zone ${s.zone} ${s.shipmentMode} ${s.serviceType}: ${s.label}`));
    if (APPLY && slaPlan.length) await prisma.deliverySLA.createMany({ data: slaPlan, skipDuplicates: true });
  } else {
    console.log("\n(SLAs not bootstrapped — pass --bootstrap-sla, or enter AIR/SEA SLAs in Admin > Rates > Delivery SLA)");
  }

  console.log(APPLY ? "\nDone. Review everything in Admin > Rates before activating offerings." : "\nDry run complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
