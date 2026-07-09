/**
 * fill-missing-routes.js
 *
 * Every city should have a zone + distance entry to every OTHER city (no
 * self-routes). This audits the current database for gaps and, where
 * possible, auto-fills them using the REVERSE direction as the source of
 * truth (e.g. if Aba→Lagos = zone 3 but Lagos→Aba is missing, this fills
 * Lagos→Aba = zone 3). That's the safe assumption here — the source
 * spreadsheet's Zone Matrix sheet had 78 missing cells out of 1560, and the
 * likely cause (per the shape of the gaps) is a handful of cells that
 * just never got typed in, not that those routes are meant to price
 * differently in each direction.
 *
 * Anything with NO entry in either direction cannot be safely guessed —
 * those are reported at the end so you can fill them in manually (either
 * directly in the DB, via the app's pricing import, or through
 * /dashboard/rate/zones).
 *
 * Safe to re-run.
 *
 * Usage:
 *   node prisma/fill-missing-routes.js
 *   node prisma/fill-missing-routes.js --dry-run    (report only, no writes)
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  console.log(`\nAuditing route coverage${DRY_RUN ? " (DRY RUN — no writes)" : ""}...\n`);

  const cities = await prisma.city.findMany({ select: { id: true, name: true } });
  const [zoneEntries, kmEntries] = await Promise.all([
    prisma.zoneMatrix.findMany({ select: { fromCityId: true, toCityId: true, zone: true } }),
    prisma.kmMatrix.findMany({ select: { fromCityId: true, toCityId: true, distanceKm: true } }),
  ]);

  const zoneByPair = new Map(zoneEntries.map((z) => [`${z.fromCityId}|${z.toCityId}`, z.zone]));
  const kmByPair = new Map(kmEntries.map((k) => [`${k.fromCityId}|${k.toCityId}`, k.distanceKm]));

  const expectedPairs = cities.length * cities.length; // every city → every other city, INCLUDING same-city (local/intra-city delivery)
  console.log(`Cities: ${cities.length}  |  Expected pairs: ${expectedPairs}`);
  console.log(`Zone Matrix: ${zoneEntries.length} configured (${expectedPairs - zoneEntries.length} missing)`);
  console.log(`Matrix by KM: ${kmEntries.length} configured (${expectedPairs - kmEntries.length} missing)\n`);

  let zoneFilled = 0;
  let kmFilled = 0;
  const unfixableZone = [];
  const unfixableKm = [];

  for (const from of cities) {
    for (const to of cities) {
      const key = `${from.id}|${to.id}`;
      const reverseKey = `${to.id}|${from.id}`;
      const isSameCity = from.id === to.id;

      // ── Zone gap ──
      if (!zoneByPair.has(key)) {
        // Same-city has no "other direction" to borrow from — it needs an
        // explicit local-delivery rate set deliberately, not guessed.
        const reverseZone = isSameCity ? undefined : zoneByPair.get(reverseKey);
        if (reverseZone !== undefined) {
          if (!DRY_RUN) {
            await prisma.zoneMatrix.create({
              data: { fromCityId: from.id, toCityId: to.id, zone: reverseZone },
            });
          }
          zoneByPair.set(key, reverseZone); // so this run's own fills count as "known" for symmetry checks below
          zoneFilled++;
        } else {
          unfixableZone.push(isSameCity ? `${from.name} (local delivery)` : `${from.name} → ${to.name}`);
        }
      }

      // ── KM gap ──
      if (!kmByPair.has(key)) {
        const reverseKm = isSameCity ? undefined : kmByPair.get(reverseKey);
        if (reverseKm !== undefined) {
          if (!DRY_RUN) {
            await prisma.kmMatrix.create({
              data: { fromCityId: from.id, toCityId: to.id, distanceKm: reverseKm },
            });
          }
          kmByPair.set(key, reverseKm);
          kmFilled++;
        } else if (isSameCity) {
          // Distance for a same-city route defaults to 0 — it's a safe,
          // unambiguous default (unlike zone/price, which need a real
          // business decision), so this one auto-fills even with no
          // reverse to borrow from.
          if (!DRY_RUN) {
            await prisma.kmMatrix.create({
              data: { fromCityId: from.id, toCityId: to.id, distanceKm: 0 },
            });
          }
          kmByPair.set(key, 0);
          kmFilled++;
        } else {
          unfixableKm.push(`${from.name} → ${to.name}`);
        }
      }
    }
  }

  console.log(`✓ ${DRY_RUN ? "Would fill" : "Filled"} ${zoneFilled} zone gap(s) from the reverse direction`);
  console.log(`✓ ${DRY_RUN ? "Would fill" : "Filled"} ${kmFilled} distance gap(s) from the reverse direction\n`);

  if (unfixableZone.length > 0) {
    console.log(`⚠ ${unfixableZone.length} zone pair(s) have NO entry in either direction — fill manually:`);
    unfixableZone.forEach((pair) => console.log(`    ${pair}`));
    console.log();
  }
  if (unfixableKm.length > 0) {
    console.log(`⚠ ${unfixableKm.length} distance pair(s) have NO entry in either direction — fill manually:`);
    unfixableKm.forEach((pair) => console.log(`    ${pair}`));
    console.log();
  }

  if (unfixableZone.length === 0 && unfixableKm.length === 0) {
    console.log("Every city pair now has full coverage. Nothing left to fill manually.\n");
  } else {
    console.log(
      "For the pairs above: add them via /dashboard/rate/zones (Zone Matrix) and " +
      "/dashboard/rate (KM Matrix import), or re-export the pricing sheet — the " +
      "\"Coverage Gaps\" tab now lists exactly these pairs.\n",
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
