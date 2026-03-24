const { prisma } = require('../config/db');
const { ApiError } = require('../utils/ApiError');

// ─── Volumetric weight (Sprint 1 spec) ────────────────────────────────────────
// Formula: (L × W × H) / 5000  →  rounded UP to nearest 0.5kg
function calcVolumetricWeight(l, w, h) {
  const raw = (parseFloat(l) * parseFloat(w) * parseFloat(h)) / 5000;
  return Math.ceil(raw * 2) / 2;
}

function roundHalf(val) {
  return Math.ceil(parseFloat(val) * 2) / 2;
}

// ─── Zone lookup ──────────────────────────────────────────────────────────────
async function getZone(fromCityName, toCityName) {
  const [fromCity, toCity] = await Promise.all([
    prisma.city.findFirst({ where: { name: { equals: fromCityName, mode: 'insensitive' } } }),
    prisma.city.findFirst({ where: { name: { equals: toCityName, mode: 'insensitive' } } }),
  ]);

  if (!fromCity) throw new ApiError(400, `Origin city "${fromCityName}" not found. Check GET /pricing/cities`);
  if (!toCity)   throw new ApiError(400, `Destination city "${toCityName}" not found. Check GET /pricing/cities`);

  const matrix = await prisma.zoneMatrix.findUnique({
    where: { fromCityId_toCityId: { fromCityId: fromCity.id, toCityId: toCity.id } },
  });

  if (!matrix) throw new ApiError(400, `No route found between "${fromCityName}" and "${toCityName}"`);

  return { zone: matrix.zone, fromCity, toCity };
}

// ─── Distance lookup ──────────────────────────────────────────────────────────
async function getDistance(fromCityId, toCityId) {
  const km = await prisma.kmMatrix.findUnique({
    where: { fromCityId_toCityId: { fromCityId, toCityId } },
  });
  return km ? km.distanceKm : null;
}

// ─── Surcharge engine (Sprint 2) ──────────────────────────────────────────────
async function applySurcharges(basePrice, serviceType = 'STANDARD', options = {}) {
  const surcharges = await prisma.surcharge.findMany({
    where: {
      isActive: true,
      OR: [{ appliesTo: 'ALL' }, { appliesTo: serviceType }],
    },
  });

  const breakdown = [];
  let totalSurcharge = 0;

  for (const s of surcharges) {
    if (s.type === 'FRAGILE'   && !options.isFragile)         continue;
    if (s.type === 'INSURANCE' && !options.requiresInsurance) continue;

    let amount = 0;
    if (s.ratePercent) {
      amount = (s.type === 'INSURANCE' && options.insuranceValue)
        ? Math.ceil(options.insuranceValue * (s.ratePercent / 100))
        : Math.ceil(basePrice * (s.ratePercent / 100));
    } else if (s.flatAmount) {
      amount = s.flatAmount;
    }

    if (amount > 0) {
      breakdown.push({ type: s.type, label: s.label, description: s.description, amount });
      totalSurcharge += amount;
    }
  }

  return { breakdown, totalSurcharge };
}

// ─── Contract rate lookup (Sprint 2) ─────────────────────────────────────────
async function getContractRate(userId, serviceType) {
  if (!userId) return null;

  return prisma.contractRate.findFirst({
    where: {
      userId,
      isActive: true,
      OR: [{ serviceType }, { serviceType: null }],
      AND: [
        { OR: [{ validFrom: null }, { validFrom: { lte: new Date() } }] },
        { OR: [{ validUntil: null }, { validUntil: { gte: new Date() } }] },
      ],
    },
  });
}

// ─── Promo code validation (Sprint 2) ────────────────────────────────────────
async function validatePromoCode(code, userId, basePrice, serviceType) {
  if (!code) return null;

  const promo = await prisma.promoCode.findFirst({
    where: {
      code: { equals: code.trim(), mode: 'insensitive' },
      isActive: true,
      OR: [{ serviceType }, { serviceType: null }],
      AND: [
        { OR: [{ validFrom: null }, { validFrom: { lte: new Date() } }] },
        { OR: [{ validUntil: null }, { validUntil: { gte: new Date() } }] },
      ],
    },
  });

  if (!promo) throw new ApiError(400, 'Promo code is invalid or has expired');

  // Check usage limit
  if (promo.maxUses !== null && promo.usedCount >= promo.maxUses) {
    throw new ApiError(400, 'This promo code has reached its usage limit');
  }

  // Minimum order check
  if (promo.minOrderAmount && basePrice < promo.minOrderAmount) {
    throw new ApiError(400, `Minimum order of ₦${promo.minOrderAmount.toLocaleString()} required for code "${promo.code}"`);
  }

  // Check user hasn't already used this code (without a shipment — pending use)
  if (userId) {
    const alreadyUsed = await prisma.promoRedemption.findFirst({
      where: { promoCodeId: promo.id, userId, shipmentId: null },
    });
    if (alreadyUsed) throw new ApiError(400, `You have already used promo code "${promo.code}"`);
  }

  return promo;
}

// ─── Pricing priority engine (Sprint 2 spec) ──────────────────────────────────
// Priority: Individual Contract Rate > Promo Rate > Standard Rate
function applyPricingPriority({ basePrice, contractRate, promoCode, zone, weightKg }) {
  let finalBasePrice = basePrice;
  let appliedDiscount = null;
  let pricingMode = 'STANDARD';

  // 1. Contract rate — highest priority, enterprise client
  if (contractRate) {
    if (contractRate.fixedPricePerKgByZone) {
      const fixedRates = typeof contractRate.fixedPricePerKgByZone === 'string'
        ? JSON.parse(contractRate.fixedPricePerKgByZone)
        : contractRate.fixedPricePerKgByZone;

      const fixedPerKg = fixedRates[String(zone)];
      if (fixedPerKg) {
        const contractPrice = Math.ceil(parseFloat(fixedPerKg) * parseFloat(weightKg));
        appliedDiscount = {
          type: 'CONTRACT_FIXED',
          label: contractRate.label ? `Enterprise Rate — ${contractRate.label}` : 'Enterprise Rate',
          originalPrice: basePrice,
          discountAmount: Math.max(0, basePrice - contractPrice),
        };
        finalBasePrice = contractPrice;
        pricingMode = 'CONTRACT';
      }
    } else if (contractRate.discountPercent) {
      const discountAmt = Math.ceil(basePrice * (contractRate.discountPercent / 100));
      finalBasePrice = basePrice - discountAmt;
      appliedDiscount = {
        type: 'CONTRACT_PERCENT',
        label: contractRate.label
          ? `Enterprise Discount — ${contractRate.label} (${contractRate.discountPercent}% off)`
          : `Enterprise Discount (${contractRate.discountPercent}% off)`,
        originalPrice: basePrice,
        discountAmount: discountAmt,
        discountPercent: contractRate.discountPercent,
      };
      pricingMode = 'CONTRACT';
    }
  }

  // 2. Promo code — only when no contract rate applies
  if (!contractRate && promoCode) {
    if (promoCode.flatDiscount) {
      const discountAmt = Math.min(promoCode.flatDiscount, finalBasePrice);
      finalBasePrice = finalBasePrice - discountAmt;
      appliedDiscount = {
        type: 'PROMO_FLAT',
        label: `Promo Code "${promoCode.code.toUpperCase()}"`,
        originalPrice: basePrice,
        discountAmount: discountAmt,
      };
      pricingMode = 'PROMO';
    } else if (promoCode.discountPercent) {
      const discountAmt = Math.ceil(finalBasePrice * (promoCode.discountPercent / 100));
      finalBasePrice = finalBasePrice - discountAmt;
      appliedDiscount = {
        type: 'PROMO_PERCENT',
        label: `Promo Code "${promoCode.code.toUpperCase()}" (${promoCode.discountPercent}% off)`,
        originalPrice: basePrice,
        discountAmount: discountAmt,
        discountPercent: promoCode.discountPercent,
      };
      pricingMode = 'PROMO';
    }
  }

  return { finalBasePrice: Math.max(0, finalBasePrice), appliedDiscount, pricingMode };
}

// ─── MAIN CALCULATOR ─────────────────────────────────────────────────────────
async function calculateShippingCost({
  fromCity, toCity,
  weightKg, tons, cartons,
  boxDimensionId, customLength, customWidth, customHeight,
  serviceType = 'STANDARD',
  isFragile = false,
  requiresInsurance = false,
  insuranceValue = 0,
  promoCode: promoCodeStr = null,
  userId = null,
}) {
  // 1. Zone & distance
  const { zone, fromCity: from, toCity: to } = await getZone(fromCity, toCity);
  const distanceKm = await getDistance(from.id, to.id);

  // 2. Weight resolution — actual vs volumetric, higher wins, rounded to 0.5kg
  let resolvedWeightKg = weightKg ? parseFloat(weightKg) : null;

  if (!resolvedWeightKg && boxDimensionId) {
    const box = await prisma.boxDimension.findUnique({ where: { id: boxDimensionId } });
    if (box) {
      const volWeight = calcVolumetricWeight(box.lengthCm, box.widthCm, box.heightCm);
      resolvedWeightKg = Math.max(box.weightKgLimit, volWeight);
    }
  }

  if (!resolvedWeightKg && customLength && customWidth && customHeight) {
    resolvedWeightKg = calcVolumetricWeight(customLength, customWidth, customHeight);
  }

  if (!resolvedWeightKg && tons)    resolvedWeightKg = parseFloat(tons) * 1000;
  if (!resolvedWeightKg && cartons) resolvedWeightKg = parseFloat(cartons) * 15;

  if (!resolvedWeightKg || resolvedWeightKg <= 0) {
    throw new ApiError(400, 'Provide weight (weightKg, tons, cartons, or dimensions)');
  }

  resolvedWeightKg = roundHalf(resolvedWeightKg);

  // 3. Standard price band
  const priceBand = await prisma.priceBand.findFirst({
    where: {
      zone, serviceType, isActive: true,
      minKg: { lte: resolvedWeightKg },
      OR: [{ maxKg: { gte: resolvedWeightKg } }, { maxKg: null }],
    },
  }) || await prisma.priceBand.findFirst({
    where: {
      zone, isActive: true,
      minKg: { lte: resolvedWeightKg },
      OR: [{ maxKg: { gte: resolvedWeightKg } }, { maxKg: null }],
    },
  });

  if (!priceBand) {
    throw new ApiError(400, `No pricing available for zone ${zone} at ${resolvedWeightKg}kg`);
  }

  const standardBasePrice = priceBand.pricePerKg
    ? Math.ceil(priceBand.pricePerKg * resolvedWeightKg)
    : Math.ceil(priceBand.basePrice || 0);

  // 4. Contract rate (enterprise — only available to authenticated users)
  const contractRate = await getContractRate(userId, serviceType);

  // 5. Promo code (only for non-contract users)
  let promoRecord = null;
  if (!contractRate && promoCodeStr) {
    promoRecord = await validatePromoCode(promoCodeStr, userId, standardBasePrice, serviceType);
  }

  // 6. Apply priority: Contract > Promo > Standard
  const { finalBasePrice, appliedDiscount, pricingMode } = applyPricingPriority({
    basePrice: standardBasePrice,
    contractRate,
    promoCode: promoRecord,
    zone,
    weightKg: resolvedWeightKg,
  });

  // 7. Surcharges on top of discounted base price
  const { breakdown: surchargeBreakdown, totalSurcharge } = await applySurcharges(
    finalBasePrice, serviceType,
    { isFragile, requiresInsurance, insuranceValue }
  );

  const total = finalBasePrice + totalSurcharge;

  return {
    zone, distanceKm,
    weightKg: resolvedWeightKg,
    fromCity: { id: from.id, name: from.name, region: from.region, state: from.state },
    toCity:   { id: to.id,   name: to.name,   region: to.region,   state: to.state   },
    breakdown: {
      priceBandId:       priceBand.id,
      pricePerKg:        priceBand.pricePerKg,
      standardBasePrice,
      finalBasePrice,
    },
    pricingMode,      // "STANDARD" | "CONTRACT" | "PROMO"
    appliedDiscount,  // null for guests/standard; discount details for enterprise/promo
    surchargeBreakdown,
    totalSurcharge,
    total,
    currency: 'NGN',
  };
}

module.exports = {
  calculateShippingCost,
  getZone,
  getDistance,
  applySurcharges,
  calcVolumetricWeight,
  getContractRate,
  validatePromoCode,
};
