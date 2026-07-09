/**
 * seed-reference-data.js
 *
 * Imports your exported rating-engine + reference data into the fresh
 * database. Safe to re-run — everything is upserted, not blindly inserted.
 *
 * SETUP:
 *   1. Create a folder `prisma/import-data/` in the backend project.
 *   2. Drop these files into it (exact names, or edit FILES below):
 *        - BowaGO-Pricing-Export.xlsx   (sheets: Cities, Zone Matrix, Matrix by KM, Price Bands, Dimensions)
 *        - surcharges.csv
 *        - faq_items.csv
 *        - delivery_sla.csv
 *        - app_settings.csv
 *      Any file that's missing is skipped with a warning — you don't need
 *      all five to run this.
 *
 * USAGE:
 *   node prisma/seed-reference-data.js
 */
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const DATA_DIR = path.join(__dirname, "import-data");
const FILES = {
  pricingWorkbook: "BowaGO-Pricing-Export.xlsx",
  surcharges: "surcharges.csv",
  faqItems: "faq_items.csv",
  deliverySla: "delivery_sla.csv",
  appSettings: "app_settings.csv",
};

function filePath(name) {
  return path.join(DATA_DIR, name);
}

function exists(name) {
  return fs.existsSync(filePath(name));
}

/** Reads a CSV or a single sheet of an xlsx as an array of row objects,
 *  using the first row as headers. Handles quoted fields correctly via
 *  SheetJS (works for both .csv and .xlsx).
 *  IMPORTANT: reads as a buffer with codepage:65001 (UTF-8) explicitly —
 *  XLSX.readFile()'s default CSV path mis-decodes UTF-8 multi-byte
 *  characters (e.g. "5–10 business days" becomes "5â€"10 business days"),
 *  which silently corrupts any label/description with an en-dash, curly
 *  quote, or ₦ sign. */
function readSheetAsObjects(fileOrWorkbookPath, sheetName = null) {
  const buf = fs.readFileSync(fileOrWorkbookPath);
  const wb = XLSX.read(buf, { type: "buffer", codepage: 65001, raw: true });
  const sheet = sheetName ? wb.Sheets[sheetName] : wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found in ${fileOrWorkbookPath}`);
  return XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });
}

/** Reads a matrix-style sheet into an array of { from, to, value } triples,
 *  skipping only genuinely blank cells. Same-city pairs (e.g. Lagos → Lagos,
 *  intra-city delivery) are kept — that's a legitimate configurable route,
 *  not a diagonal to discard. `fromCityCol` is the 0-indexed column
 *  containing the "from city" name — Zone Matrix has an extra leading
 *  "Region" column (fromCityCol=1), Matrix by KM does not (fromCityCol=0).
 *  City columns always start immediately after it. */
function readMatrixSheet(wbPath, sheetName, fromCityCol = 0) {
  const buf = fs.readFileSync(wbPath);
  const wb = XLSX.read(buf, { type: "buffer", codepage: 65001, raw: true });
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
  const header = rows[0];
  const cityCols = header.slice(fromCityCol + 1); // city names start right after the from-city column
  const triples = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;
    const fromCity = row[fromCityCol];
    if (!fromCity) continue;
    for (let c = 0; c < cityCols.length; c++) {
      const toCity = cityCols[c];
      const value = row[fromCityCol + 1 + c];
      // Same-city pairs (e.g. Lagos → Lagos) are a legitimate route — local/
      // intra-city delivery — not skipped. Only skip a cell that's actually
      // blank in the source sheet.
      if (value === null || value === undefined || value === "") continue;
      triples.push({ from: fromCity, to: toCity, value });
    }
  }
  return triples;
}

function toBool(v) {
  if (typeof v === "boolean") return v;
  if (v === null || v === undefined) return false;
  return String(v).trim().toUpperCase() === "TRUE" || v === "1" || v === 1;
}

function toNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

async function importCitiesAndMatrices(wbPath) {
  console.log("\n── Cities ──────────────────────────────────────────────");
  const cityRows = readSheetAsObjects(wbPath, "Cities");
  const cityIdByName = {};
  for (const row of cityRows) {
    const name = row.Name || row.name;
    if (!name) continue;
    const city = await prisma.city.upsert({
      where: { name },
      update: { region: row.Region ?? row.region, state: row.State ?? row.state },
      create: { name, region: row.Region ?? row.region ?? "", state: row.State ?? row.state ?? "" },
    });
    cityIdByName[name] = city.id;
  }
  console.log(`  ✓ ${Object.keys(cityIdByName).length} cities upserted`);

  console.log("\n── Zone Matrix ─────────────────────────────────────────");
  const zoneTriples = readMatrixSheet(wbPath, "Zone Matrix", 1);
  let zoneCount = 0, zoneSkipped = 0;
  for (const { from, to, value } of zoneTriples) {
    const fromCityId = cityIdByName[from];
    const toCityId = cityIdByName[to];
    if (!fromCityId || !toCityId) { zoneSkipped++; continue; }
    await prisma.zoneMatrix.upsert({
      where: { fromCityId_toCityId: { fromCityId, toCityId } },
      update: { zone: Number(value) },
      create: { fromCityId, toCityId, zone: Number(value) },
    });
    zoneCount++;
  }
  console.log(`  ✓ ${zoneCount} zone-matrix pairs upserted${zoneSkipped ? ` (${zoneSkipped} skipped — city name not found)` : ""}`);

  console.log("\n── KM Matrix ───────────────────────────────────────────");
  const kmTriples = readMatrixSheet(wbPath, "Matrix by KM", 0);
  let kmCount = 0, kmSkipped = 0;
  for (const { from, to, value } of kmTriples) {
    const fromCityId = cityIdByName[from];
    const toCityId = cityIdByName[to];
    if (!fromCityId || !toCityId) { kmSkipped++; continue; }
    await prisma.kmMatrix.upsert({
      where: { fromCityId_toCityId: { fromCityId, toCityId } },
      update: { distanceKm: Number(value) },
      create: { fromCityId, toCityId, distanceKm: Number(value) },
    });
    kmCount++;
  }
  console.log(`  ✓ ${kmCount} km-matrix pairs upserted${kmSkipped ? ` (${kmSkipped} skipped — city name not found)` : ""}`);
}

async function importPriceBands(wbPath) {
  console.log("\n── Price Bands ─────────────────────────────────────────");
  const rows = readSheetAsObjects(wbPath, "Price Bands");
  let count = 0;
  for (const row of rows) {
    const zone = toNum(row["Zone"]);
    const minKg = toNum(row["Min Kg"]) ?? 0;
    const maxKg = toNum(row["Max Kg"]);
    const serviceType = String(row["Service Type"] || "STANDARD").toUpperCase();
    const pricePerKg = toNum(row["Price Per Kg (NGN)"]);
    const basePrice = toNum(row["Base Price (NGN)"]);
    const isActive = row["Active"] === undefined ? true : toBool(row["Active"]);
    const notes = row["Notes"] || null;

    // No natural unique key on PriceBand — match on the combination that
    // defines a band to avoid duplicate rows on re-run.
    const existing = await prisma.priceBand.findFirst({
      where: { zone, minKg, maxKg, serviceType },
    });
    if (existing) {
      await prisma.priceBand.update({
        where: { id: existing.id },
        data: { pricePerKg, basePrice, isActive, notes },
      });
    } else {
      await prisma.priceBand.create({
        data: { zone, minKg, maxKg, serviceType, pricePerKg, basePrice, isActive, notes },
      });
    }
    count++;
  }
  console.log(`  ✓ ${count} price bands upserted`);
}

async function importBoxDimensions(wbPath) {
  console.log("\n── Box Dimensions ──────────────────────────────────────");
  // This sheet was pasted as raw CSV text inside a single column, so read
  // it as raw rows and split manually rather than as objects.
  const buf = fs.readFileSync(wbPath);
  const wb = XLSX.read(buf, { type: "buffer", codepage: 65001, raw: true });
  const sheet = wb.Sheets["Dimensions"];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
  let count = 0;
  for (let i = 1; i < rows.length; i++) {
    const raw = rows[i]?.[0];
    if (!raw) continue;
    const [categoryId, displayName, lengthCm, widthCm, heightCm, bestFor, weightKgLimit] =
      String(raw).split(",");
    if (!categoryId) continue;
    await prisma.boxDimension.upsert({
      where: { categoryId },
      update: {
        displayName, lengthCm: toNum(lengthCm), widthCm: toNum(widthCm),
        heightCm: toNum(heightCm), bestFor, weightKgLimit: toNum(weightKgLimit),
      },
      create: {
        categoryId, displayName, lengthCm: toNum(lengthCm), widthCm: toNum(widthCm),
        heightCm: toNum(heightCm), bestFor, weightKgLimit: toNum(weightKgLimit),
      },
    });
    count++;
  }
  console.log(`  ✓ ${count} box dimensions upserted`);
}

async function importSurcharges() {
  console.log("\n── Surcharges ──────────────────────────────────────────");
  const rows = readSheetAsObjects(filePath(FILES.surcharges));
  let count = 0;
  for (const row of rows) {
    const data = {
      type: row.type,
      label: row.label,
      description: row.description || null,
      ratePercent: toNum(row.ratePercent),
      flatAmount: toNum(row.flatAmount),
      isActive: toBool(row.isActive),
      appliesTo: row.appliesTo || null,
    };
    // Match on type+label to avoid duplicates on re-run (old ids won't
    // exist in the fresh DB, so we don't try to preserve them).
    const existing = await prisma.surcharge.findFirst({
      where: { type: data.type, label: data.label },
    });
    if (existing) {
      await prisma.surcharge.update({ where: { id: existing.id }, data });
    } else {
      await prisma.surcharge.create({ data });
    }
    count++;
  }
  console.log(`  ✓ ${count} surcharges upserted`);
}

async function importFaqItems(validUserIds) {
  console.log("\n── FAQ Items ───────────────────────────────────────────");
  const rows = readSheetAsObjects(filePath(FILES.faqItems));
  let count = 0;
  for (const row of rows) {
    // createdBy pointed at a user in the old DB — that user doesn't exist
    // here, so null it out rather than violate the FK (there's no FK
    // constraint on this field, but keeping stale ids around is confusing).
    const createdBy = row.createdBy && validUserIds.has(row.createdBy) ? row.createdBy : null;
    const data = {
      question: row.question,
      answer: row.answer,
      category: row.category,
      sortOrder: toNum(row.sortOrder) ?? 0,
      isActive: toBool(row.isActive),
      isFeatured: toBool(row.isFeatured),
      createdBy,
    };
    const existing = await prisma.faqItem.findFirst({ where: { question: data.question } });
    if (existing) {
      await prisma.faqItem.update({ where: { id: existing.id }, data });
    } else {
      await prisma.faqItem.create({ data });
    }
    count++;
  }
  console.log(`  ✓ ${count} FAQ items upserted`);
}

async function importDeliverySla() {
  console.log("\n── Delivery SLA ────────────────────────────────────────");
  const rows = readSheetAsObjects(filePath(FILES.deliverySla));
  let count = 0;
  for (const row of rows) {
    const zone = toNum(row.zone);
    const serviceType = row.serviceType;
    await prisma.deliverySLA.upsert({
      where: { zone_serviceType: { zone, serviceType } },
      update: {
        minDays: toNum(row.minDays),
        maxDays: toNum(row.maxDays),
        label: row.label || null,
      },
      create: {
        zone,
        serviceType,
        minDays: toNum(row.minDays),
        maxDays: toNum(row.maxDays),
        label: row.label || null,
      },
    });
    count++;
  }
  console.log(`  ✓ ${count} delivery SLA rows upserted`);
}

async function importAppSettings() {
  console.log("\n── App Settings ────────────────────────────────────────");
  const rows = readSheetAsObjects(filePath(FILES.appSettings));
  let count = 0;
  for (const row of rows) {
    await prisma.appSettings.upsert({
      where: { key: row.key },
      update: { value: String(row.value), type: row.type || "string", group: row.group || null },
      create: { key: row.key, value: String(row.value), type: row.type || "string", group: row.group || null },
    });
    count++;
  }
  console.log(`  ✓ ${count} app settings upserted`);
}

async function main() {
  console.log(`Reading import files from: ${DATA_DIR}\n`);
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`Folder not found: ${DATA_DIR}\nCreate it and drop your export files in there first.`);
    process.exit(1);
  }

  if (exists(FILES.pricingWorkbook)) {
    const wbPath = filePath(FILES.pricingWorkbook);
    await importCitiesAndMatrices(wbPath);
    await importPriceBands(wbPath);
    await importBoxDimensions(wbPath);
  } else {
    console.log(`⚠ Skipping cities/matrices/price-bands/box-dimensions — ${FILES.pricingWorkbook} not found`);
  }

  if (exists(FILES.surcharges)) {
    await importSurcharges();
  } else {
    console.log(`⚠ Skipping surcharges — ${FILES.surcharges} not found`);
  }

  if (exists(FILES.deliverySla)) {
    await importDeliverySla();
  } else {
    console.log(`⚠ Skipping delivery SLA — ${FILES.deliverySla} not found`);
  }

  if (exists(FILES.appSettings)) {
    await importAppSettings();
  } else {
    console.log(`⚠ Skipping app settings — ${FILES.appSettings} not found`);
  }

  if (exists(FILES.faqItems)) {
    const allUsers = await prisma.user.findMany({ select: { id: true } });
    const validUserIds = new Set(allUsers.map((u) => u.id));
    await importFaqItems(validUserIds);
  } else {
    console.log(`⚠ Skipping FAQ items — ${FILES.faqItems} not found`);
  }

  console.log("\nDone.\n");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
