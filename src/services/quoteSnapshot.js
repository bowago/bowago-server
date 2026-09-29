// ─── src/services/quoteSnapshot.js ───────────────────────────────────────────
// One place that turns the pricing engine's result into the persisted,
// authoritative snapshot — and turns a persisted quote back into a priced view.
//
// Invariant: once a Quote row exists, NOTHING recomputes its price. Booking,
// invoices, the review screen and the shipment detail all read what is stored
// here, so the customer sees the same numbers, SLA and product everywhere.
const { prisma } = require("../config/db");
const { estimateDeliveryDate } = require("./pricing.service");

const toKobo = (n) => Math.round(Number(n) * 100);
const sumKobo = (lines, type) => lines.filter((l) => l.type === type).reduce((a, l) => a + l.amountKobo, 0);

// Original request inputs, kept so "refresh quote" can replay them exactly
// (including box selection / carton counts that the columns alone can't hold).
function pickRequest(req) {
  return {
    weightKg: req.weightKg ?? null, tons: req.tons ?? null, cartons: req.cartons ?? null,
    boxDimensionId: req.boxDimensionId ?? null,
    customLength: req.customLength ?? null, customWidth: req.customWidth ?? null, customHeight: req.customHeight ?? null,
    isFragile: !!req.isFragile, requiresInsurance: !!req.requiresInsurance,
    insuranceValue: req.insuranceValue ?? null, promoCode: req.promoCode ?? null,
  };
}

function buildSnapshot(result, req) {
  return {
    version: 2,
    request: pickRequest(req),
    offering: { id: result.offeringId, shipmentMode: result.shipmentMode, serviceType: result.serviceType, displayName: result.displayName },
    zone: result.zone,
    measurements: result.measurements,
    billableWeightKg: result.billableWeightKg,
    deliveryEstimate: result.deliveryEstimate,
    rate: result.rate,
    pricingMode: result.pricingMode,
    contractRateId: result.contractRateId,
    appliedDiscount: result.appliedDiscount,
    components: {
      basePrice: result.basePrice,
      commercialAdjustment: result.commercialAdjustment,
      finalBasePrice: result.finalBasePrice,
      surchargeTotal: result.surchargeTotal,
      adhocTotal: result.adhocTotal,
      insurancePremium: result.insurancePremium,
      taxableBase: result.taxableBase,
      taxRatePercent: result.taxRatePercent,
      tax: result.tax,
      total: result.total,
    },
    pricingKobo: result.pricingKobo,
    surcharges: result.surcharges,
    adhocCharges: result.adhocCharges,
    adhocSuggestions: result.adhocSuggestions,
    insuredValue: result.insuredValue,
    surchargeBreakdown: result.surchargeBreakdown,
    currency: result.currency,
  };
}

// Columns for prisma.quote.create — straight from the engine result.
function quoteColumns(result, req, { userId, originCity, destinationCity, expiresAt, declaredValueKobo, insuranceSelected }) {
  const k = result.pricingKobo;
  const lines = result.surchargeBreakdown;
  return {
    userId,
    status: "GENERATED",
    originCity,
    originCityId: result.fromCity.id,
    destinationCity,
    destinationCityId: result.toCity.id,
    zone: result.zone,
    distanceKm: result.distanceKm,
    weightKg: result.measurements.actualWeightKg, // ACTUAL weight (billable is stored separately)
    volumetricWeightKg: result.measurements.volumetricWeightKg,
    billableWeightKg: result.billableWeightKg,
    lengthCm: result.measurements.lengthCm,
    widthCm: result.measurements.widthCm,
    heightCm: result.measurements.heightCm,
    serviceType: result.serviceType,
    shipmentMode: result.shipmentMode,
    offeringId: result.offeringId,
    priceBandId: result.rate.priceBandId,
    slaMinDays: result.deliveryEstimate?.minDays ?? null,
    slaMaxDays: result.deliveryEstimate?.maxDays ?? null,
    slaLabel: result.deliveryEstimate?.label ?? null,
    standardBasePriceKobo: k.standardBase,
    basePriceKobo: k.base,
    fuelSurchargeKobo: sumKobo(lines, "FUEL"),
    remoteAreaFeeKobo: sumKobo(lines, "REMOTE_AREA"),
    surchargeTotalKobo: k.surcharge,
    adhocChargesKobo: k.adhoc,
    vatKobo: k.tax,
    totalPriceKobo: k.total,
    surchargeBreakdown: lines,
    pricingSnapshot: buildSnapshot(result, req),
    insuranceSelected: !!insuranceSelected,
    declaredValueKobo,
    insurancePremiumKobo: k.insurance > 0 ? k.insurance : insuranceSelected ? 0 : null,
    promoCode: req.promoCode || null,
    promoDiscountKobo: result.appliedDiscount ? toKobo(result.appliedDiscount.discountAmount || 0) : null,
    pricingMode: result.pricingMode || "STANDARD",
    expiresAt,
  };
}

// Explicit, client-facing pricing block for a persisted quote. Clients must
// read these fields and never reconstruct a subtotal from `total`.
function pricingBlock(q) {
  const n = (k) => (k === null || k === undefined ? null : k / 100);
  const std = q.standardBasePriceKobo ?? q.basePriceKobo;
  return {
    standardBasePriceNaira: n(std),
    commercialAdjustmentNaira: n(q.basePriceKobo - std),
    basePriceNaira: n(q.basePriceKobo),
    surchargeTotalNaira: n(q.surchargeTotalKobo ?? q.fuelSurchargeKobo + q.remoteAreaFeeKobo),
    adhocTotalNaira: n(q.adhocChargesKobo),
    insurancePremiumNaira: q.insurancePremiumKobo ? n(q.insurancePremiumKobo) : null,
    taxNaira: n(q.vatKobo),
    totalNaira: n(q.totalPriceKobo),
    // legacy names, same values
    fuelSurchargeNaira: n(q.fuelSurchargeKobo),
    remoteAreaFeeNaira: n(q.remoteAreaFeeKobo),
    adhocChargesNaira: n(q.adhocChargesKobo),
    vatNaira: n(q.vatKobo),
    basePriceKobo: q.basePriceKobo,
    totalPriceKobo: q.totalPriceKobo,
  };
}

// A persisted quote rendered in the same explicit shape the engine returns.
// Legacy quotes (no snapshot) are reconstructed from their columns.
function quoteToPricedView(q, { fromCity, toCity } = {}) {
  const snap = q.pricingSnapshot;
  const legacyBreakdown = Array.isArray(q.surchargeBreakdown) ? q.surchargeBreakdown : [];
  const block = pricingBlock(q);
  const deliveryEstimate =
    q.slaMinDays !== null && q.slaMinDays !== undefined
      ? { minDays: q.slaMinDays, maxDays: q.slaMaxDays, label: q.slaLabel, source: "SNAPSHOT" }
      : null;
  return {
    offeringId: q.offeringId,
    shipmentMode: q.shipmentMode,
    serviceType: q.serviceType,
    displayName: snap?.offering?.displayName ?? null,
    zone: q.zone,
    distanceKm: q.distanceKm,
    fromCity, toCity,
    billableWeightKg: q.billableWeightKg ?? q.weightKg,
    weightKg: q.billableWeightKg ?? q.weightKg,
    measurements: snap?.measurements ?? null,
    deliveryEstimate,
    pricingMode: q.pricingMode,
    appliedDiscount:
      snap?.appliedDiscount ??
      (q.pricingMode && q.pricingMode !== "STANDARD"
        ? {
            type: q.pricingMode,
            label: q.pricingMode === "PROMO" ? `Promo Code "${(q.promoCode || "").toUpperCase()}"` : "Enterprise Contract Rate",
            discountAmount: (q.promoDiscountKobo || 0) / 100,
          }
        : null),
    basePrice: block.standardBasePriceNaira,
    commercialAdjustment: block.commercialAdjustmentNaira,
    finalBasePrice: block.basePriceNaira,
    surchargeTotal: block.surchargeTotalNaira,
    adhocTotal: block.adhocTotalNaira,
    insurancePremium: block.insurancePremiumNaira || 0,
    tax: block.taxNaira,
    total: block.totalNaira,
    surchargeBreakdown: legacyBreakdown,
    pricing: block,
    currency: "NGN",
  };
}

// Fields copied onto Shipment at booking — the locked commercial snapshot.
function shipmentSnapshotFields(q) {
  return {
    offeringId: q.offeringId ?? null,
    slaMinDays: q.slaMinDays ?? null,
    slaMaxDays: q.slaMaxDays ?? null,
    pricingSnapshot: q.pricingSnapshot ?? null,
    surchargeBreakdown: Array.isArray(q.surchargeBreakdown) && q.surchargeBreakdown.length > 0 ? q.surchargeBreakdown : null,
  };
}

// Booking date comes from the SLA the customer was promised. Legacy quotes
// (created before the snapshot columns) fall back to the SLA row of that exact
// zone + mode + service; if none exists there is simply no estimate.
async function estimatedDeliveryFor(q, pickupDate) {
  let maxDays = q.slaMaxDays;
  if (maxDays === null || maxDays === undefined) {
    const row = await prisma.deliverySLA.findUnique({
      where: { zone_shipmentMode_serviceType: { zone: q.zone, shipmentMode: q.shipmentMode || "LAND", serviceType: q.serviceType } },
    });
    maxDays = row ? row.maxDays : null;
  }
  return estimateDeliveryDate(pickupDate, maxDays);
}

// Pure: the Quote column updates for an admin-approved ad-hoc charge.
// Ad-hoc lines sit AFTER surcharges and BEFORE the tax line in the breakdown.
function applyApprovedAdhocToQuote(quote, { name, reason, amountKobo, vatKobo, vatApplicable, chargeTypeId }) {
  const adhocLine = {
    type: "ADHOC", chargeTypeId, label: name, description: reason || null,
    amount: amountKobo / 100, amountKobo, vatApplicable: !!vatApplicable, category: "ADHOC",
  };
  const lines = Array.isArray(quote.surchargeBreakdown) ? [...quote.surchargeBreakdown] : [];
  const taxIdx = lines.findIndex((l) => l.category === "TAX" || l.type === "VAT");
  if (taxIdx >= 0) lines.splice(taxIdx, 0, adhocLine);
  else lines.push(adhocLine);
  if (vatKobo > 0) {
    const t = lines.findIndex((l) => l.category === "TAX" || l.type === "VAT");
    if (t >= 0) {
      const cur = Math.round((lines[t].amountKobo ?? Math.round((lines[t].amount || 0) * 100)) + vatKobo);
      lines[t] = { ...lines[t], amountKobo: cur, amount: cur / 100 };
    } else {
      lines.push({ type: "VAT", label: "VAT", description: null, amount: vatKobo / 100, amountKobo: vatKobo, category: "TAX" });
    }
  }

  const snap = quote.pricingSnapshot;
  const nextSnap = snap
    ? {
        ...snap,
        components: {
          ...snap.components,
          adhocTotal: (quote.adhocChargesKobo + amountKobo) / 100,
          tax: (quote.vatKobo + vatKobo) / 100,
          total: (quote.totalPriceKobo + amountKobo + vatKobo) / 100,
        },
        pricingKobo: {
          ...snap.pricingKobo,
          adhoc: quote.adhocChargesKobo + amountKobo,
          tax: quote.vatKobo + vatKobo,
          total: quote.totalPriceKobo + amountKobo + vatKobo,
        },
        adhocCharges: [...(snap.adhocCharges || []), adhocLine],
        surchargeBreakdown: lines,
      }
    : undefined;

  return {
    adhocChargesKobo: quote.adhocChargesKobo + amountKobo,
    vatKobo: quote.vatKobo + vatKobo,
    totalPriceKobo: quote.totalPriceKobo + amountKobo + vatKobo,
    surchargeBreakdown: lines,
    ...(nextSnap ? { pricingSnapshot: nextSnap } : {}),
  };
}

module.exports = {
  applyApprovedAdhocToQuote,
  pickRequest, buildSnapshot, quoteColumns, pricingBlock, quoteToPricedView,
  shipmentSnapshotFields, estimatedDeliveryFor, toKobo,
};
