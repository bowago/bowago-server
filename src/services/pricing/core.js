// ─── src/services/pricing/core.js ────────────────────────────────────────────
// PURE pricing domain logic — no database, no I/O. Everything here takes plain
// data and returns plain data, so the whole cross-product (mode × service ×
// zone × weight × adjustments) can be unit-tested without a database.
//
// The pipeline implemented by evaluateOffering():
//
//   billable weight (mode-specific volumetric divisor)
//     → offering eligibility (mode/offering active, lane, weight, dimensions)
//     → delivery promise   (SLA for zone + mode + service — never a fallback)
//     → standard rate      (band for zone + mode + service + weight + validity)
//     → contract / promo   (explicit mode & service scope)
//     → surcharges
//     → ad-hoc charges
//     → insurance + tax    (tax base: base + fuel + remote + taxable ad-hoc)
//     → total              (integer kobo; total === sum of components, always)
//
// Money is computed as integer KOBO so the persisted quote, the customer
// breakdown and the payment amount can never disagree by a rounding error.

const { ApiError } = require("../../utils/ApiError");

const CARTON_DEFAULT_KG = 15; // legacy rule: 1 carton ≈ 15kg when nothing else is given
const GAP_TOLERANCE_KG = 1; // weights falling in a <=1kg gap between integer bands go to the upper band
const DEFAULT_VOLUMETRIC_DIVISOR = 5000;
const TAXABLE_SURCHARGE_TYPES = new Set(["FUEL", "REMOTE_AREA"]); // PRD: VAT on base + fuel + remote area (+ taxable ad-hoc)

// ─── Numeric helpers ─────────────────────────────────────────────────────────
const toKobo = (naira) => Math.round(Number(naira) * 100);
const fromKobo = (kobo) => Math.round(kobo) / 100;
// Guards float noise (e.g. 300.00000000000006 must not become 301).
const ceilMoney = (x) => Math.ceil(Number(Number(x).toFixed(6)));
const roundHalf = (v) => Math.ceil(Number((Number(v) * 2).toFixed(6))) / 2;

function calcVolumetricWeight(l, w, h, divisor = DEFAULT_VOLUMETRIC_DIVISOR) {
  const raw = (parseFloat(l) * parseFloat(w) * parseFloat(h)) / (divisor || DEFAULT_VOLUMETRIC_DIVISOR);
  return Math.ceil(Number((raw * 2).toFixed(6))) / 2;
}

const positive = (v) => v !== null && v !== undefined && v !== "" && Number(v) > 0;

// ─── Billable weight ─────────────────────────────────────────────────────────
// actual  : weightKg | box limit × qty | tons | cartons × 15
// volumetric: dimensions (custom, else box × qty) / mode divisor
// billable: max(actual, volumetric), rounded UP to 0.5kg
function resolveMeasurements(input, divisor = DEFAULT_VOLUMETRIC_DIVISOR) {
  const { weightKg, tons, cartons, box, customLength, customWidth, customHeight } = input;
  const boxQty = box ? Math.max(1, parseInt(cartons, 10) || 1) : 1;

  let actual = null;
  if (positive(weightKg)) actual = parseFloat(weightKg);
  else if (box && positive(box.weightKgLimit)) actual = box.weightKgLimit * boxQty;
  else if (positive(tons)) actual = parseFloat(tons) * 1000;
  else if (positive(cartons)) actual = parseFloat(cartons) * CARTON_DEFAULT_KG;

  let dims = null;
  let dimMultiplier = 1;
  if (positive(customLength) && positive(customWidth) && positive(customHeight)) {
    dims = { lengthCm: parseFloat(customLength), widthCm: parseFloat(customWidth), heightCm: parseFloat(customHeight) };
  } else if (box && positive(box.lengthCm) && positive(box.widthCm) && positive(box.heightCm)) {
    dims = { lengthCm: box.lengthCm, widthCm: box.widthCm, heightCm: box.heightCm };
    dimMultiplier = boxQty;
  }

  const volumetric = dims
    ? calcVolumetricWeight(dims.lengthCm, dims.widthCm, dims.heightCm, divisor) * dimMultiplier
    : null;

  const heaviest = Math.max(actual || 0, volumetric || 0);
  if (heaviest <= 0) {
    throw new ApiError(400, "Provide weight (weightKg, tons, cartons, or dimensions)", null, "WEIGHT_REQUIRED");
  }

  return {
    actualWeightKg: actual,
    volumetricWeightKg: volumetric,
    billableWeightKg: roundHalf(heaviest),
    lengthCm: dims?.lengthCm ?? null,
    widthCm: dims?.widthCm ?? null,
    heightCm: dims?.heightCm ?? null,
    volumetricDivisor: divisor || DEFAULT_VOLUMETRIC_DIVISOR,
  };
}

// ─── Rate resolution ─────────────────────────────────────────────────────────
function parseFixedMap(band) {
  const raw = band.fixedPricePerKgByZone;
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return typeof raw === "object" ? raw : null;
}

// Zones a band can price: its own zone, or every key of its fixed-price map.
function bandZones(band) {
  const zones = new Set();
  if (band.zone !== null && band.zone !== undefined) zones.add(Number(band.zone));
  const map = parseFixedMap(band);
  if (map) for (const [z, v] of Object.entries(map)) if (positive(v)) zones.add(Number(z));
  return [...zones];
}

// The price a band yields for (zone, weight), or null if the band has no usable
// price for that zone. A ₦0 placeholder is NOT a price.
function bandPrice(band, zone, weightKg) {
  const own = band.zone !== null && band.zone !== undefined && Number(band.zone) === Number(zone);
  if (own && positive(band.pricePerKg)) {
    return { amount: ceilMoney(band.pricePerKg * weightKg), source: "BAND_PER_KG", perKg: Number(band.pricePerKg) };
  }
  const map = parseFixedMap(band);
  const fixed = map ? map[String(zone)] : null;
  if ((band.zone === null || band.zone === undefined || own) && positive(fixed)) {
    return { amount: ceilMoney(fixed * weightKg), source: "BAND_FIXED_ZONE", perKg: Number(fixed) };
  }
  if (own && positive(band.basePrice)) {
    return { amount: ceilMoney(band.basePrice), source: "BAND_FLAT", perKg: null };
  }
  return null;
}

const validAt = (row, now) =>
  (!row.validFrom || new Date(row.validFrom) <= now) && (!row.validUntil || new Date(row.validUntil) >= now);

// Picks the rate for ONE product. Never crosses mode or service.
function selectBand(bands, { zone, weightKg, mode, service, now = new Date() }) {
  const usable = [];
  for (const band of bands) {
    if (!band.isActive) continue;
    if (band.shipmentMode !== mode || band.serviceType !== service) continue;
    if (!validAt(band, now)) continue;
    const price = bandPrice(band, zone, weightKg);
    if (!price) continue; // no usable price for this zone (₦0 placeholders land here)
    usable.push({ band, price, exactZone: Number(band.zone) === Number(zone) && band.zone !== null });
  }

  const inRange = (b) => b.minKg <= weightKg && (b.maxKg === null || b.maxKg === undefined || weightKg <= b.maxKg);
  const exact = usable.filter((u) => inRange(u.band));
  const rank = (a, b) =>
    Number(b.exactZone) - Number(a.exactZone) ||
    b.band.minKg - a.band.minKg ||
    new Date(b.band.updatedAt || 0) - new Date(a.band.updatedAt || 0);

  if (exact.length) {
    const chosen = exact.sort(rank)[0];
    return { band: chosen.band, ...chosen.price, gapResolved: false };
  }

  // Gap tolerance: integer ranges (50–200 / 201–500) leave a hole for 200.5kg.
  const above = usable.filter((u) => u.band.minKg > weightKg).sort((a, b) => a.band.minKg - b.band.minKg);
  if (above.length && above[0].band.minKg - weightKg <= GAP_TOLERANCE_KG) {
    return { band: above[0].band, ...above[0].price, gapResolved: true };
  }
  return null;
}

// ─── Commercial pricing: contract > promo > standard ─────────────────────────
const modeMatches = (scope, mode) => scope === null || scope === undefined || scope === mode;

function specificity(c) {
  return (c.shipmentMode ? 2 : 0) + (c.serviceType ? 1 : 0);
}

function contractCandidates(contracts, { mode, service, now }) {
  return contracts
    .filter((c) => c.isActive !== false && validAt(c, now))
    .filter((c) => modeMatches(c.shipmentMode, mode) && modeMatches(c.serviceType, service))
    // A fixed ₦/kg card without a mode is ambiguous — never guess a mode for it.
    .filter((c) => !(parseFixedMap({ fixedPricePerKgByZone: c.fixedPricePerKgByZone }) && !c.shipmentMode))
    .sort(
      (a, b) =>
        (a.ownerRank ?? 0) - (b.ownerRank ?? 0) ||
        specificity(b) - specificity(a) ||
        new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0),
    );
}

function tryContract(c, { standardBase, zone, weightKg }) {
  const fixedMap = parseFixedMap({ fixedPricePerKgByZone: c.fixedPricePerKgByZone });
  const label = c.label ? `Enterprise Rate — ${c.label}` : "Enterprise Rate";
  if (fixedMap) {
    const perKg = fixedMap[String(zone)];
    if (!positive(perKg)) return null; // contract does not cover this zone
    const price = ceilMoney(perKg * weightKg);
    return {
      finalBase: price,
      appliedDiscount: {
        type: "CONTRACT_FIXED",
        label,
        originalPrice: standardBase,
        discountAmount: Math.max(0, standardBase - price),
      },
    };
  }
  if (positive(c.discountPercent)) {
    const amt = ceilMoney(standardBase * (c.discountPercent / 100));
    return {
      finalBase: Math.max(0, standardBase - amt),
      appliedDiscount: {
        type: "CONTRACT_PERCENT",
        label: c.label
          ? `Enterprise Discount — ${c.label} (${c.discountPercent}% off)`
          : `Enterprise Discount (${c.discountPercent}% off)`,
        originalPrice: standardBase,
        discountAmount: amt,
        discountPercent: c.discountPercent,
      },
    };
  }
  return null;
}

function applyCommercial({ standardBase, zone, weightKg, mode, service, contracts = [], promo = null, now = new Date() }) {
  for (const c of contractCandidates(contracts, { mode, service, now })) {
    const r = tryContract(c, { standardBase, zone, weightKg });
    if (r) return { ...r, pricingMode: "CONTRACT", contractRateId: c.id, promoStatus: promo ? { status: "SKIPPED_CONTRACT" } : null };
  }

  if (promo) {
    if (!modeMatches(promo.shipmentMode, mode) || !modeMatches(promo.serviceType, service)) {
      return {
        finalBase: standardBase, appliedDiscount: null, pricingMode: "STANDARD",
        promoStatus: { status: "NOT_APPLICABLE", message: `Promo code "${promo.code}" does not apply to this shipping option` },
      };
    }
    if (promo.minOrderAmount && standardBase < promo.minOrderAmount) {
      return {
        finalBase: standardBase, appliedDiscount: null, pricingMode: "STANDARD",
        promoStatus: {
          status: "BELOW_MIN_ORDER",
          message: `Minimum order of ₦${promo.minOrderAmount.toLocaleString()} required for code "${promo.code}"`,
        },
      };
    }
    if (positive(promo.flatDiscount)) {
      const amt = Math.min(promo.flatDiscount, standardBase);
      return {
        finalBase: standardBase - amt,
        appliedDiscount: { type: "PROMO_FLAT", label: `Promo Code "${promo.code.toUpperCase()}"`, originalPrice: standardBase, discountAmount: amt },
        pricingMode: "PROMO", promoStatus: { status: "APPLIED" },
      };
    }
    if (positive(promo.discountPercent)) {
      const amt = ceilMoney(standardBase * (promo.discountPercent / 100));
      return {
        finalBase: Math.max(0, standardBase - amt),
        appliedDiscount: {
          type: "PROMO_PERCENT",
          label: `Promo Code "${promo.code.toUpperCase()}" (${promo.discountPercent}% off)`,
          originalPrice: standardBase, discountAmount: amt, discountPercent: promo.discountPercent,
        },
        pricingMode: "PROMO", promoStatus: { status: "APPLIED" },
      };
    }
  }
  return { finalBase: standardBase, appliedDiscount: null, pricingMode: "STANDARD", promoStatus: null };
}

// ─── Surcharges / tax / insurance ────────────────────────────────────────────
// `appliesTo` is a comma list of tokens: ALL | EXPRESS|STANDARD|ECONOMY | AIR|LAND|SEA.
// (It used to be compared as one exact string, so "STANDARD,ECONOMY" never matched.)
function surchargeApplies(appliesTo, mode, service) {
  if (!appliesTo) return false;
  const tokens = String(appliesTo).split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
  return tokens.includes("ALL") || tokens.includes(service) || tokens.includes(mode);
}

function computeSurcharges(surcharges, { finalBase, mode, service, isFragile }) {
  const lines = [];
  for (const s of surcharges) {
    if (!s.isActive) continue;
    if (s.type === "VAT" || s.type === "INSURANCE") continue; // VAT: tax stage. INSURANCE: settings-driven premium.
    if (!surchargeApplies(s.appliesTo, mode, service)) continue;
    if (s.type === "FRAGILE" && !isFragile) continue;
    let amount = 0;
    if (positive(s.ratePercent)) amount = ceilMoney(finalBase * (s.ratePercent / 100));
    else if (positive(s.flatAmount)) amount = Number(s.flatAmount);
    if (amount <= 0) continue;
    lines.push({
      type: s.type,
      label: s.label,
      description: s.description || null,
      amount,
      amountKobo: toKobo(amount),
      vatApplicable: TAXABLE_SURCHARGE_TYPES.has(s.type),
      category: "SURCHARGE",
    });
  }
  return lines;
}

function computeTax(surcharges, { mode, service, finalBase, surchargeLines, adhocLines }) {
  const vat = surcharges.find((s) => s.isActive && s.type === "VAT" && surchargeApplies(s.appliesTo, mode, service));
  if (!vat) return { taxKobo: 0, taxableBase: 0, ratePercent: 0, line: null };
  const taxableBase =
    finalBase +
    surchargeLines.filter((l) => l.vatApplicable).reduce((a, l) => a + l.amount, 0) +
    adhocLines.filter((l) => l.vatApplicable).reduce((a, l) => a + l.amount, 0);
  let tax = 0;
  if (positive(vat.ratePercent)) tax = Math.round(taxableBase * (vat.ratePercent / 100)); // whole-naira VAT (existing rule)
  else if (positive(vat.flatAmount)) tax = Number(vat.flatAmount);
  if (tax <= 0) return { taxKobo: 0, taxableBase, ratePercent: vat.ratePercent || 0, line: null };
  return {
    taxKobo: toKobo(tax),
    taxableBase,
    ratePercent: vat.ratePercent || 0,
    line: {
      type: "VAT", label: vat.label, description: vat.description || null,
      amount: tax, amountKobo: toKobo(tax), category: "TAX",
    },
  };
}

function computeInsurance({ requiresInsurance, declaredValueNaira, finalBase, ratePercent, minPremiumNaira }) {
  if (!requiresInsurance) return { premiumKobo: 0, insuredValue: null, autoCalculated: false, line: null };
  const auto = !positive(declaredValueNaira);
  const insuredValue = auto ? ceilMoney(finalBase * 1.1) : Number(declaredValueNaira);
  const premiumKobo = Math.max(toKobo(minPremiumNaira || 0), Math.round(toKobo(insuredValue) * ((ratePercent || 0) / 100)));
  return {
    premiumKobo, insuredValue, autoCalculated: auto,
    line: premiumKobo > 0
      ? {
          type: "INSURANCE",
          label: `Insurance (${ratePercent}% of declared value)`,
          description: null, amount: fromKobo(premiumKobo), amountKobo: premiumKobo, category: "INSURANCE",
        }
      : null,
  };
}

// ─── Lane availability ───────────────────────────────────────────────────────
// exact city pair (3) > one city (2) > zone (1). No matching rule => open.
// On a specificity tie, a deny wins.
function laneAvailable(lanes = [], { fromCityId, toCityId, zone }) {
  let best = null;
  for (const l of lanes) {
    let score = 0;
    if (l.fromCityId || l.toCityId) {
      if (l.fromCityId && l.fromCityId !== fromCityId) continue;
      if (l.toCityId && l.toCityId !== toCityId) continue;
      score = l.fromCityId && l.toCityId ? 3 : 2;
    } else if (l.zone !== null && l.zone !== undefined) {
      if (Number(l.zone) !== Number(zone)) continue;
      score = 1;
    } else continue;
    if (!best || score > best.score || (score === best.score && l.isAvailable === false)) {
      best = { score, isAvailable: l.isAvailable !== false, reason: l.reason };
    }
  }
  return best ? { available: best.isAvailable, reason: best.reason } : { available: true, reason: null };
}

const formatDeliveryLabel = (min, max) =>
  min === max ? `${min} business day${min === 1 ? "" : "s"}` : `${min}–${max} business days`;

function resolveSla(slas, { zone, mode, service }) {
  const row = slas.find((s) => Number(s.zone) === Number(zone) && s.shipmentMode === mode && s.serviceType === service);
  if (!row) return null;
  return {
    slaId: row.id, minDays: row.minDays, maxDays: row.maxDays,
    label: row.label || formatDeliveryLabel(row.minDays, row.maxDays), source: "CONFIGURED",
  };
}

// ─── Offering evaluation ─────────────────────────────────────────────────────
const UNAVAILABLE_MESSAGES = {
  NOT_OFFERED: (o) => `${o.mode} ${o.service} is not a shipping option we offer`,
  MODE_INACTIVE: (o) => `${MODE_LABEL[o.mode]} shipping is currently unavailable. Please choose another mode of shipment.`,
  OFFERING_INACTIVE: (o) => `${MODE_LABEL[o.mode]} ${SERVICE_LABEL[o.service]} is currently unavailable.`,
  LANE_UNAVAILABLE: (o) => `${MODE_LABEL[o.mode]} ${SERVICE_LABEL[o.service]} is not available on this route.`,
  WEIGHT_BELOW_MIN: (o, x) => `${MODE_LABEL[o.mode]} ${SERVICE_LABEL[o.service]} requires at least ${x.min}kg (billable ${x.weight}kg).`,
  WEIGHT_ABOVE_MAX: (o, x) => `${MODE_LABEL[o.mode]} ${SERVICE_LABEL[o.service]} supports up to ${x.max}kg (billable ${x.weight}kg).`,
  DIMENSION_LIMIT: (o, x) => `${MODE_LABEL[o.mode]} ${SERVICE_LABEL[o.service]} supports a longest side of up to ${x.max}cm.`,
  NO_SLA: (o, x) => `No delivery time is configured for ${MODE_LABEL[o.mode]} ${SERVICE_LABEL[o.service]} in zone ${x.zone}.`,
  NO_RATE: (o, x) => `Rate not found for ${o.mode} ${o.service} — no pricing available for zone ${x.zone} at ${x.weight}kg`,
};
const MODE_LABEL = { AIR: "Air", LAND: "Land", SEA: "Sea" };
const SERVICE_LABEL = { EXPRESS: "Express", STANDARD: "Standard", ECONOMY: "Economy" };
const REASON_STATUS = { NOT_OFFERED: 400, MODE_INACTIVE: 400, OFFERING_INACTIVE: 400, LANE_UNAVAILABLE: 400, WEIGHT_BELOW_MIN: 400, WEIGHT_ABOVE_MAX: 400, DIMENSION_LIMIT: 400, NO_SLA: 404, NO_RATE: 404 };

function unavailable(offering, code, extra = {}) {
  const o = { mode: offering.shipmentMode, service: offering.serviceType };
  return {
    available: false,
    offeringId: offering.id || null,
    shipmentMode: o.mode,
    serviceType: o.service,
    displayName: offering.displayName || `${MODE_LABEL[o.mode]} ${SERVICE_LABEL[o.service]}`,
    reasonCode: code,
    reason: UNAVAILABLE_MESSAGES[code](o, extra),
    statusCode: REASON_STATUS[code],
  };
}

/**
 * Evaluate ONE offering for a request. Returns either
 *   { available:false, reasonCode, reason }  or the full explicit price result.
 * ctx must contain: now, zone, fromCity, toCity, modeSettings{MODE:row}, slas[],
 * bands[], surcharges[], insurance{ratePercent,minPremiumNaira}, contracts[],
 * promo, box, evaluateAdhoc(fn).
 */
function evaluateOffering(ctx, offering, req) {
  const mode = offering.shipmentMode;
  const service = offering.serviceType;
  const now = ctx.now || new Date();
  const modeSetting = ctx.modeSettings?.[mode];

  if (modeSetting && modeSetting.isActive === false) return unavailable(offering, "MODE_INACTIVE");
  if (!offering.isActive) return unavailable(offering, "OFFERING_INACTIVE");

  const lane = laneAvailable(offering.lanes || [], {
    fromCityId: ctx.fromCity.id, toCityId: ctx.toCity.id, zone: ctx.zone,
  });
  if (!lane.available) return unavailable(offering, "LANE_UNAVAILABLE");

  // Billable weight uses THIS mode's volumetric divisor.
  const m = resolveMeasurements(
    { ...req, box: ctx.box },
    modeSetting?.volumetricDivisor || DEFAULT_VOLUMETRIC_DIVISOR,
  );
  const w = m.billableWeightKg;

  const minKg = offering.minWeightKg;
  const maxKg = [offering.maxWeightKg, modeSetting?.maxWeightKg].filter(positive).sort((a, b) => a - b)[0];
  if (positive(minKg) && w < minKg) return unavailable(offering, "WEIGHT_BELOW_MIN", { min: minKg, weight: w });
  if (positive(maxKg) && w > maxKg) return unavailable(offering, "WEIGHT_ABOVE_MAX", { max: maxKg, weight: w });
  const maxSide = [offering.maxLongestSideCm, modeSetting?.maxLongestSideCm].filter(positive).sort((a, b) => a - b)[0];
  const longest = Math.max(m.lengthCm || 0, m.widthCm || 0, m.heightCm || 0);
  if (positive(maxSide) && longest > maxSide) return unavailable(offering, "DIMENSION_LIMIT", { max: maxSide });

  const deliveryEstimate = resolveSla(ctx.slas, { zone: ctx.zone, mode, service });
  if (!deliveryEstimate && !offering.allowsNoSla) return unavailable(offering, "NO_SLA", { zone: ctx.zone });

  const picked = selectBand(ctx.bands, { zone: ctx.zone, weightKg: w, mode, service, now });
  if (!picked) return unavailable(offering, "NO_RATE", { zone: ctx.zone, weight: w });

  // Standard rate, then minimum charge.
  let standardBase = picked.amount;
  let minChargeApplied = false;
  if (positive(offering.minChargeNaira) && standardBase < offering.minChargeNaira) {
    standardBase = Number(offering.minChargeNaira);
    minChargeApplied = true;
  }

  const commercial = applyCommercial({
    standardBase, zone: ctx.zone, weightKg: w, mode, service,
    contracts: ctx.contracts || [], promo: ctx.promo || null, now,
  });
  const finalBase = commercial.finalBase;

  const surchargeLines = computeSurcharges(ctx.surcharges, { finalBase, mode, service, isFragile: !!req.isFragile });

  // Ad-hoc: evaluated once, against THIS mode's measurements.
  const measurements = { ...m, billableWeightKg: w };
  const adhoc = ctx.evaluateAdhoc
    ? ctx.evaluateAdhoc({ shipmentMode: mode, measurements, basePriceKobo: toKobo(finalBase) })
    : { autoApply: [], suggested: [] };
  const adhocLines = adhoc.autoApply.map((a) => ({
    type: "ADHOC",
    chargeTypeId: a.chargeType.id,
    ruleId: a.rule?.id || null,
    label: a.chargeType.name,
    description: a.reason,
    amount: fromKobo(a.amountKobo),
    amountKobo: a.amountKobo,
    vatApplicable: !!a.chargeType.vatApplicable,
    category: "ADHOC",
  }));

  const tax = computeTax(ctx.surcharges, { mode, service, finalBase, surchargeLines, adhocLines });
  const ins = computeInsurance({
    requiresInsurance: !!req.requiresInsurance,
    declaredValueNaira: req.insuranceValue,
    finalBase,
    ratePercent: ctx.insurance?.ratePercent ?? 0,
    minPremiumNaira: ctx.insurance?.minPremiumNaira ?? 0,
  });

  const baseKobo = toKobo(finalBase);
  const surchargeKobo = surchargeLines.reduce((a, l) => a + l.amountKobo, 0);
  const adhocKobo = adhocLines.reduce((a, l) => a + l.amountKobo, 0);
  const totalKobo = baseKobo + surchargeKobo + adhocKobo + ins.premiumKobo + tax.taxKobo;

  const breakdown = [...surchargeLines, ...adhocLines, ...(tax.line ? [tax.line] : []), ...(ins.line ? [ins.line] : [])];

  return {
    available: true,
    offeringId: offering.id || null,
    shipmentMode: mode,
    serviceType: service,
    displayName: offering.displayName || `${MODE_LABEL[mode]} ${SERVICE_LABEL[service]}`,
    zone: ctx.zone,
    measurements,
    billableWeightKg: w,
    deliveryEstimate: deliveryEstimate
      ? { minDays: deliveryEstimate.minDays, maxDays: deliveryEstimate.maxDays, label: deliveryEstimate.label, source: deliveryEstimate.source }
      : null,
    rate: {
      priceBandId: picked.band.id,
      source: picked.source,
      pricePerKg: picked.perKg,
      standardBasePrice: standardBase,
      minChargeApplied,
      gapResolved: picked.gapResolved,
    },
    pricingMode: commercial.pricingMode,
    appliedDiscount: commercial.appliedDiscount,
    contractRateId: commercial.contractRateId || null,
    promoStatus: commercial.promoStatus,
    // Explicit components (naira) — clients must NOT reconstruct these.
    basePrice: standardBase,
    commercialAdjustment: -(standardBase - finalBase),
    finalBasePrice: finalBase,
    surcharges: surchargeLines,
    surchargeTotal: fromKobo(surchargeKobo),
    adhocCharges: adhocLines,
    adhocTotal: fromKobo(adhocKobo),
    adhocSuggestions: adhoc.suggested.map((s) => ({
      chargeTypeId: s.chargeType.id, name: s.chargeType.name, reason: s.reason, amount: fromKobo(s.amountKobo),
    })),
    insurancePremium: fromKobo(ins.premiumKobo),
    insuredValue: ins.insuredValue,
    insuranceAutoCalculated: ins.autoCalculated,
    taxableBase: tax.taxableBase,
    taxRatePercent: tax.ratePercent,
    tax: fromKobo(tax.taxKobo),
    total: fromKobo(totalKobo),
    currency: "NGN",
    // Integer-kobo components; total === sum of the parts, by construction.
    pricingKobo: {
      standardBase: toKobo(standardBase), base: baseKobo, surcharge: surchargeKobo, adhoc: adhocKobo,
      insurance: ins.premiumKobo, tax: tax.taxKobo, total: totalKobo,
    },
    // Ordered display lines with an explicit category (SURCHARGE|ADHOC|TAX|INSURANCE).
    surchargeBreakdown: breakdown,
    adhocEvaluation: adhoc, // raw entries, used once to persist the applied/suggested lines
  };
}

module.exports = {
  CARTON_DEFAULT_KG, GAP_TOLERANCE_KG, DEFAULT_VOLUMETRIC_DIVISOR, MODE_LABEL, SERVICE_LABEL,
  toKobo, fromKobo, ceilMoney, roundHalf, calcVolumetricWeight,
  resolveMeasurements, bandZones, bandPrice, selectBand,
  contractCandidates, applyCommercial,
  surchargeApplies, computeSurcharges, computeTax, computeInsurance,
  laneAvailable, resolveSla, formatDeliveryLabel,
  evaluateOffering, unavailable,
};
