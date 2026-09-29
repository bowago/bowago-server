// ─── src/services/pricing.service.js ─────────────────────────────────────────
// DB-facing pricing facade. All arithmetic lives in ./pricing/core.js (pure).
//
//   getOfferings(request)          → every ACTUALLY AVAILABLE shipping product
//                                     for a route + parcel (mode × service),
//                                     each with SLA, rate and full breakdown
//   calculateShippingCost(request) → ONE product (mode + service explicit).
//                                     Throws if that product is not sellable.
//
// There are no silent defaults: a request without a shipment mode / service is
// rejected, an undefined combination (e.g. SEA + EXPRESS) does not exist, and
// a product with no SLA or no usable rate is reported unavailable rather than
// priced from a fallback.
const { prisma } = require("../config/db");
const { ApiError } = require("../utils/ApiError");
const { getNumberSetting } = require("./settings.service");
const { getActiveRules, evaluateRulesSync } = require("./adhocCharge.service");
const core = require("./pricing/core");

const MODES = ["AIR", "LAND", "SEA"];
const SERVICES = ["EXPRESS", "STANDARD", "ECONOMY"];
const MODE_LABELS = core.MODE_LABEL;

// ─── Mode settings ───────────────────────────────────────────────────────────
const DEFAULT_MODE_SETTINGS = { volumetricDivisor: core.DEFAULT_VOLUMETRIC_DIVISOR, maxWeightKg: null, maxLongestSideCm: null, isActive: true };

async function getModeSetting(mode) {
  if (!mode) return DEFAULT_MODE_SETTINGS;
  const setting = await prisma.shipmentModeSetting.findUnique({ where: { mode } });
  return setting || DEFAULT_MODE_SETTINGS;
}

async function listModeSettings() {
  const rows = await prisma.shipmentModeSetting.findMany();
  const byMode = Object.fromEntries(rows.map((r) => [r.mode, r]));
  return MODES.map((mode) => byMode[mode] || { mode, ...DEFAULT_MODE_SETTINGS, id: null, transitHoursDefault: null });
}

async function assertModeActive(mode) {
  if (!mode) return;
  const setting = await prisma.shipmentModeSetting.findUnique({ where: { mode } });
  if (setting && setting.isActive === false) {
    throw new ApiError(400, `${MODE_LABELS[mode] || mode} shipping is currently unavailable. Please choose another mode of shipment.`, null, "MODE_INACTIVE");
  }
}

// A locked quote may still be booked only while its product is still offered.
async function assertOfferingSellable({ offeringId, shipmentMode, serviceType }) {
  await assertModeActive(shipmentMode);
  const offering = offeringId
    ? await prisma.serviceOffering.findUnique({ where: { id: offeringId } })
    : shipmentMode && serviceType
      ? await prisma.serviceOffering.findUnique({ where: { shipmentMode_serviceType: { shipmentMode, serviceType } } })
      : null;
  if (!offering) return; // legacy quote created before offerings existed
  if (!offering.isActive) {
    throw new ApiError(409, `${MODE_LABELS[offering.shipmentMode]} ${core.SERVICE_LABEL[offering.serviceType]} is no longer available. Please generate a new quote.`, null, "OFFERING_INACTIVE");
  }
}

// ─── Route: zone & distance ──────────────────────────────────────────────────
async function getZone(fromCityName, toCityName) {
  const [fromCity, toCity] = await Promise.all([
    prisma.city.findFirst({ where: { name: { equals: fromCityName, mode: "insensitive" } } }),
    prisma.city.findFirst({ where: { name: { equals: toCityName, mode: "insensitive" } } }),
  ]);
  if (!fromCity) throw new ApiError(400, `Origin city "${fromCityName}" not found. Check GET /pricing/cities`);
  if (!toCity) throw new ApiError(400, `Destination city "${toCityName}" not found. Check GET /pricing/cities`);

  const matrix = await prisma.zoneMatrix.findFirst({ where: { fromCityId: fromCity.id, toCityId: toCity.id, isActive: true } });
  if (!matrix) {
    const paused = await prisma.zoneMatrix.findFirst({ where: { fromCityId: fromCity.id, toCityId: toCity.id, isActive: false } });
    if (paused) throw new ApiError(400, `Route "${fromCityName}" → "${toCityName}" is temporarily unavailable. Please contact support.`);
    throw new ApiError(400, `No route found between "${fromCityName}" and "${toCityName}". This city pair has not been configured yet.`);
  }
  return { zone: matrix.zone, fromCity, toCity };
}

async function getDistance(fromCityId, toCityId) {
  const km = await prisma.kmMatrix.findUnique({ where: { fromCityId_toCityId: { fromCityId, toCityId } } });
  return km ? km.distanceKm : null;
}

// ─── Contract rates / promo codes ────────────────────────────────────────────
// A user's own contracts rank before their organisation master's. Scope
// (mode / service) and specificity are resolved in core.applyCommercial.
async function loadContractCandidates(userId) {
  if (!userId) return [];
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { masterId: true } });
  const owners = [userId, ...(user?.masterId ? [user.masterId] : [])];
  const rows = await prisma.contractRate.findMany({ where: { userId: { in: owners }, isActive: true } });
  return rows.map((r) => ({ ...r, ownerRank: r.userId === userId ? 0 : 1 }));
}

// Validates the CODE itself (exists, in date, not exhausted, not reused).
// Whether it applies to a particular mode/service is decided per offering.
async function loadPromo(code, userId) {
  if (!code) return null;
  const now = new Date();
  const promo = await prisma.promoCode.findFirst({
    where: {
      code: { equals: String(code).trim(), mode: "insensitive" },
      isActive: true,
      AND: [
        { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
        { OR: [{ validUntil: null }, { validUntil: { gte: now } }] },
      ],
    },
  });
  if (!promo) throw new ApiError(400, "Promo code is invalid or has expired");
  if (promo.maxUses !== null && promo.usedCount >= promo.maxUses) {
    throw new ApiError(400, "This promo code has reached its usage limit");
  }
  if (userId) {
    const alreadyUsed = await prisma.promoRedemption.findFirst({ where: { promoCodeId: promo.id, userId, shipmentId: null } });
    if (alreadyUsed) throw new ApiError(400, `You have already used promo code "${promo.code}"`);
  }
  return promo;
}

// Preview helper used by POST /promo-codes/preview: validates the code and
// its scope + minimum order for one product.
async function validatePromoCode(code, userId, basePrice, { serviceType, shipmentMode } = {}) {
  const promo = await loadPromo(code, userId);
  if (!promo) return null;
  if (shipmentMode && promo.shipmentMode && promo.shipmentMode !== shipmentMode) {
    throw new ApiError(400, `Promo code "${promo.code}" does not apply to ${MODE_LABELS[shipmentMode] || shipmentMode} shipping`);
  }
  if (serviceType && promo.serviceType && promo.serviceType !== serviceType) {
    throw new ApiError(400, `Promo code "${promo.code}" does not apply to this service`);
  }
  if (promo.minOrderAmount && basePrice < promo.minOrderAmount) {
    throw new ApiError(400, `Minimum order of ₦${promo.minOrderAmount.toLocaleString()} required for code "${promo.code}"`);
  }
  return promo;
}

// ─── Context loading (one batched read per request) ──────────────────────────
async function loadContext(req) {
  const { zone, fromCity, toCity } = await getZone(req.fromCity, req.toCity);
  const [distanceKm, modeRows, offerings, slas, bandRows, surcharges, rules, box, contracts, promo] = await Promise.all([
    getDistance(fromCity.id, toCity.id),
    prisma.shipmentModeSetting.findMany(),
    prisma.serviceOffering.findMany({ include: { lanes: true }, orderBy: [{ sortOrder: "asc" }, { shipmentMode: "asc" }, { serviceType: "asc" }] }),
    prisma.deliverySLA.findMany({ where: { zone } }),
    prisma.priceBand.findMany({ where: { isActive: true, OR: [{ zone }, { zone: null }] } }),
    prisma.surcharge.findMany({ where: { isActive: true } }),
    getActiveRules(),
    req.boxDimensionId ? prisma.boxDimension.findUnique({ where: { id: req.boxDimensionId } }) : null,
    loadContractCandidates(req.userId),
    loadPromo(req.promoCode, req.userId),
  ]);

  let insurance = { ratePercent: 0, minPremiumNaira: 0 };
  if (req.requiresInsurance) {
    const [ratePercent, minPremiumNaira] = await Promise.all([
      getNumberSetting("insurance.rate_percent"),
      getNumberSetting("insurance.min_premium_naira"),
    ]);
    insurance = { ratePercent, minPremiumNaira };
  }

  return {
    now: new Date(),
    zone, fromCity, toCity, distanceKm,
    modeSettings: Object.fromEntries(modeRows.map((r) => [r.mode, r])),
    offerings, slas, bands: bandRows, surcharges, box, contracts, promo, insurance,
    // Rules were loaded once above; evaluated per offering with that mode's measurements.
    evaluateAdhoc: (args) => evaluateRulesSync({ ...args, rules }),
  };
}

function routeInfo(ctx) {
  return {
    zone: ctx.zone,
    distanceKm: ctx.distanceKm,
    fromCity: { id: ctx.fromCity.id, name: ctx.fromCity.name, region: ctx.fromCity.region, state: ctx.fromCity.state },
    toCity: { id: ctx.toCity.id, name: ctx.toCity.name, region: ctx.toCity.region, state: ctx.toCity.state },
  };
}

// The raw ad-hoc evaluation (rule + chargeType objects) is needed exactly once
// — to persist applied/suggested lines — and must never leak into JSON.
function hideInternal(result) {
  if (result.adhocEvaluation) {
    Object.defineProperty(result, "adhocEvaluation", { value: result.adhocEvaluation, enumerable: false });
  }
  return result;
}

function assertValidDimensions(req) {
  if (req.shipmentMode && !MODES.includes(req.shipmentMode)) throw new ApiError(400, `shipmentMode must be one of ${MODES.join(", ")}`, null, "INVALID_MODE");
  if (req.serviceType && !SERVICES.includes(req.serviceType)) throw new ApiError(400, `serviceType must be one of ${SERVICES.join(", ")}`, null, "INVALID_SERVICE");
}

// ─── getOfferings: everything actually purchasable for this request ──────────
async function getOfferings(req) {
  assertValidDimensions(req);
  const ctx = await loadContext(req);
  const candidates = ctx.offerings.filter(
    (o) => (!req.shipmentMode || o.shipmentMode === req.shipmentMode) && (!req.serviceType || o.serviceType === req.serviceType),
  );

  const results = candidates.map((o) => hideInternal(core.evaluateOffering(ctx, o, req)));
  const available = results.filter((r) => r.available);
  const skipped = results.filter((r) => !r.available);

  return {
    route: routeInfo(ctx),
    billableWeightKg: available[0]?.billableWeightKg ?? null,
    offerings: available, // each carries promoStatus when a promo code was supplied
    unavailable: skipped.map((r) => ({
      offeringId: r.offeringId, shipmentMode: r.shipmentMode, serviceType: r.serviceType,
      displayName: r.displayName, reasonCode: r.reasonCode, reason: r.reason,
    })),
  };
}

// ─── calculateShippingCost: one explicit product ─────────────────────────────
async function calculateShippingCost(req) {
  assertValidDimensions(req);
  if (!req.shipmentMode || !req.serviceType) {
    throw new ApiError(400, "shipmentMode and serviceType are both required", null, "OFFERING_REQUIRED");
  }
  const ctx = await loadContext(req);

  if (ctx.offerings.length === 0) {
    throw new ApiError(503, "Shipping offerings have not been configured yet. Please contact support.", null, "NO_OFFERINGS_CONFIGURED");
  }
  const offering = ctx.offerings.find((o) => o.shipmentMode === req.shipmentMode && o.serviceType === req.serviceType);
  if (!offering) {
    throw new ApiError(400, `${MODE_LABELS[req.shipmentMode]} ${core.SERVICE_LABEL[req.serviceType]} is not a shipping option we offer`, null, "NOT_OFFERED");
  }

  const result = core.evaluateOffering(ctx, offering, req);
  if (!result.available) throw new ApiError(result.statusCode, result.reason, null, result.reasonCode);

  if (result.promoStatus && ["NOT_APPLICABLE", "BELOW_MIN_ORDER"].includes(result.promoStatus.status)) {
    throw new ApiError(400, result.promoStatus.message, null, `PROMO_${result.promoStatus.status}`);
  }

  const response = {
    ...result,
    ...routeInfo(ctx),
    // ── deprecated aliases (kept so older API clients keep working) ──
    weightKg: result.billableWeightKg,
    adhocTotalNaira: result.adhocTotal,
    totalSurcharge: Math.round((result.total - result.finalBasePrice) * 100) / 100, // everything above base — do NOT use to rebuild a subtotal
    breakdown: {
      priceBandId: result.rate.priceBandId,
      pricePerKg: result.rate.pricePerKg,
      standardBasePrice: result.basePrice,
      finalBasePrice: result.finalBasePrice,
    },
    insuranceValue: req.requiresInsurance ? result.insuredValue : null,
    insuranceAutoCalculated: result.insuranceAutoCalculated,
  };
  // spread drops non-enumerable props; re-attach the raw evaluation (hidden from JSON)
  Object.defineProperty(response, "adhocEvaluation", { value: result.adhocEvaluation, enumerable: false });
  return response;
}

// ─── Delivery date (from a SNAPSHOT, never today's SLA) ──────────────────────
function addBusinessDays(startDate, days) {
  const date = new Date(startDate);
  let added = 0;
  while (added < days) {
    date.setDate(date.getDate() + 1);
    const day = date.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  return date;
}

function estimateDeliveryDate(pickupDate, maxDays) {
  if (maxDays === null || maxDays === undefined) return null;
  return addBusinessDays(pickupDate ? new Date(pickupDate) : new Date(), maxDays);
}

module.exports = {
  MODES, SERVICES,
  assertModeActive, assertOfferingSellable,
  getOfferings, calculateShippingCost,
  getZone, getDistance,
  loadContractCandidates, loadPromo, validatePromoCode,
  getModeSetting, listModeSettings,
  estimateDeliveryDate, addBusinessDays,
  calcVolumetricWeight: core.calcVolumetricWeight,
  formatDeliveryLabel: core.formatDeliveryLabel,
};
