/**
 * migrate-offering-model.js
 *
 * One-off, idempotent data migration for the ShipmentMode / ServiceType /
 * Offering refactor. Run it AFTER `prisma db push` has applied the new schema:
 *
 *   npx prisma db push
 *   node prisma/migrate-offering-model.js            # dry run (default) — prints the plan
 *   node prisma/migrate-offering-model.js --apply    # writes
 *
 * EXPLICIT MIGRATION RULES (documented business decisions — nothing here is
 * inferred silently):
 *
 *  1. DeliverySLA
 *     `db push` adds `shipmentMode` with DEFAULT 'LAND', so every legacy SLA
 *     row (which had no mode) becomes a LAND SLA. LAND was the only mode
 *     operated before the offering model existed. AIR/SEA SLAs are NEVER
 *     invented here — an admin must enter them (or run
 *     `seed-mode-rates.js --bootstrap-sla` and review the result).
 *
 *  2. ServiceOffering
 *     One row is created for each (shipmentMode, serviceType) pair that already
 *     has at least one ACTIVE PriceBand with a real (> 0) price — i.e. evidence
 *     that BowaGO actually sells it. Pairs with no usable rate are NOT created
 *     (so SEA+EXPRESS etc. do not exist unless an admin defines them).
 *     A created offering is switched ON only if a DeliverySLA already exists for
 *     it; otherwise it is created INACTIVE with a note, because an offering
 *     without a delivery promise must not be sellable.
 *
 *  3. ContractRate
 *     - fixed per-kg contracts (fixedPricePerKgByZone) are absolute NGN/kg
 *       figures negotiated when LAND was the only mode  -> shipmentMode = LAND.
 *     - percentage-discount contracts are relative and stay mode = null, which
 *       now means "all modes" EXPLICITLY (shown as such in the admin UI).
 *
 *  4. PromoCode
 *     Existing promos keep shipmentMode = null ("all modes") — same behaviour
 *     as before, now stated explicitly and editable.
 *
 *  5. Historical Quotes / Shipments are never touched: new snapshot columns
 *     are nullable and legacy rows stay readable exactly as they were.
 *
 * The script also prints an audit of things it will NOT change but that an
 * admin should look at (unpriced placeholder bands, zones without SLA, ...).
 */
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const SERVICES = ["EXPRESS", "STANDARD", "ECONOMY"];
const MODES = ["LAND", "AIR", "SEA"];

const MODE_LABEL = { AIR: "Air", LAND: "Land", SEA: "Sea" };
const SERVICE_LABEL = { EXPRESS: "Express", STANDARD: "Standard", ECONOMY: "Economy" };

function bandHasUsablePrice(b) {
  if (b.pricePerKg && b.pricePerKg > 0) return true;
  if (b.basePrice && b.basePrice > 0) return true;
  const fixed = b.fixedPricePerKgByZone;
  if (fixed && typeof fixed === "object") {
    return Object.values(fixed).some((v) => Number(v) > 0);
  }
  return false;
}

async function main() {
  console.log(APPLY ? "MODE: APPLY (writing)\n" : "MODE: DRY RUN (no writes) — pass --apply to write\n");

  const [bands, slas, offerings, contracts, promos] = await Promise.all([
    prisma.priceBand.findMany({ where: { isActive: true } }),
    prisma.deliverySLA.findMany(),
    prisma.serviceOffering.findMany(),
    prisma.contractRate.findMany(),
    prisma.promoCode.count(),
  ]);

  console.log(`Active price bands: ${bands.length} | SLAs: ${slas.length} | offerings: ${offerings.length} | contracts: ${contracts.length} | promos: ${promos}`);

  // ── 1. Offerings ──────────────────────────────────────────────────────────
  const existing = new Set(offerings.map((o) => `${o.shipmentMode}|${o.serviceType}`));
  const slaKeys = new Set(slas.map((s) => `${s.shipmentMode}|${s.serviceType}`));
  const plan = [];
  let sort = 0;
  for (const mode of MODES) {
    for (const service of SERVICES) {
      sort += 1;
      const key = `${mode}|${service}`;
      if (existing.has(key)) continue;
      const pairBands = bands.filter((b) => b.shipmentMode === mode && b.serviceType === service);
      const usable = pairBands.filter(bandHasUsablePrice);
      if (usable.length === 0) continue; // no evidence it is sold — do not fabricate
      const hasSla = slaKeys.has(key);
      plan.push({
        shipmentMode: mode,
        serviceType: service,
        displayName: `${MODE_LABEL[mode]} ${SERVICE_LABEL[service]}`,
        isActive: hasSla,
        sortOrder: sort,
        notes: hasSla
          ? "Created by migrate-offering-model from existing usable rates and SLA."
          : "Created INACTIVE by migrate-offering-model: rates exist but no delivery SLA is configured for this mode/service. Add SLAs, then activate.",
      });
    }
  }

  console.log(`\n[1] Offerings to create: ${plan.length}`);
  for (const p of plan) {
    console.log(`    + ${p.shipmentMode} + ${p.serviceType}  -> ${p.isActive ? "ACTIVE" : "INACTIVE (no SLA)"}`);
  }
  if (APPLY && plan.length) {
    await prisma.serviceOffering.createMany({ data: plan, skipDuplicates: true });
  }

  // ── 2. Contract rates ─────────────────────────────────────────────────────
  const contractFixes = contracts.filter((c) => c.fixedPricePerKgByZone && !c.shipmentMode);
  console.log(`\n[2] Fixed-rate contracts without a mode -> LAND: ${contractFixes.length}`);
  for (const c of contractFixes) console.log(`    ~ contract ${c.id} (user ${c.userId}) -> LAND`);
  if (APPLY && contractFixes.length) {
    await prisma.contractRate.updateMany({
      where: { id: { in: contractFixes.map((c) => c.id) } },
      data: { shipmentMode: "LAND" },
    });
  }
  const pctAll = contracts.filter((c) => !c.fixedPricePerKgByZone && !c.shipmentMode).length;
  console.log(`    (${pctAll} percentage contract(s) remain mode = ALL, now explicit)`);

  // ── 3. Audit (read-only) ──────────────────────────────────────────────────
  console.log("\n[3] AUDIT — not changed by this script, review in the admin UI:");

  const placeholders = bands.filter((b) => !bandHasUsablePrice(b));
  console.log(`    • ${placeholders.length} active price band(s) have NO usable price (0 / empty). They are now ignored by the engine (they previously quoted ₦0).`);

  const fixedMapBands = bands.filter((b) => b.zone == null && b.fixedPricePerKgByZone);
  console.log(`    • ${fixedMapBands.length} fixed-price-by-zone band(s) exist. They now price correctly (they never matched before).`);

  const zonesByOffering = new Map();
  for (const b of bands.filter(bandHasUsablePrice)) {
    const zs = new Set();
    if (b.zone != null) zs.add(b.zone);
    if (b.fixedPricePerKgByZone) for (const z of Object.keys(b.fixedPricePerKgByZone)) zs.add(Number(z));
    const key = `${b.shipmentMode}|${b.serviceType}`;
    if (!zonesByOffering.has(key)) zonesByOffering.set(key, new Set());
    for (const z of zs) zonesByOffering.get(key).add(z);
  }
  for (const [key, zs] of zonesByOffering) {
    const missing = [...zs].filter(
      (z) => !slas.some((s) => `${s.shipmentMode}|${s.serviceType}` === key && s.zone === z),
    );
    if (missing.length) {
      console.log(`    • ${key.replace("|", " + ")}: rates exist for zone(s) ${missing.sort().join(", ")} but NO SLA -> not sellable there until an SLA is added.`);
    }
  }

  const overlaps = [];
  const groups = new Map();
  for (const b of bands.filter(bandHasUsablePrice)) {
    const k = `${b.shipmentMode}|${b.serviceType}|${b.zone ?? "map"}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b);
  }
  for (const [k, list] of groups) {
    list.sort((a, b) => a.minKg - b.minKg);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      const prevMax = prev.maxKg ?? Infinity;
      if (cur.minKg < prevMax) overlaps.push(`${k}: ${prev.minKg}-${prev.maxKg ?? "∞"} overlaps ${cur.minKg}-${cur.maxKg ?? "∞"}`);
    }
  }
  console.log(`    • ${overlaps.length} overlapping weight band pair(s).`);
  overlaps.slice(0, 15).forEach((o) => console.log(`        - ${o}`));

  console.log(APPLY ? "\nDone." : "\nDry run complete. Re-run with --apply to write.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
