const XLSX = require('xlsx');
const { prisma } = require('../config/db');
const { calculateShippingCost } = require('../services/pricing.service');
const { ApiError } = require('../utils/ApiError');
const { success, created, getPagination, buildMeta } = require('../utils/helpers');

// ─── Bulk-import helper ─────────────────────────────────────────────────────
// Runs `fn` for each item in `items`, executing up to `concurrency` calls in
// parallel at a time. Used by importPricingSheet to avoid hundreds/thousands
// of fully-sequential awaited DB round-trips (which, on a serverless Postgres
// connection like Neon, can push a single import past the platform's request
// timeout — e.g. a 39x39 zone matrix is ~1,500 sequential upserts at
// 50-150ms each = 1-4 minutes just for that one sheet).
//
// Each call gets one retry (with a short backoff) if it fails with a
// connection-init error — Neon's pooled endpoint can transiently refuse new
// connections under sustained concurrent load from earlier batches.
function isConnectionError(err) {
  const name = err?.constructor?.name || err?.name || '';
  return (
    name === 'PrismaClientInitializationError' ||
    err?.message?.includes("Can't reach database server") ||
    err?.code === 'P1001'
  );
}

async function runInBatches(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      chunk.map(async (item) => {
        try {
          return await fn(item);
        } catch (err) {
          if (!isConnectionError(err)) throw err;
          // One retry after a short pause — gives the pooler time to free
          // up a connection slot.
          await new Promise((r) => setTimeout(r, 400));
          return fn(item);
        }
      }),
    );
    results.push(...settled);

    // Small pause between batches so the pooler isn't hit with back-to-back
    // bursts of `concurrency` new connections for thousands of operations.
    if (i + concurrency < items.length) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return results;
}

// ─── QUOTE ────────────────────────────────────────────────────────────────────
async function getQuote(req, res) {
  const {
    fromCity, toCity, weightKg, tons, cartons,
    boxDimensionId, customLength, customWidth, customHeight,
    serviceType, isFragile, requiresInsurance, insuranceValue,
    promoCode,
  } = req.body;

  const userId = req.user?.id || null;

  const quote = await calculateShippingCost({
    fromCity, toCity,
    weightKg, tons, cartons,
    boxDimensionId, customLength, customWidth, customHeight,
    serviceType: serviceType || 'STANDARD',
    isFragile: !!isFragile,
    requiresInsurance: !!requiresInsurance,
    insuranceValue: requiresInsurance ? (insuranceValue || 0) : 0,
    promoCode: promoCode || null,
    userId,
  });

  if (userId && quote.pricingMode === 'CONTRACT') {
    await prisma.activityLog.create({
      data: {
        userId,
        action: 'VIEW_CONTRACT_RATE',
        resource: 'ContractRate',
        metadata: { fromCity, toCity, zone: quote.zone, pricingMode: quote.pricingMode },
      },
    });
  }

  return success(res, { quote }, 'Shipping quote calculated');
}

// ─── CITIES ───────────────────────────────────────────────────────────────────
async function listCities(req, res) {
  const { region, state, search } = req.query;
  const cities = await prisma.city.findMany({
    where: {
      ...(region && { region: { contains: region, mode: 'insensitive' } }),
      ...(state  && { state:  { contains: state,  mode: 'insensitive' } }),
      ...(search && { name:   { contains: search, mode: 'insensitive' } }),
    },
    orderBy: [{ region: 'asc' }, { name: 'asc' }],
  });
  return success(res, { cities });
}

async function upsertCity(req, res) {
  const { name, region, state } = req.body;
  const trimmedName = String(name ?? '').trim();
  if (!trimmedName) throw new ApiError(400, 'City name is required');

  // Case-insensitive duplicate check — prevents "Lagos" vs "lagos" vs "LAGOS"
  const existing = await prisma.city.findFirst({
    where: { name: { equals: trimmedName, mode: 'insensitive' } },
  });

  if (existing) {
    throw new ApiError(409, `A city named "${existing.name}" already exists. Edit it instead of creating a duplicate.`);
  }

  const city = await prisma.city.create({
    data: { name: trimmedName, region, state },
  });
  return created(res, { city }, 'City saved');
}

async function updateCity(req, res) {
  const { id } = req.params;
  const { name, region, state } = req.body;

  const existing = await prisma.city.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'City not found');

  if (name) {
    const trimmedName = String(name).trim();
    if (!trimmedName) throw new ApiError(400, 'City name cannot be empty');

    // Case-insensitive duplicate check, excluding this city itself
    const duplicate = await prisma.city.findFirst({
      where: {
        name: { equals: trimmedName, mode: 'insensitive' },
        id: { not: id },
      },
    });
    if (duplicate) {
      throw new ApiError(409, `A city named "${duplicate.name}" already exists. Choose a different name.`);
    }
  }

  const city = await prisma.city.update({
    where: { id },
    data: {
      ...(name   && { name: String(name).trim() }),
      ...(region && { region }),
      ...(state  && { state }),
    },
  });
  return success(res, { city }, 'City updated');
}

async function deleteCity(req, res) {
  const { id } = req.params;
  const force = req.query.force === 'true' || req.query.force === '1';

  const existing = await prisma.city.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'City not found');

  // Count everything that references this city
  const [zoneAsFrom, zoneAsTo, kmAsFrom, kmAsTo] = await Promise.all([
    prisma.zoneMatrix.count({ where: { fromCityId: id } }),
    prisma.zoneMatrix.count({ where: { toCityId: id } }),
    prisma.kmMatrix.count({ where: { fromCityId: id } }),
    prisma.kmMatrix.count({ where: { toCityId: id } }),
  ]);

  const zoneRoutes = zoneAsFrom + zoneAsTo;
  const kmRoutes = kmAsFrom + kmAsTo;
  const totalDependents = zoneRoutes + kmRoutes;

  if (totalDependents > 0 && !force) {
    // Don't hard-delete blindly — tell the frontend exactly what's attached
    // so it can show a clear, human-readable confirmation instead of a
    // raw Prisma error.
    return res.status(409).json({
      success: false,
      code: 'CITY_HAS_DEPENDENTS',
      message: `"${existing.name}" is used in ${zoneRoutes} zone matrix route(s) and ${kmRoutes} distance (KM) route(s). Deleting it will also remove those routes.`,
      data: {
        city: { id: existing.id, name: existing.name },
        dependents: { zoneRoutes, kmRoutes, total: totalDependents },
      },
    });
  }

  // Either no dependents, or admin explicitly confirmed force=true.
  // Clean up dependent rows first to satisfy FK constraints, then delete the city.
  await prisma.$transaction([
    prisma.zoneMatrix.deleteMany({ where: { OR: [{ fromCityId: id }, { toCityId: id }] } }),
    prisma.kmMatrix.deleteMany({ where: { OR: [{ fromCityId: id }, { toCityId: id }] } }),
    prisma.city.delete({ where: { id } }),
  ]);

  return success(res, {}, `"${existing.name}" and ${totalDependents} associated route(s) deleted`);
}

// ─── BOX DIMENSIONS ───────────────────────────────────────────────────────────
async function listDimensions(req, res) {
  const dimensions = await prisma.boxDimension.findMany({ orderBy: { categoryId: 'asc' } });
  return success(res, { dimensions });
}

async function upsertDimension(req, res) {
  const { categoryId, displayName, lengthCm, widthCm, heightCm, bestFor, weightKgLimit } = req.body;
  const dimension = await prisma.boxDimension.upsert({
    where: { categoryId },
    update: { displayName, lengthCm, widthCm, heightCm, bestFor, weightKgLimit },
    create: { categoryId, displayName, lengthCm, widthCm, heightCm, bestFor, weightKgLimit },
  });
  return created(res, { dimension }, 'Box dimension saved');
}

async function deleteDimension(req, res) {
  await prisma.boxDimension.delete({ where: { id: req.params.id } });
  return success(res, {}, 'Dimension deleted');
}

// ─── updateDimension (Super Admin) ─────────────────────────────────────────────
async function updateDimension(req, res) {
  const { id } = req.params;
  const { categoryId, displayName, lengthCm, widthCm, heightCm, bestFor, weightKgLimit } = req.body;

  const existing = await prisma.boxDimension.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Box dimension not found');

  if (categoryId && categoryId !== existing.categoryId) {
    const dup = await prisma.boxDimension.findUnique({ where: { categoryId } });
    if (dup) throw new ApiError(409, 'A box with this Category ID already exists');
  }

  const dimension = await prisma.boxDimension.update({
    where: { id },
    data: {
      ...(categoryId    !== undefined && { categoryId }),
      ...(displayName   !== undefined && { displayName }),
      ...(lengthCm      !== undefined && { lengthCm }),
      ...(widthCm       !== undefined && { widthCm }),
      ...(heightCm      !== undefined && { heightCm }),
      ...(bestFor       !== undefined && { bestFor }),
      ...(weightKgLimit !== undefined && { weightKgLimit }),
    },
  });

  return success(res, { dimension }, 'Box dimension updated');
}

// ─── PRICE BANDS ──────────────────────────────────────────────────────────────
async function listPriceBands(req, res) {
  const { zone, serviceType, isActive } = req.query;
  const bands = await prisma.priceBand.findMany({
    where: {
      ...(zone        && { zone: parseInt(zone) }),
      ...(serviceType && { serviceType }),
      ...(isActive !== undefined && { isActive: isActive === 'true' }),
    },
    orderBy: [{ serviceType: 'asc' }, { zone: 'asc' }, { minKg: 'asc' }],
  });
  return success(res, { bands });
}

// ─── createPriceBand ──────────────────────────────────────────────────────────
// Supports two modes:
//   Mode A — single-zone row: { zone, pricePerKg, serviceType, minKg, ... }
//   Mode B — multi-zone map:  { fixedPricePerKgByZone: {"1":150,"2":200}, serviceType, label, ... }
// If the frontend sends fixedPricePerKgByZone it is stored as JSON; zone field is left null.
// serviceType is required by the frontend; defaults to STANDARD if omitted.
async function createPriceBand(req, res) {
  const {
    label, serviceType,
    zone, pricePerKg, basePrice,
    fixedPricePerKgByZone,
    discountPercent,
    minKg, maxKg, minTons, maxTons, minCartons, maxCartons,
    validFrom, validUntil, notes, isActive,
  } = req.body;

  // Validate: must have at least one pricing mechanism
  if (!pricePerKg && !basePrice && !fixedPricePerKgByZone && !discountPercent) {
    throw new ApiError(400, 'Provide at least one of: pricePerKg, basePrice, fixedPricePerKgByZone, or discountPercent');
  }

  // If fixedPricePerKgByZone is provided, zone is not needed (it's embedded in the map)
  // If neither is provided in multi-zone mode, zone is required for single-zone mode
  if (!fixedPricePerKgByZone && !zone && zone !== 0) {
    throw new ApiError(400, 'Provide zone (for single-zone bands) or fixedPricePerKgByZone (for multi-zone bands)');
  }

  const data = {
    label:                  label      || null,
    serviceType:            serviceType || 'STANDARD',
    zone:                   fixedPricePerKgByZone ? null : (zone !== undefined ? parseInt(zone) : null),
    pricePerKg:             pricePerKg  ? parseFloat(pricePerKg)  : null,
    basePrice:              basePrice   ? parseFloat(basePrice)   : null,
    fixedPricePerKgByZone:  fixedPricePerKgByZone || null,
    discountPercent:        discountPercent ? parseFloat(discountPercent) : null,
    minKg:                  minKg      !== undefined ? parseFloat(minKg)      : 0,
    maxKg:                  maxKg      !== undefined ? parseFloat(maxKg)      : null,
    minTons:                minTons    !== undefined ? parseFloat(minTons)    : 0,
    maxTons:                maxTons    !== undefined ? parseFloat(maxTons)    : null,
    minCartons:             minCartons !== undefined ? parseInt(minCartons)   : 0,
    maxCartons:             maxCartons !== undefined ? parseInt(maxCartons)   : null,
    validFrom:              validFrom  ? new Date(validFrom)  : null,
    validUntil:             validUntil ? new Date(validUntil) : null,
    notes:                  notes      || null,
    isActive:               isActive !== undefined ? isActive : true,
    createdBy:              req.user.id,
  };

  const band = await prisma.priceBand.create({ data });

  await prisma.priceAuditLog.create({
    data: {
      entityType: 'PriceBand', entityId: band.id, action: 'CREATE',
      newValue: band, changedBy: req.user.id,
    },
  });

  return created(res, { band }, 'Price band created');
}

async function updatePriceBand(req, res) {
  const { id } = req.params;
  const existing = await prisma.priceBand.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Price band not found');

  // Sanitise numeric fields
  const data = { ...req.body };
  if (data.zone        !== undefined) data.zone        = data.zone !== null ? parseInt(data.zone) : null;
  if (data.pricePerKg  !== undefined) data.pricePerKg  = data.pricePerKg  !== null ? parseFloat(data.pricePerKg)  : null;
  if (data.basePrice   !== undefined) data.basePrice   = data.basePrice   !== null ? parseFloat(data.basePrice)   : null;
  if (data.minKg       !== undefined) data.minKg       = parseFloat(data.minKg);
  if (data.maxKg       !== undefined) data.maxKg       = data.maxKg !== null ? parseFloat(data.maxKg) : null;
  if (data.validFrom   !== undefined) data.validFrom   = data.validFrom   ? new Date(data.validFrom)   : null;
  if (data.validUntil  !== undefined) data.validUntil  = data.validUntil  ? new Date(data.validUntil)  : null;
  // Remove reason before saving (it's audit-only)
  const { reason, ...saveData } = data;

  const band = await prisma.priceBand.update({ where: { id }, data: saveData });

  await prisma.priceAuditLog.create({
    data: {
      entityType: 'PriceBand', entityId: id, action: 'UPDATE',
      previousValue: existing, newValue: band,
      changedBy: req.user.id, reason: reason || null,
    },
  });

  return success(res, { band }, 'Price band updated');
}

async function deletePriceBand(req, res) {
  const { id } = req.params;
  const existing = await prisma.priceBand.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Price band not found');

  await prisma.priceBand.delete({ where: { id } });

  await prisma.priceAuditLog.create({
    data: {
      entityType: 'PriceBand', entityId: id, action: 'DELETE',
      previousValue: existing, changedBy: req.user.id,
    },
  });

  return success(res, {}, 'Price band deleted');
}

// ─── ZONE MATRIX ──────────────────────────────────────────────────────────────
async function getZoneMatrix(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { fromCity, toCity, isActive } = req.query;

  const where = {
    ...(fromCity && { fromCity: { name: { contains: fromCity, mode: 'insensitive' } } }),
    ...(toCity   && { toCity:   { name: { contains: toCity,   mode: 'insensitive' } } }),
    ...(isActive !== undefined && { isActive: isActive === 'true' }),
  };

  const [matrix, total] = await Promise.all([
    prisma.zoneMatrix.findMany({
      where, skip, take: limit,
      include: { fromCity: true, toCity: true },
      orderBy: [{ fromCity: { name: 'asc' } }],
    }),
    prisma.zoneMatrix.count({ where }),
  ]);

  return res.json({ success: true, data: { matrix }, meta: buildMeta(total, page, limit) });
}

async function upsertZoneMatrix(req, res) {
  const { fromCityId, toCityId, zone } = req.body;
  const record = await prisma.zoneMatrix.upsert({
    where: { fromCityId_toCityId: { fromCityId, toCityId } },
    update: { zone },
    create: { fromCityId, toCityId, zone },
    include: { fromCity: true, toCity: true },
  });
  return created(res, { record }, 'Zone matrix updated');
}

async function updateZoneMatrix(req, res) {
  const { id } = req.params;
  const { zone } = req.body;
  const existing = await prisma.zoneMatrix.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Zone matrix entry not found');
  if (zone === undefined || zone === null) throw new ApiError(400, 'zone number is required');
  const record = await prisma.zoneMatrix.update({
    where: { id },
    data: { zone: parseInt(zone) },
    include: { fromCity: true, toCity: true },
  });
  return success(res, { record }, `Zone ${record.fromCity.name} → ${record.toCity.name} updated to Zone ${record.zone}`);
}

// ─── ZONE MATRIX: Pause / Reinstate ───────────────────────────────────────────
async function pauseZoneMatrix(req, res) {
  const { id } = req.params;
  const existing = await prisma.zoneMatrix.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Zone matrix entry not found');
  if (!existing.isActive) throw new ApiError(400, 'Zone matrix entry is already paused');

  const record = await prisma.zoneMatrix.update({
    where: { id },
    data: { isActive: false },
    include: { fromCity: true, toCity: true },
  });

  return success(res, { record }, `Zone route ${record.fromCity.name} → ${record.toCity.name} paused`);
}

async function reinstateZoneMatrix(req, res) {
  const { id } = req.params;
  const existing = await prisma.zoneMatrix.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Zone matrix entry not found');
  if (existing.isActive) throw new ApiError(400, 'Zone matrix entry is already active');

  const record = await prisma.zoneMatrix.update({
    where: { id },
    data: { isActive: true },
    include: { fromCity: true, toCity: true },
  });

  return success(res, { record }, `Zone route ${record.fromCity.name} → ${record.toCity.name} reinstated`);
}

async function deleteZoneMatrix(req, res) {
  const { id } = req.params;
  const existing = await prisma.zoneMatrix.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Zone matrix entry not found');

  await prisma.zoneMatrix.delete({ where: { id } });
  return success(res, {}, 'Zone matrix entry deleted');
}

// ─── PRICING STATS (Dashboard quick-counts) ───────────────────────────────────
async function getPricingStats(req, res) {
  const [
    totalZone,
    totalRegisteredCity,
    totalContractRate,
    totalStandardRate,
    totalPromoRate,
    totalBoxDimension,
  ] = await Promise.all([
    // Active zone pairs in the matrix
    prisma.zoneMatrix.count({ where: { isActive: true } }),
    // Cities registered in the system
    prisma.city.count(),
    // Contract rates (active)
    prisma.contractRate.count({ where: { isActive: true } }),
    // Standard price bands (active)
    prisma.priceBand.count({ where: { isActive: true } }),
    // Admin promo rates (active)
    prisma.promoRate.count({ where: { isActive: true } }),
    // Box dimension types
    prisma.boxDimension.count(),
  ]);

  return success(res, {
    totalZone,
    totalRegisteredCity,
    totalContractRate,
    totalStandardRate,
    totalPromoRate,
    totalBoxDimension,
  }, 'Pricing stats returned');
}

// ─── PRICE ROLLBACK (Sprint 8) ────────────────────────────────────────────────
async function rollbackPriceBand(req, res) {
  const { auditLogId } = req.params;

  const log = await prisma.priceAuditLog.findUnique({ where: { id: auditLogId } });
  if (!log) throw new ApiError(404, 'Audit log entry not found');
  if (!log.previousValue) throw new ApiError(400, 'No previous value to roll back to');
  if (log.entityType !== 'PriceBand') throw new ApiError(400, 'Can only rollback PriceBand entries');

  const prev = log.previousValue;

  const band = await prisma.priceBand.update({
    where: { id: log.entityId },
    data: {
      zone:                  prev.zone,
      serviceType:           prev.serviceType,
      label:                 prev.label,
      minKg:                 prev.minKg,
      maxKg:                 prev.maxKg,
      pricePerKg:            prev.pricePerKg,
      basePrice:             prev.basePrice,
      fixedPricePerKgByZone: prev.fixedPricePerKgByZone,
      discountPercent:       prev.discountPercent,
      isActive:              prev.isActive,
    },
  });

  await prisma.priceAuditLog.create({
    data: {
      entityType: 'PriceBand', entityId: log.entityId,
      action: 'UPDATE',
      previousValue: await prisma.priceBand.findUnique({ where: { id: log.entityId } }),
      newValue: band,
      changedBy: req.user.id,
      reason: `Rolled back to previous value via audit log ${auditLogId}`,
    },
  });

  return success(res, { band }, 'Price band rolled back successfully');
}

// ─── EXCEL IMPORT ─────────────────────────────────────────────────────────────
// ─── EXPORT PRICING SHEET (Super Admin) ─────────────────────────────────────
// Produces an .xlsx in the same layout the importer expects, populated with
// the platform's CURRENT data — so a super admin can export, edit in Excel
// (e.g. fill in real prices), and re-import. Sheets:
//   - Dimensions       (box types, same CSV-row format as the import sheet)
//   - Zone Matrix      (city x city grid of zone numbers)
//   - Matrix by KM     (city x city grid of distances)
//   - Price Bands      (flat sheet: zone, band, serviceType, pricePerKg, basePrice, isActive)
async function exportPricingSheet(req, res) {
  const [cities, dimensions, zoneMatrix, kmMatrix, priceBands] = await Promise.all([
    prisma.city.findMany({ orderBy: { name: 'asc' } }),
    prisma.boxDimension.findMany({ orderBy: { categoryId: 'asc' } }),
    prisma.zoneMatrix.findMany({ include: { fromCity: true, toCity: true } }),
    prisma.kmMatrix.findMany({ include: { fromCity: true, toCity: true } }),
    prisma.priceBand.findMany({ orderBy: [{ zone: 'asc' }, { serviceType: 'asc' }, { minKg: 'asc' }] }),
  ]);

  const wb = XLSX.utils.book_new();
  const cityNames = cities.map((c) => c.name);

  // ── Dimensions sheet ──
  // Mirrors the import format: a header row, then CSV rows of
  // "category_id,display_name,length,width,height,best_for,weight_limit"
  const dimRows = [
    ['category_id,display_name,length_cm,width_cm,height_cm,best_for,weight_kg_limit'],
    ...dimensions.map((d) => [
      `${d.categoryId},${d.displayName},${d.lengthCm},${d.widthCm},${d.heightCm},${d.bestFor ?? ''},${d.weightKgLimit}`,
    ]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dimRows), 'Dimensions');

  // ── Zone Matrix sheet (city x city grid) ──
  const zoneLookup = new Map();
  for (const z of zoneMatrix) {
    zoneLookup.set(`${z.fromCity.name}|${z.toCity.name}`, z.zone);
  }
  const zoneHeader = ['Region', 'From City', ...cityNames];
  const zoneRows = [zoneHeader];
  for (const city of cities) {
    const row = [city.region ?? '', city.name];
    for (const toName of cityNames) {
      row.push(zoneLookup.get(`${city.name}|${toName}`) ?? '');
    }
    zoneRows.push(row);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(zoneRows), 'Zone Matrix');

  // ── Matrix by KM sheet (city x city grid) ──
  const kmLookup = new Map();
  for (const k of kmMatrix) {
    kmLookup.set(`${k.fromCity.name}|${k.toCity.name}`, k.distanceKm);
  }
  const kmHeader = ['From City', ...cityNames];
  const kmRows = [kmHeader];
  for (const city of cities) {
    const row = [city.name];
    for (const toName of cityNames) {
      row.push(kmLookup.get(`${city.name}|${toName}`) ?? '');
    }
    kmRows.push(row);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(kmRows), 'Matrix by KM');

  // ── Price Bands sheet (flat — current actual pricing) ──
  const priceHeader = ['Zone', 'Min Kg', 'Max Kg', 'Service Type', 'Price Per Kg (NGN)', 'Base Price (NGN)', 'Active', 'Notes'];
  const priceRows = [priceHeader];
  for (const b of priceBands) {
    priceRows.push([
      b.zone,
      b.minKg,
      b.maxKg ?? 'No limit',
      b.serviceType,
      b.pricePerKg,
      b.basePrice,
      b.isActive ? 'TRUE' : 'FALSE',
      b.notes ?? '',
    ]);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(priceRows), 'Price Bands');

  // ── Cities sheet (reference — region/state per city) ──
  const cityHeader = ['Name', 'Region', 'State'];
  const cityRows = [cityHeader, ...cities.map((c) => [c.name, c.region, c.state])];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cityRows), 'Cities');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filename = `BowaGO-Pricing-Export-${new Date().toISOString().slice(0, 10)}.xlsx`;

  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': buffer.length,
  });
  res.send(buffer);
}

async function importPricingSheet(req, res) {
  if (!req.file) throw new ApiError(400, 'No file uploaded');

  const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });

  const results = { cities: 0, zones: 0, km: 0, priceBands: 0, dimensions: 0, errors: [] };
  const importerId = req.user?.id ?? null;

  // Dimensions sheet
  if (workbook.SheetNames.includes('Dimensions')) {
    const sheet = XLSX.utils.sheet_to_json(workbook.Sheets['Dimensions'], { header: 1 });
    let csvStartIdx = -1;
    for (let i = 0; i < sheet.length; i++) {
      if (sheet[i][0] && String(sheet[i][0]).startsWith('category_id')) { csvStartIdx = i + 1; break; }
    }
    if (csvStartIdx > 0) {
      for (let i = csvStartIdx; i < sheet.length; i++) {
        const row = sheet[i];
        if (!row[0]) continue;
        try {
          const [categoryId, displayName, lengthCm, widthCm, heightCm, bestFor, weightKgLimit] =
            String(row[0]).split(',');
          await prisma.boxDimension.upsert({
            where: { categoryId: categoryId.trim() },
            update: { displayName: displayName.trim(), lengthCm: parseFloat(lengthCm), widthCm: parseFloat(widthCm), heightCm: parseFloat(heightCm), bestFor: bestFor?.trim(), weightKgLimit: parseFloat(weightKgLimit) },
            create: { categoryId: categoryId.trim(), displayName: displayName.trim(), lengthCm: parseFloat(lengthCm), widthCm: parseFloat(widthCm), heightCm: parseFloat(heightCm), bestFor: bestFor?.trim(), weightKgLimit: parseFloat(weightKgLimit) },
          });
          results.dimensions++;
        } catch (e) { results.errors.push(`Dimension row ${i}: ${e.message}`); }
      }
    }
  }

  // ─── Build city → region/state map ────────────────────────────────────────
  // Known Nigerian city → state lookup so imported cities get real metadata
  const knownCityStates = {
    'Abuja': 'FCT', 'Jos': 'Plateau', 'Lafia': 'Nasarawa', 'Lokoja': 'Kogi',
    'Makurdi': 'Benue', 'Minna': 'Niger', 'Ilorin': 'Kwara',
    'Bauchi': 'Bauchi', 'Damaturu': 'Yobe', 'Gombe': 'Gombe',
    'Jalingo': 'Taraba', 'Maiduguri': 'Borno', 'Yola': 'Adamawa',
    'Birnin Kebbi': 'Kebbi', 'Dutse': 'Jigawa', 'Gusau': 'Zamfara',
    'Kaduna': 'Kaduna', 'Kano': 'Kano', 'Katsina': 'Katsina',
    'Sokoto': 'Sokoto', 'Zaria': 'Kaduna',
    'Aba': 'Abia', 'Abakaliki': 'Ebonyi', 'Awka': 'Anambra',
    'Enugu': 'Enugu', 'Owerri': 'Imo', 'Umuahia': 'Abia',
    'Asaba': 'Delta', 'Benin City': 'Edo', 'Calabar': 'Cross River',
    'Port Harcourt': 'Rivers', 'Uyo': 'Akwa Ibom', 'Yenagoa': 'Bayelsa',
    'Abeokuta': 'Ogun', 'Ado-Ekiti': 'Ekiti', 'Akure': 'Ondo',
    'Ibadan': 'Oyo', 'Ife': 'Osun', 'Lagos': 'Lagos', 'Lagos City': 'Lagos',
  };
  const stateRegionMap = {
    'FCT': 'North Central', 'Plateau': 'North Central', 'Nasarawa': 'North Central',
    'Kogi': 'North Central', 'Kwara': 'North Central', 'Benue': 'North Central', 'Niger': 'North Central',
    'Bauchi': 'North East', 'Yobe': 'North East', 'Gombe': 'North East',
    'Taraba': 'North East', 'Borno': 'North East', 'Adamawa': 'North East',
    'Kebbi': 'North West', 'Jigawa': 'North West', 'Zamfara': 'North West',
    'Kaduna': 'North West', 'Kano': 'North West', 'Katsina': 'North West', 'Sokoto': 'North West',
    'Abia': 'South East', 'Ebonyi': 'South East', 'Anambra': 'South East',
    'Enugu': 'South East', 'Imo': 'South East',
    'Delta': 'South South', 'Edo': 'South South', 'Cross River': 'South South',
    'Rivers': 'South South', 'Akwa Ibom': 'South South', 'Bayelsa': 'South South',
    'Ogun': 'South West', 'Ekiti': 'South West', 'Ondo': 'South West',
    'Oyo': 'South West', 'Osun': 'South West', 'Lagos': 'South West',
  };

  // Build per-city lookup: first try "Zone Matrix by Region" sheet, then fall back to knownCityStates
  const cityRegionMap = {};
  if (workbook.SheetNames.includes('Zone Matrix by Region')) {
    const regSheet = XLSX.utils.sheet_to_json(workbook.Sheets['Zone Matrix by Region'], { header: 1 });
    let currentRegion = '';
    for (let i = 1; i < regSheet.length; i++) {
      const row = regSheet[i];
      if (!row || (!row[0] && !row[1])) continue;
      if (row[0] && typeof row[0] === 'string' && row[0].trim()) currentRegion = row[0].trim();
      const cityName = row[1] ? String(row[1]).trim() : null;
      if (cityName && currentRegion) {
        const state = knownCityStates[cityName] ?? currentRegion;
        cityRegionMap[cityName] = { region: currentRegion, state };
      }
    }
  }
  // Fill in any cities not found in the region sheet
  for (const [cityName, state] of Object.entries(knownCityStates)) {
    if (!cityRegionMap[cityName]) {
      cityRegionMap[cityName] = { region: stateRegionMap[state] ?? 'Unknown', state };
    }
  }

  // Zone Matrix sheet
  if (workbook.SheetNames.includes('Zone Matrix')) {
    const sheet = XLSX.utils.sheet_to_json(workbook.Sheets['Zone Matrix'], { header: 1 });
    const headers = sheet[0];
    const cityColumns = headers.slice(2);
    const cityMap = {};
    const allCityNames = new Set([...cityColumns]);
    for (let i = 1; i < sheet.length; i++) { if (sheet[i][1]) allCityNames.add(sheet[i][1]); }

    // Upsert all cities concurrently (bounded), ~39 calls instead of fully sequential
    const cityNameList = [...allCityNames].filter((n) => n && typeof n === 'string');
    const cityResults = await runInBatches(cityNameList, 8, async (cityName) => {
      const meta = cityRegionMap[cityName.trim()] ?? { region: 'Unknown', state: 'Unknown' };
      const city = await prisma.city.upsert({
        where: { name: cityName.trim() },
        // Always update so existing "Unknown" records get corrected on re-import
        update: { region: meta.region, state: meta.state },
        create: { name: cityName.trim(), region: meta.region, state: meta.state },
      });
      return { cityName: cityName.trim(), id: city.id };
    });
    for (const r of cityResults) {
      if (r.status === 'fulfilled') {
        cityMap[r.value.cityName] = r.value.id;
        results.cities++;
      } else {
        results.errors.push(`City upsert: ${r.reason?.message}`);
      }
    }

    // Build the flat list of (fromCity, toCity, zone) entries first, then
    // upsert them all concurrently (bounded) — a 39x39 matrix is ~1,500
    // entries, so this turns ~1,500 sequential round-trips into ~75 batches
    // of 20 concurrent calls.
    const zoneEntries = [];
    for (let i = 1; i < sheet.length; i++) {
      const row = sheet[i];
      const fromCityName = row[1];
      if (!fromCityName) continue;
      for (let j = 0; j < cityColumns.length; j++) {
        const toCityName = cityColumns[j];
        const zone = row[j + 2];
        if (!zone || !toCityName) continue;
        const fromId = cityMap[fromCityName?.trim()];
        const toId   = cityMap[toCityName?.trim()];
        if (!fromId || !toId) continue;
        zoneEntries.push({ fromCityName, toCityName, fromId, toId, zone: parseInt(zone) });
      }
    }

    const zoneResults = await runInBatches(zoneEntries, 8, (entry) =>
      prisma.zoneMatrix.upsert({
        where: { fromCityId_toCityId: { fromCityId: entry.fromId, toCityId: entry.toId } },
        update: { zone: entry.zone },
        create: { fromCityId: entry.fromId, toCityId: entry.toId, zone: entry.zone },
      }),
    );
    zoneResults.forEach((r, idx) => {
      if (r.status === 'fulfilled') {
        results.zones++;
      } else {
        const entry = zoneEntries[idx];
        results.errors.push(`Zone ${entry.fromCityName}->${entry.toCityName}: ${r.reason?.message}`);
      }
    });
  }

  // KM Matrix sheet
  if (workbook.SheetNames.includes('Matrix by KM')) {
    const sheet = XLSX.utils.sheet_to_json(workbook.Sheets['Matrix by KM'], { header: 1 });
    const headers = sheet[0];
    const toCityNames = headers.slice(1);
    const cityMap = {};

    // Collect every distinct city name referenced in this sheet, then
    // resolve them all in ONE query instead of one findFirst per name
    // (previously up to ~78 sequential lookups for a 39-city matrix).
    const allNames = new Set();
    for (let i = 1; i < sheet.length; i++) {
      if (sheet[i][0]) allNames.add(String(sheet[i][0]).trim());
    }
    for (const name of toCityNames) {
      if (name) allNames.add(String(name).trim());
    }

    const matchedCities = await prisma.city.findMany({
      where: { name: { in: [...allNames], mode: 'insensitive' } },
      select: { id: true, name: true },
    });
    const byLowerName = new Map(matchedCities.map((c) => [c.name.toLowerCase(), c]));
    for (const name of allNames) {
      const match = byLowerName.get(name.toLowerCase());
      if (match) cityMap[name] = match.id;
    }

    // Build the flat list of (fromCity, toCity, distanceKm) entries, then
    // upsert concurrently in bounded batches (was ~1,500 sequential calls).
    const kmEntries = [];
    for (let i = 1; i < sheet.length; i++) {
      const row = sheet[i];
      const fromCityName = row[0];
      if (!fromCityName) continue;
      const fromId = cityMap[String(fromCityName).trim()];
      if (!fromId) continue;
      for (let j = 0; j < toCityNames.length; j++) {
        const toCityName = toCityNames[j];
        const dist = row[j + 1];
        if (!dist && dist !== 0) continue;
        const toId = cityMap[toCityName ? String(toCityName).trim() : ''];
        if (!toId) continue;
        kmEntries.push({ fromCityName, toCityName, fromId, toId, distanceKm: parseFloat(dist) });
      }
    }

    const kmResults = await runInBatches(kmEntries, 8, (entry) =>
      prisma.kmMatrix.upsert({
        where: { fromCityId_toCityId: { fromCityId: entry.fromId, toCityId: entry.toId } },
        update: { distanceKm: entry.distanceKm },
        create: { fromCityId: entry.fromId, toCityId: entry.toId, distanceKm: entry.distanceKm },
      }),
    );
    kmResults.forEach((r, idx) => {
      if (r.status === 'fulfilled') {
        results.km++;
      } else {
        const entry = kmEntries[idx];
        results.errors.push(`KM ${entry.fromCityName}->${entry.toCityName}: ${r.reason?.message}`);
      }
    });
  }

  // ─── Price sheet → priceBand records ─────────────────────────────────────
  // Expected columns: KG (range like "50 -200"), Tons, Cartons, Zone (numeric)
  // Zone column only appears on the first row of each zone block; subsequent
  // rows for the same zone have null in the Zone column.
  if (workbook.SheetNames.includes('Price')) {
    const sheet = XLSX.utils.sheet_to_json(workbook.Sheets['Price'], { header: 1 });

    // Find the header row (row with "KG" in first column)
    let dataStart = -1;
    for (let i = 0; i < sheet.length; i++) {
      if (sheet[i] && String(sheet[i][0]).trim().toUpperCase() === 'KG') {
        dataStart = i + 1;
        break;
      }
    }

    if (dataStart > 0) {
      let currentZone = null;
      // Track the lowest minKg seen per zone so we can backfill a
      // "0 to (lowest minKg - 1)" band afterward — the source sheet's
      // ranges start at 50kg, leaving every shipment under 50kg with
      // no matching band ("No pricing available for zone X at Ykg").
      const lowestMinKgByZone = {};

      // Collect all (zone, minKg, maxKg) combos parsed from the sheet first,
      // so we can do ONE findMany to check what already exists instead of
      // a findFirst per (zone, serviceType, band) — was up to ~144 sequential
      // round-trips for a 4-zone/6-band sheet.
      const parsedBands = [];

      for (let i = dataStart; i < sheet.length; i++) {
        const row = sheet[i];
        if (!row || !row[0]) continue;

        // Zone column is col index 3; propagate downward when null
        if (row[3] !== null && row[3] !== undefined && row[3] !== '') {
          currentZone = parseInt(row[3]);
        }
        if (!currentZone) continue;

        // Parse weight range from the KG column e.g. "50 -200", "201 - 500", "2001 and Above"
        const kgStr = String(row[0]).trim();
        let minKg = null;
        let maxKg = null;

        const rangeMatch = kgStr.match(/^([\d,]+)\s*[-–]\s*([\d,]+)/);
        const aboveMatch = kgStr.match(/^([\d,]+)\s+and\s+above/i);

        if (rangeMatch) {
          minKg = parseFloat(rangeMatch[1].replace(',', ''));
          maxKg = parseFloat(rangeMatch[2].replace(',', ''));
        } else if (aboveMatch) {
          minKg = parseFloat(aboveMatch[1].replace(',', ''));
          maxKg = null; // open-ended upper bound
        } else {
          results.errors.push(`Price row ${i}: could not parse KG range "${kgStr}"`);
          continue;
        }

        if (lowestMinKgByZone[currentZone] === undefined || minKg < lowestMinKgByZone[currentZone]) {
          lowestMinKgByZone[currentZone] = minKg;
        }

        for (const serviceType of ['EXPRESS', 'STANDARD', 'ECONOMY']) {
          parsedBands.push({ zone: currentZone, serviceType, minKg, maxKg, kgStr });
        }
      }

      // Gap-fill 0-(lowestMinKg-1) bands for each zone/service
      for (const [zoneStr, lowestMinKg] of Object.entries(lowestMinKgByZone)) {
        const zone = parseInt(zoneStr);
        if (lowestMinKg <= 0) continue;
        for (const serviceType of ['EXPRESS', 'STANDARD', 'ECONOMY']) {
          parsedBands.push({
            zone, serviceType, minKg: 0, maxKg: lowestMinKg - 1,
            kgStr: `0-${lowestMinKg - 1} (gap-fill)`,
            isGapFill: true,
          });
        }
      }

      // One query to find every existing band that matches any of the
      // (zone, serviceType, minKg, maxKg) combos we're about to consider.
      const zonesInvolved = [...new Set(parsedBands.map((b) => b.zone))];
      const existingBands = await prisma.priceBand.findMany({
        where: { zone: { in: zonesInvolved } },
        select: { zone: true, serviceType: true, minKg: true, maxKg: true },
      });
      const existingKey = (b) => `${b.zone}|${b.serviceType}|${b.minKg}|${b.maxKg ?? 'null'}`;
      const existingSet = new Set(existingBands.map(existingKey));

      const toCreate = parsedBands.filter((b) => !existingSet.has(existingKey(b)));
      // Also de-dupe within the batch itself (e.g. gap-fill band already
      // present as a regular parsed band for the same key)
      const seen = new Set();
      const toCreateUnique = toCreate.filter((b) => {
        const key = existingKey(b);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const createResults = await runInBatches(toCreateUnique, 8, (b) =>
        prisma.priceBand.create({
          data: {
            zone: b.zone,
            serviceType: b.serviceType,
            minKg: b.minKg,
            maxKg: b.maxKg,
            // Placeholder — 0 so admin can see the band exists and set real prices
            pricePerKg: 0,
            basePrice: 0,
            isActive: true,
            ...(b.isGapFill && {
              notes: 'Auto-generated gap-fill band — set real pricing for shipments under the imported sheet\'s minimum weight.',
            }),
            ...(importerId ? { createdBy: importerId } : {}),
          },
        }),
      );
      createResults.forEach((r, idx) => {
        if (r.status === 'fulfilled') {
          results.priceBands++;
        } else {
          const b = toCreateUnique[idx];
          results.errors.push(`PriceBand zone${b.zone} ${b.serviceType} ${b.kgStr}: ${r.reason?.message}`);
        }
      });
    }
  }

  return success(res, { results }, 'Import completed');
}

// ─── Backfill 0–(min-1)kg price bands for all zones ────────────────────────
// One-off fix for installs that already imported a pricing sheet whose
// ranges all started at 50kg, leaving every sub-50kg shipment with
// "No pricing available for zone X at Ykg". Finds the lowest minKg per
// (zone, serviceType) and creates a 0-to-(lowest-1) placeholder band if
// missing.
async function backfillLowWeightBands(req, res) {
  const bands = await prisma.priceBand.findMany({
    where: { zone: { not: null } },
    select: { zone: true, serviceType: true, minKg: true },
  });

  const lowestByZoneService = {};
  for (const b of bands) {
    const key = `${b.zone}:${b.serviceType}`;
    if (lowestByZoneService[key] === undefined || b.minKg < lowestByZoneService[key]) {
      lowestByZoneService[key] = b.minKg;
    }
  }

  let created = 0;
  const errors = [];

  for (const [key, lowestMinKg] of Object.entries(lowestByZoneService)) {
    if (lowestMinKg <= 0) continue;
    const [zoneStr, serviceType] = key.split(':');
    const zone = parseInt(zoneStr);

    try {
      const existing = await prisma.priceBand.findFirst({
        where: { zone, serviceType, minKg: 0, maxKg: lowestMinKg - 1 },
      });

      if (!existing) {
        await prisma.priceBand.create({
          data: {
            zone,
            serviceType,
            minKg: 0,
            maxKg: lowestMinKg - 1,
            pricePerKg: 0,
            basePrice: 0,
            isActive: true,
            notes: 'Auto-generated gap-fill band — set real pricing for shipments under the imported sheet\'s minimum weight.',
            ...(req.user?.id ? { createdBy: req.user.id } : {}),
          },
        });
        created++;
      }
    } catch (e) {
      errors.push(`zone${zone} ${serviceType}: ${e.message}`);
    }
  }

  return success(res, { created, errors }, `Created ${created} gap-fill price band(s)`);
}

module.exports = {
  getQuote, listCities, upsertCity, updateCity, deleteCity,
  listDimensions, upsertDimension, updateDimension, deleteDimension,
  listPriceBands, createPriceBand, updatePriceBand, deletePriceBand,
  getZoneMatrix, upsertZoneMatrix, updateZoneMatrix, pauseZoneMatrix, reinstateZoneMatrix, deleteZoneMatrix,
  getPricingStats,
  rollbackPriceBand, importPricingSheet, exportPricingSheet, backfillLowWeightBands,
};
