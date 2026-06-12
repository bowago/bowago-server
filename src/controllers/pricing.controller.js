const XLSX = require('xlsx');
const { prisma } = require('../config/db');
const { calculateShippingCost } = require('../services/pricing.service');
const { ApiError } = require('../utils/ApiError');
const { success, created, getPagination, buildMeta } = require('../utils/helpers');

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

    for (const cityName of allCityNames) {
      if (!cityName || typeof cityName !== 'string') continue;
      const meta = cityRegionMap[cityName.trim()] ?? { region: 'Unknown', state: 'Unknown' };
      const city = await prisma.city.upsert({
        where: { name: cityName.trim() },
        // Always update so existing "Unknown" records get corrected on re-import
        update: { region: meta.region, state: meta.state },
        create: { name: cityName.trim(), region: meta.region, state: meta.state },
      });
      cityMap[cityName.trim()] = city.id;
      results.cities++;
    }

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
        try {
          await prisma.zoneMatrix.upsert({
            where: { fromCityId_toCityId: { fromCityId: fromId, toCityId: toId } },
            update: { zone: parseInt(zone) },
            create: { fromCityId: fromId, toCityId: toId, zone: parseInt(zone) },
          });
          results.zones++;
        } catch (e) { results.errors.push(`Zone ${fromCityName}->${toCityName}: ${e.message}`); }
      }
    }
  }

  // KM Matrix sheet
  if (workbook.SheetNames.includes('Matrix by KM')) {
    const sheet = XLSX.utils.sheet_to_json(workbook.Sheets['Matrix by KM'], { header: 1 });
    const headers = sheet[0];
    const toCityNames = headers.slice(1);
    const cityMap = {};

    for (let i = 1; i < sheet.length; i++) {
      if (sheet[i][0]) {
        const city = await prisma.city.findFirst({ where: { name: { equals: sheet[i][0].trim(), mode: 'insensitive' } } });
        if (city) cityMap[sheet[i][0].trim()] = city.id;
      }
    }
    for (const name of toCityNames) {
      if (!name) continue;
      const city = await prisma.city.findFirst({ where: { name: { equals: name.trim(), mode: 'insensitive' } } });
      if (city) cityMap[name.trim()] = city.id;
    }

    for (let i = 1; i < sheet.length; i++) {
      const row = sheet[i];
      const fromCityName = row[0];
      if (!fromCityName) continue;
      const fromId = cityMap[fromCityName.trim()];
      if (!fromId) continue;
      for (let j = 0; j < toCityNames.length; j++) {
        const toCityName = toCityNames[j];
        const dist = row[j + 1];
        if (!dist && dist !== 0) continue;
        const toId = cityMap[toCityName?.trim()];
        if (!toId) continue;
        try {
          await prisma.kmMatrix.upsert({
            where: { fromCityId_toCityId: { fromCityId: fromId, toCityId: toId } },
            update: { distanceKm: parseFloat(dist) },
            create: { fromCityId: fromId, toCityId: toId, distanceKm: parseFloat(dist) },
          });
          results.km++;
        } catch (e) { results.errors.push(`KM ${fromCityName}->${toCityName}: ${e.message}`); }
      }
    }
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

        // Create a price band for each service type (EXPRESS, STANDARD, ECONOMY)
        // The Excel doesn't differentiate by service type, so we create one per type
        // using a placeholder pricePerKg; admins can update individual bands after import.
        // We do NOT overwrite if a specific pricePerKg already exists (only create missing bands).
        for (const serviceType of ['EXPRESS', 'STANDARD', 'ECONOMY']) {
          try {
            const existing = await prisma.priceBand.findFirst({
              where: { zone: currentZone, serviceType, minKg, maxKg },
            });

            if (!existing) {
              await prisma.priceBand.create({
                data: {
                  zone: currentZone,
                  serviceType,
                  minKg,
                  maxKg,
                  // Placeholder — 0 so admin can see the band exists and set real prices
                  pricePerKg: 0,
                  basePrice: 0,
                  isActive: true,
                  ...(importerId ? { createdBy: importerId } : {}),
                },
              });
              results.priceBands++;
            }
          } catch (e) {
            results.errors.push(`PriceBand zone${currentZone} ${serviceType} ${kgStr}: ${e.message}`);
          }
        }
      }
    }
  }

  return success(res, { results }, 'Import completed');
}

module.exports = {
  getQuote, listCities, upsertCity, updateCity, deleteCity,
  listDimensions, upsertDimension, deleteDimension,
  listPriceBands, createPriceBand, updatePriceBand, deletePriceBand,
  getZoneMatrix, upsertZoneMatrix, updateZoneMatrix, pauseZoneMatrix, reinstateZoneMatrix, deleteZoneMatrix,
  getPricingStats,
  rollbackPriceBand, importPricingSheet,
};
