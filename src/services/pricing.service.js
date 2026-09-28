const { prisma } = require("../config/db");
const { ApiError } = require("../utils/ApiError");
const { evaluateRules } = require("./adhocCharge.service");

// ─── Volumetric weight (Sprint 1 spec) ────────────────────────────────────────
// Formula: (L × W × H) / divisor  →  rounded UP to nearest 0.5kg
// [V1 Feature 1] The divisor defaults to 5000 (1kg per 5000cm³) but is now
// configurable per shipment mode via ShipmentModeSetting — see
// getVolumetricDivisor below.
function calcVolumetricWeight(l, w, h, divisor = 5000) {
  const raw = (parseFloat(l) * parseFloat(w) * parseFloat(h)) / divisor;
  return Math.ceil(raw * 2) / 2;
}

// ─── [V1 Feature 1] Per-mode volumetric divisor + transit hours ──────────────
// Falls back to the pre-V1 default (5000) for any mode admin hasn't
// configured yet, or when no mode is given at all (legacy callers).
const DEFAULT_MODE_SETTINGS = { volumetricDivisor: 5000, transitHoursDefault: null };

async function getModeSetting(mode) {
  if (!mode) return DEFAULT_MODE_SETTINGS;
  const setting = await prisma.shipmentModeSetting.findUnique({ where: { mode } });
  return setting || DEFAULT_MODE_SETTINGS;
}

async function listModeSettings() {
  const modes = ["AIR", "LAND", "SEA"];
  const rows = await prisma.shipmentModeSetting.findMany();
  const byMode = Object.fromEntries(rows.map((r) => [r.mode, r]));
  return modes.map(
    (mode) =>
      byMode[mode] || { mode, ...DEFAULT_MODE_SETTINGS, isActive: true, id: null },
  );
}

function roundHalf(val) {
  return Math.ceil(parseFloat(val) * 2) / 2;
}

// ─── Delivery time estimate (zone + service-type aware) ───────────────────────
// Previously every "Delivery Time" shown anywhere in the app came from a
// single hardcoded frontend map (EXPRESS: "1-3 days" etc.) that never looked
// at zone or route at all — so an intra-city shipment (e.g. Abuja → Abuja)
// showed the exact same estimate as a genuinely cross-country one. There's
// a real DeliverySLA table (admin-configurable per zone+serviceType via the
// Rate Management > Delivery SLA tab) that was never actually queried by
// anything. This is now the single source of truth for delivery estimates.
//
// Fallback order:
//   1. Same city (fromCity === toCity) with no admin override configured →
//      fast built-in default, since same-city delivery should never look
//      like a cross-country trip regardless of which zone bucket it's in.
//   2. Whatever DeliverySLA row the admin configured for this zone+service.
//   3. Generic fallback matching the old static values, so a zone nobody's
//      configured yet doesn't show broken/missing data.
const SAME_CITY_DEFAULT = {
  EXPRESS: { minDays: 1, maxDays: 1 },
  STANDARD: { minDays: 1, maxDays: 2 },
  ECONOMY: { minDays: 2, maxDays: 3 },
};
const GENERIC_FALLBACK = {
  EXPRESS: { minDays: 1, maxDays: 3 },
  STANDARD: { minDays: 5, maxDays: 7 },
  ECONOMY: { minDays: 10, maxDays: 14 },
};

function formatDeliveryLabel(minDays, maxDays) {
  if (minDays === maxDays) {
    return `${minDays} business day${minDays === 1 ? "" : "s"}`;
  }
  return `${minDays}-${maxDays} business days`;
}

async function getDeliveryEstimate(
  zone,
  serviceType,
  { isSameCity = false } = {},
) {
  const configured = await prisma.deliverySLA.findUnique({
    where: { zone_serviceType: { zone, serviceType } },
  });

  if (configured) {
    return {
      minDays: configured.minDays,
      maxDays: configured.maxDays,
      label:
        configured.label ||
        formatDeliveryLabel(configured.minDays, configured.maxDays),
      source: "CONFIGURED",
    };
  }

  const fallback = isSameCity
    ? SAME_CITY_DEFAULT[serviceType] || SAME_CITY_DEFAULT.STANDARD
    : GENERIC_FALLBACK[serviceType] || GENERIC_FALLBACK.STANDARD;

  return {
    minDays: fallback.minDays,
    maxDays: fallback.maxDays,
    label: formatDeliveryLabel(fallback.minDays, fallback.maxDays),
    source: isSameCity ? "SAME_CITY_DEFAULT" : "GENERIC_FALLBACK",
  };
}

// ─── Zone lookup ──────────────────────────────────────────────────────────────
async function getZone(fromCityName, toCityName) {
  const [fromCity, toCity] = await Promise.all([
    prisma.city.findFirst({
      where: { name: { equals: fromCityName, mode: "insensitive" } },
    }),
    prisma.city.findFirst({
      where: { name: { equals: toCityName, mode: "insensitive" } },
    }),
  ]);

  if (!fromCity)
    throw new ApiError(
      400,
      `Origin city "${fromCityName}" not found. Check GET /pricing/cities`,
    );
  if (!toCity)
    throw new ApiError(
      400,
      `Destination city "${toCityName}" not found. Check GET /pricing/cities`,
    );

  // Only use active routes — paused routes are excluded from pricing
  const matrix = await prisma.zoneMatrix.findFirst({
    where: {
      fromCityId: fromCity.id,
      toCityId: toCity.id,
      isActive: true,
    },
  });

  if (!matrix) {
    // Check if the route exists but is paused
    const paused = await prisma.zoneMatrix.findFirst({
      where: { fromCityId: fromCity.id, toCityId: toCity.id, isActive: false },
    });
    if (paused) {
      throw new ApiError(
        400,
        `Route "${fromCityName}" → "${toCityName}" is temporarily unavailable. Please contact support.`,
      );
    }
    throw new ApiError(
      400,
      `No route found between "${fromCityName}" and "${toCityName}". This city pair has not been configured yet.`,
    );
  }

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
async function applySurcharges(
  basePrice,
  serviceType = "STANDARD",
  options = {},
) {
  const surcharges = await prisma.surcharge.findMany({
    where: {
      isActive: true,
      OR: [{ appliesTo: "ALL" }, { appliesTo: serviceType }],
    },
  });

  const breakdown = [];
  let totalSurcharge = 0;

  // [V1 Features 5/6] Adhoc charges (AUTO_APPLY only — SUGGEST charges never
  // touch the customer's total). Each is its own named breakdown line with
  // its trigger reason, same as the PRD requires on quote/review/invoice.
  const adhocCharges = options.adhocCharges || [];
  for (const a of adhocCharges) {
    breakdown.push({
      type: "ADHOC",
      label: `Added automatically: ${a.name}`,
      description: a.reason,
      amount: a.amountNaira,
      vatApplicable: a.vatApplicable,
    });
    totalSurcharge += a.amountNaira;
  }
  const adhocTaxableNaira = adhocCharges
    .filter((a) => a.vatApplicable)
    .reduce((sum, a) => sum + a.amountNaira, 0);

  // ── Pass 1: all non-VAT surcharges ────────────────────────────────────────
  // PRD Sprint 1 formula: VAT = (base_price + fuel_surcharge + remote_area_fee)
  // × rate. Insurance premium is explicitly NOT subject to VAT, so VAT must be
  // computed AFTER fuel/remote amounts are known — not as a flat % of base.
  for (const s of surcharges) {
    if (s.type === "VAT") continue; // handled in pass 2
    if (s.type === "FRAGILE" && !options.isFragile) continue;
    if (s.type === "INSURANCE" && !options.requiresInsurance) continue;

    let amount = 0;
    if (s.ratePercent) {
      amount =
        s.type === "INSURANCE" && options.insuranceValue
          ? Math.ceil(options.insuranceValue * (s.ratePercent / 100))
          : Math.ceil(basePrice * (s.ratePercent / 100));
    } else if (s.flatAmount) {
      amount = s.flatAmount;
    }

    if (amount > 0) {
      breakdown.push({
        type: s.type,
        label: s.label,
        description: s.description,
        amount,
      });
      totalSurcharge += amount;
    }
  }

  // ── Pass 2: VAT on (base + fuel + remote area + taxable adhoc) only ──────
  const vatRow = surcharges.find((s) => s.type === "VAT");
  if (vatRow) {
    const fuelAmount = breakdown.find((b) => b.type === "FUEL")?.amount || 0;
    const remoteAmount =
      breakdown.find((b) => b.type === "REMOTE_AREA")?.amount || 0;
    // [V1] Updated price formula: VAT = ROUND((base + fuel + remote +
    // taxable adhoc) × rate). Insurance premium stays outside VAT entirely.
    const vatBase = basePrice + fuelAmount + remoteAmount + adhocTaxableNaira;

    let vatAmount = 0;
    if (vatRow.ratePercent) {
      vatAmount = Math.round(vatBase * (vatRow.ratePercent / 100));
    } else if (vatRow.flatAmount) {
      vatAmount = vatRow.flatAmount;
    }

    if (vatAmount > 0) {
      breakdown.push({
        type: vatRow.type,
        label: vatRow.label,
        description: vatRow.description,
        amount: vatAmount,
      });
      totalSurcharge += vatAmount;
    }
  }

  return { breakdown, totalSurcharge };
}

// ─── Contract rate lookup (Sprint 2) ─────────────────────────────────────────
// Priority: user's own rate first, then their org master's rate (enterprise).
// This means assigning a contract rate to a ROLE_MASTER user automatically
// applies it to all their team members — matching the PRD requirement:
// "A logged-in Enterprise Client sees a different (lower) price than a Guest."
async function getContractRate(userId, serviceType) {
  if (!userId) return null;

  const rateWhere = (targetId) => ({
    userId: targetId,
    isActive: true,
    OR: [{ serviceType }, { serviceType: null }],
    AND: [
      { OR: [{ validFrom: null }, { validFrom: { lte: new Date() } }] },
      { OR: [{ validUntil: null }, { validUntil: { gte: new Date() } }] },
    ],
  });

  // 1. Check for a rate assigned directly to this user
  const directRate = await prisma.contractRate.findFirst({
    where: rateWhere(userId),
  });
  if (directRate) return directRate;

  // 2. Check if the user belongs to an org — if so, use the master's rate
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { masterId: true },
  });
  if (user?.masterId) {
    const orgRate = await prisma.contractRate.findFirst({
      where: rateWhere(user.masterId),
    });
    if (orgRate) return orgRate;
  }

  return null;
}

// ─── Promo code validation (Sprint 2) ────────────────────────────────────────
async function validatePromoCode(code, userId, basePrice, serviceType) {
  if (!code) return null;

  const promo = await prisma.promoCode.findFirst({
    where: {
      code: { equals: code.trim(), mode: "insensitive" },
      isActive: true,
      OR: [{ serviceType }, { serviceType: null }],
      AND: [
        { OR: [{ validFrom: null }, { validFrom: { lte: new Date() } }] },
        { OR: [{ validUntil: null }, { validUntil: { gte: new Date() } }] },
      ],
    },
  });

  if (!promo) throw new ApiError(400, "Promo code is invalid or has expired");

  // Check usage limit
  if (promo.maxUses !== null && promo.usedCount >= promo.maxUses) {
    throw new ApiError(400, "This promo code has reached its usage limit");
  }

  // Minimum order check
  if (promo.minOrderAmount && basePrice < promo.minOrderAmount) {
    throw new ApiError(
      400,
      `Minimum order of ₦${promo.minOrderAmount.toLocaleString()} required for code "${promo.code}"`,
    );
  }

  // Check user hasn't already used this code (without a shipment — pending use)
  if (userId) {
    const alreadyUsed = await prisma.promoRedemption.findFirst({
      where: { promoCodeId: promo.id, userId, shipmentId: null },
    });
    if (alreadyUsed)
      throw new ApiError(
        400,
        `You have already used promo code "${promo.code}"`,
      );
  }

  return promo;
}

// ─── Pricing priority engine (Sprint 2 spec) ──────────────────────────────────
// Priority: Individual Contract Rate > Promo Rate > Standard Rate
function applyPricingPriority({
  basePrice,
  contractRate,
  promoCode,
  zone,
  weightKg,
}) {
  let finalBasePrice = basePrice;
  let appliedDiscount = null;
  let pricingMode = "STANDARD";

  // 1. Contract rate — highest priority, enterprise client
  if (contractRate) {
    if (contractRate.fixedPricePerKgByZone) {
      const fixedRates =
        typeof contractRate.fixedPricePerKgByZone === "string"
          ? JSON.parse(contractRate.fixedPricePerKgByZone)
          : contractRate.fixedPricePerKgByZone;

      const fixedPerKg = fixedRates[String(zone)];
      if (fixedPerKg) {
        const contractPrice = Math.ceil(
          parseFloat(fixedPerKg) * parseFloat(weightKg),
        );
        appliedDiscount = {
          type: "CONTRACT_FIXED",
          label: contractRate.label
            ? `Enterprise Rate — ${contractRate.label}`
            : "Enterprise Rate",
          originalPrice: basePrice,
          discountAmount: Math.max(0, basePrice - contractPrice),
        };
        finalBasePrice = contractPrice;
        pricingMode = "CONTRACT";
      }
    } else if (contractRate.discountPercent) {
      const discountAmt = Math.ceil(
        basePrice * (contractRate.discountPercent / 100),
      );
      finalBasePrice = basePrice - discountAmt;
      appliedDiscount = {
        type: "CONTRACT_PERCENT",
        label: contractRate.label
          ? `Enterprise Discount — ${contractRate.label} (${contractRate.discountPercent}% off)`
          : `Enterprise Discount (${contractRate.discountPercent}% off)`,
        originalPrice: basePrice,
        discountAmount: discountAmt,
        discountPercent: contractRate.discountPercent,
      };
      pricingMode = "CONTRACT";
    }
  }

  // 2. Promo code — only when no contract rate applies
  if (!contractRate && promoCode) {
    if (promoCode.flatDiscount) {
      const discountAmt = Math.min(promoCode.flatDiscount, finalBasePrice);
      finalBasePrice = finalBasePrice - discountAmt;
      appliedDiscount = {
        type: "PROMO_FLAT",
        label: `Promo Code "${promoCode.code.toUpperCase()}"`,
        originalPrice: basePrice,
        discountAmount: discountAmt,
      };
      pricingMode = "PROMO";
    } else if (promoCode.discountPercent) {
      const discountAmt = Math.ceil(
        finalBasePrice * (promoCode.discountPercent / 100),
      );
      finalBasePrice = finalBasePrice - discountAmt;
      appliedDiscount = {
        type: "PROMO_PERCENT",
        label: `Promo Code "${promoCode.code.toUpperCase()}" (${promoCode.discountPercent}% off)`,
        originalPrice: basePrice,
        discountAmount: discountAmt,
        discountPercent: promoCode.discountPercent,
      };
      pricingMode = "PROMO";
    }
  }

  return {
    finalBasePrice: Math.max(0, finalBasePrice),
    appliedDiscount,
    pricingMode,
  };
}

// ─── MAIN CALCULATOR ─────────────────────────────────────────────────────────
async function calculateShippingCost({
  fromCity,
  toCity,
  weightKg,
  tons,
  cartons,
  boxDimensionId,
  customLength,
  customWidth,
  customHeight,
  serviceType = "STANDARD",
  // [V1 Feature 1] Mode of shipment. Defaults to LAND so every pre-existing
  // caller (price adjustments, legacy bookings) behaves exactly as before.
  shipmentMode = "LAND",
  isFragile = false,
  requiresInsurance = false,
  insuranceValue = 0,
  promoCode: promoCodeStr = null,
  userId = null,
}) {
  // 1. Zone & distance
  const { zone, fromCity: from, toCity: to } = await getZone(fromCity, toCity);
  const distanceKm = await getDistance(from.id, to.id);

  // [V1] Per-mode volumetric divisor (default 5000, admin-configurable).
  const modeSetting = await getModeSetting(shipmentMode);
  const volumetricDivisor = modeSetting.volumetricDivisor || 5000;

  // 2. Weight resolution — actual vs volumetric, higher wins, rounded to 0.5kg
  // Tracked separately (in addition to the merged `resolvedWeightKg` used for
  // pricing) so adhoc-charge rules can key on the specific metric they need
  // — see adhocCharge.service.js#computeMetrics.
  let resolvedWeightKg = weightKg ? parseFloat(weightKg) : null;
  let actualWeightKg = weightKg ? parseFloat(weightKg) : null;
  let volumetricWeightKg = null;
  let dims = { lengthCm: customLength || null, widthCm: customWidth || null, heightCm: customHeight || null };

  if (!resolvedWeightKg && boxDimensionId) {
    const box = await prisma.boxDimension.findUnique({
      where: { id: boxDimensionId },
    });
    if (box) {
      const volWeight = calcVolumetricWeight(
        box.lengthCm,
        box.widthCm,
        box.heightCm,
        volumetricDivisor,
      );
      volumetricWeightKg = volWeight;
      dims = { lengthCm: box.lengthCm, widthCm: box.widthCm, heightCm: box.heightCm };
      const perBoxWeight = Math.max(box.weightKgLimit, volWeight);

      // If `cartons` was also provided alongside a box selection, treat it
      // as the BOX QUANTITY and scale the total weight accordingly.
      // e.g. a 12kg-limit box × 20 cartons = 240kg total, not 12kg.
      // Without this, cartons was silently discarded whenever a box was
      // selected, leaving the total weight at a single box's weight — which
      // can fall below every price band's minimum and throw
      // "No pricing available for zone X at Ykg".
      const boxQuantity = cartons ? Math.max(1, parseInt(cartons, 10)) : 1;
      resolvedWeightKg = perBoxWeight * boxQuantity;
      actualWeightKg = box.weightKgLimit * boxQuantity;
    }
  }

  if (!resolvedWeightKg && customLength && customWidth && customHeight) {
    volumetricWeightKg = calcVolumetricWeight(
      customLength,
      customWidth,
      customHeight,
      volumetricDivisor,
    );
    resolvedWeightKg = volumetricWeightKg;
  } else if (customLength && customWidth && customHeight && !volumetricWeightKg) {
    // Dimensions provided alongside an explicit weightKg — still compute the
    // volumetric figure for adhoc-rule metrics (VOLUME_CM3 / LONGEST_SIDE /
    // VOLUMETRIC_WEIGHT), even though actual weight already won on price.
    volumetricWeightKg = calcVolumetricWeight(
      customLength,
      customWidth,
      customHeight,
      volumetricDivisor,
    );
  }

  if (!resolvedWeightKg && tons) resolvedWeightKg = parseFloat(tons) * 1000;
  if (!resolvedWeightKg && cartons) resolvedWeightKg = parseFloat(cartons) * 15;

  if (!resolvedWeightKg || resolvedWeightKg <= 0) {
    throw new ApiError(
      400,
      "Provide weight (weightKg, tons, cartons, or dimensions)",
    );
  }

  resolvedWeightKg = roundHalf(resolvedWeightKg);

  // 3. Standard price band — [V1] now also scoped to shipment mode. Falls
  // back to a mode-agnostic match only for legacy bands that predate V1 (see
  // PriceBand.shipmentMode migration default of LAND).
  const priceBand =
    (await prisma.priceBand.findFirst({
      where: {
        zone,
        serviceType,
        shipmentMode,
        isActive: true,
        minKg: { lte: resolvedWeightKg },
        OR: [{ maxKg: { gte: resolvedWeightKg } }, { maxKg: null }],
      },
    })) ||
    (await prisma.priceBand.findFirst({
      where: {
        zone,
        shipmentMode,
        isActive: true,
        minKg: { lte: resolvedWeightKg },
        OR: [{ maxKg: { gte: resolvedWeightKg } }, { maxKg: null }],
      },
    }));

  if (!priceBand) {
    // [V1 Feature 1] "Rate lookup includes the mode. If no rate exists:
    // 404 'Rate not found for [mode]'."
    throw new ApiError(
      404,
      `Rate not found for ${shipmentMode} — no pricing available for zone ${zone} at ${resolvedWeightKg}kg`,
    );
  }

  const standardBasePrice = priceBand.pricePerKg
    ? Math.ceil(priceBand.pricePerKg * resolvedWeightKg)
    : Math.ceil(priceBand.basePrice || 0);

  // 4. Contract rate (enterprise — only available to authenticated users)
  const contractRate = await getContractRate(userId, serviceType);

  // 5. Promo code (only for non-contract users)
  let promoRecord = null;
  if (!contractRate && promoCodeStr) {
    promoRecord = await validatePromoCode(
      promoCodeStr,
      userId,
      standardBasePrice,
      serviceType,
    );
  }

  // 6. Apply priority: Contract > Promo > Standard
  const { finalBasePrice, appliedDiscount, pricingMode } = applyPricingPriority(
    {
      basePrice: standardBasePrice,
      contractRate,
      promoCode: promoRecord,
      zone,
      weightKg: resolvedWeightKg,
    },
  );

  // 7. [V1 Features 5/6] Adhoc charges — AUTO_APPLY rules matched against
  // this parcel's measurements land on the total now; SUGGEST matches never
  // affect price here (they only ever reach a customer after an admin
  // decision — see adhocCharge.service.js). Rules are evaluated again (and
  // persisted) by quote.controller.js once the Quote row exists, using the
  // same measurements, so the numbers here and what gets saved always match.
  const measurements = {
    actualWeightKg,
    volumetricWeightKg,
    billableWeightKg: resolvedWeightKg,
    lengthCm: dims.lengthCm,
    widthCm: dims.widthCm,
    heightCm: dims.heightCm,
  };
  const { autoApply: autoApplyAdhoc } = await evaluateRules({
    shipmentMode,
    measurements,
    basePriceKobo: Math.round(finalBasePrice * 100),
  });
  const adhocChargesForSurcharge = autoApplyAdhoc.map((a) => ({
    name: a.chargeType.name,
    reason: a.reason,
    amountNaira: a.amountKobo / 100,
    vatApplicable: a.chargeType.vatApplicable,
  }));
  const adhocTotalNaira = adhocChargesForSurcharge.reduce(
    (sum, a) => sum + a.amountNaira,
    0,
  );

  // 8. Surcharges on top of discounted base price
  // Auto-calculate insuranceValue if requiresInsurance but no value provided.
  // Business rule: insure at 110% of the final base price (declared goods value estimate).
  const resolvedInsuranceValue =
    requiresInsurance && (!insuranceValue || insuranceValue <= 0)
      ? Math.ceil(finalBasePrice * 1.1)
      : insuranceValue;

  const { breakdown: surchargeBreakdown, totalSurcharge } =
    await applySurcharges(finalBasePrice, serviceType, {
      isFragile,
      requiresInsurance,
      insuranceValue: resolvedInsuranceValue,
      adhocCharges: adhocChargesForSurcharge,
    });

  const total = finalBasePrice + totalSurcharge;

  const deliveryEstimate = await getDeliveryEstimate(zone, serviceType, {
    isSameCity: from.id === to.id,
  });

  return {
    zone,
    distanceKm,
    weightKg: resolvedWeightKg,
    shipmentMode,
    transitHours: modeSetting.transitHoursDefault,
    // [V1] Exposed so callers that persist a Quote (quote.controller.js) can
    // re-run the adhoc rule engine against the exact same measurements when
    // writing ShipmentAdhocCharge rows, without recomputing weight/dims.
    measurements,
    fromCity: {
      id: from.id,
      name: from.name,
      region: from.region,
      state: from.state,
    },
    toCity: { id: to.id, name: to.name, region: to.region, state: to.state },
    breakdown: {
      priceBandId: priceBand.id,
      pricePerKg: priceBand.pricePerKg,
      standardBasePrice,
      finalBasePrice,
    },
    pricingMode, // "STANDARD" | "CONTRACT" | "PROMO"
    appliedDiscount, // null for guests/standard; discount details for enterprise/promo
    surchargeBreakdown,
    totalSurcharge,
    // [V1] Adhoc charges as computed at this moment — for informational
    // display before a Quote row exists (e.g. the /pricing/quote preview).
    // The persisted, authoritative lines live on ShipmentAdhocCharge once a
    // real Quote is generated via POST /quotes.
    adhocCharges: adhocChargesForSurcharge,
    adhocTotalNaira,
    total,
    currency: "NGN",
    deliveryEstimate, // { minDays, maxDays, label, source } — zone+service-aware, see getDeliveryEstimate
    // Insurance: resolved value used for calculation (auto-calculated if not provided)
    insuranceValue: requiresInsurance ? resolvedInsuranceValue : null,
    insuranceAutoCalculated:
      requiresInsurance && (!insuranceValue || insuranceValue <= 0),
  };
}

const MODE_LABELS = { AIR: "Air", LAND: "Land", SEA: "Sea" };

// [V1 Feature 1] A mode admin has switched off (Shipment Mode Settings ->
// Inactive) must stop being bookable everywhere — not just hidden in one
// form. A mode with no settings row yet is treated as active.
async function assertModeActive(mode) {
  if (!mode) return;
  const setting = await prisma.shipmentModeSetting.findUnique({ where: { mode } });
  if (setting && setting.isActive === false) {
    throw new ApiError(
      400,
      `${MODE_LABELS[mode] || mode} shipping is currently unavailable. Please choose another mode of shipment.`,
    );
  }
}

module.exports = {
  assertModeActive,
  calculateShippingCost,
  getZone,
  getDistance,
  applySurcharges,
  calcVolumetricWeight,
  getContractRate,
  validatePromoCode,
  getDeliveryEstimate,
  getModeSetting,
  listModeSettings,
};
