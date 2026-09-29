// ─── src/services/adhocCharge.service.js ─────────────────────────────────────
// V1 Features 5 & 6 — Adhoc charges defined by admin, and suggested automated
// adhoc charges triggered by weight/volume rules.
//
// This is the single place that:
//   1. Reads a parcel's measurements into the five metrics a rule can key on.
//   2. Decides whether a given rule matches those metrics.
//   3. Computes what a matched charge type is actually worth in kobo.
//   4. Applies matched rules to a quote (AUTO_APPLY charges land on the quote
//      total immediately; SUGGEST charges are recorded but never affect the
//      total — they only ever reach a customer after an admin decision).
//   5. Re-runs the same rules at warehouse weigh-in against measured values,
//      for a shipment that's already booked — see reEvaluateAtWeighIn, which
//      priceAdjustment.controller.js calls when a weight discrepancy is
//      logged (PRD Sprint 8: "any increase to the price after booking needs
//      customer approval — there are no silent increases").
//
// Money throughout is in kobo. The same charge type is never applied twice to
// one shipment (see the `existingChargeTypeIds` guard in both entry points).

const { prisma } = require("../config/db");

// ─── Metric extraction ────────────────────────────────────────────────────────
function computeMetrics({
  actualWeightKg,
  volumetricWeightKg,
  billableWeightKg,
  lengthCm,
  widthCm,
  heightCm,
}) {
  const volumeCm3 =
    lengthCm && widthCm && heightCm
      ? parseFloat(lengthCm) * parseFloat(widthCm) * parseFloat(heightCm)
      : null;
  const longestSideCm = [lengthCm, widthCm, heightCm]
    .filter((v) => v !== null && v !== undefined)
    .map(parseFloat);

  return {
    ACTUAL_WEIGHT: actualWeightKg ?? null,
    VOLUMETRIC_WEIGHT: volumetricWeightKg ?? null,
    BILLABLE_WEIGHT: billableWeightKg ?? null,
    VOLUME_CM3: volumeCm3,
    LONGEST_SIDE: longestSideCm.length ? Math.max(...longestSideCm) : null,
  };
}

// ─── Rule matching ────────────────────────────────────────────────────────────
function ruleMatches(rule, metrics) {
  const value = metrics[rule.metric];
  if (value === null || value === undefined) return false;

  switch (rule.operator) {
    case "GT":
      return value > rule.thresholdMin;
    case "GTE":
      return value >= rule.thresholdMin;
    case "LT":
      return value < rule.thresholdMin;
    case "LTE":
      return value <= rule.thresholdMin;
    case "BETWEEN":
      return (
        rule.thresholdMax !== null &&
        rule.thresholdMax !== undefined &&
        value >= rule.thresholdMin &&
        value <= rule.thresholdMax
      );
    default:
      return false;
  }
}

// ─── Charge amount calculation ────────────────────────────────────────────────
function computeChargeAmountKobo(chargeType, { billableWeightKg, basePriceKobo }) {
  switch (chargeType.calcMethod) {
    case "FIXED":
      return Math.round(chargeType.amountKobo || 0);
    case "PER_KG":
      return Math.round((chargeType.amountKobo || 0) * (billableWeightKg || 0));
    case "PERCENTAGE":
      return Math.round((basePriceKobo || 0) * ((chargeType.percentage || 0) / 100));
    default:
      return 0;
  }
}

function isModeApplicable(chargeOrRule, shipmentMode) {
  const modes = chargeOrRule.applicableModes;
  if (!modes || modes.length === 0) return true; // empty/null = all modes
  return !shipmentMode || modes.includes(shipmentMode);
}

// ─── Fetch every currently-effective rule, priority order ────────────────────
async function getActiveRules() {
  const now = new Date();
  return prisma.adhocChargeRule.findMany({
    where: {
      isActive: true,
      AND: [
        { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }] },
        { OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }] },
      ],
    },
    include: { chargeType: true },
    orderBy: { priority: "desc" },
  });
}

/**
 * Evaluate every active rule against a parcel's measurements + mode.
 * Returns { autoApply: [...], suggested: [...] } — each entry is
 * { rule, chargeType, amountKobo, reason }. A charge type already present in
 * `excludeChargeTypeIds` is skipped (never applied twice to one shipment).
 */
function evaluateRulesSync({
  shipmentMode,
  measurements,
  basePriceKobo,
  excludeChargeTypeIds = [],
  rules,
}) {
  const metrics = computeMetrics(measurements);

  const autoApply = [];
  const suggested = [];
  const seenChargeTypeIds = new Set(excludeChargeTypeIds);

  for (const rule of rules) {
    if (!rule.chargeType.isActive) continue;
    if (seenChargeTypeIds.has(rule.chargeTypeId)) continue; // never twice
    if (!isModeApplicable(rule, shipmentMode)) continue;
    if (!isModeApplicable(rule.chargeType, shipmentMode)) continue;
    if (!ruleMatches(rule, metrics)) continue;

    const amountKobo = computeChargeAmountKobo(rule.chargeType, {
      billableWeightKg: metrics.BILLABLE_WEIGHT,
      basePriceKobo,
    });
    if (amountKobo <= 0) continue;

    const reason = `${describeMetric(rule.metric)} ${describeThreshold(rule)} triggered "${rule.chargeType.name}"`;
    const entry = { rule, chargeType: rule.chargeType, amountKobo, reason };

    seenChargeTypeIds.add(rule.chargeTypeId);
    if (rule.behaviour === "AUTO_APPLY") autoApply.push(entry);
    else suggested.push(entry);
  }

  return { autoApply, suggested };
}

// Async wrapper: loads the active rules unless the caller already has them
// (the pricing engine preloads once and evaluates per offering).
async function evaluateRules({ rules, ...rest }) {
  return evaluateRulesSync({ ...rest, rules: rules || (await getActiveRules()) });
}

// ─── VAT rate (single source: the active VAT row in Surcharges) ──────────────
// Ad-hoc lines used to hard-code 7.5%. The rate now comes from the same VAT
// surcharge row the quote engine uses, so the two can never drift apart.
async function getVatRatePercent() {
  const row = await prisma.surcharge.findFirst({ where: { type: "VAT", isActive: true } });
  return row?.ratePercent ?? 0;
}
const vatKoboOn = (amountKobo, ratePercent) => Math.round(amountKobo * ((ratePercent || 0) / 100));

function describeMetric(metric) {
  return (
    {
      ACTUAL_WEIGHT: "Actual weight",
      VOLUMETRIC_WEIGHT: "Volumetric weight",
      BILLABLE_WEIGHT: "Billable weight",
      VOLUME_CM3: "Volume",
      LONGEST_SIDE: "Longest side",
    }[metric] || metric
  );
}

function describeThreshold(rule) {
  if (rule.operator === "BETWEEN") {
    return `between ${rule.thresholdMin} and ${rule.thresholdMax}`;
  }
  const symbol = { GT: "above", GTE: "at or above", LT: "below", LTE: "at or below" }[
    rule.operator
  ];
  return `${symbol} ${rule.thresholdMin}`;
}

/**
 * Applied at quote generation time (PRD Sprint 1 section D). AUTO_APPLY
 * matches become ShipmentAdhocCharge rows with status APPLIED, and their
 * total is what quote.controller.js should fold into adhocChargesKobo (and
 * therefore into the taxable VAT base). SUGGEST matches are recorded with
 * status SUGGESTED so they show up in the admin queue, but contribute
 * nothing to the customer's total until an admin decides.
 */
// Pure: the ShipmentAdhocCharge rows for a quote, from an engine evaluation.
function buildAdhocRows({ quoteId, autoApply, suggested, vatRatePercent }) {
  const rowFor = (entry, status) => ({
    quoteId,
    chargeTypeId: entry.chargeType.id,
    ruleId: entry.rule?.id || null,
    nameSnapshot: entry.chargeType.name,
    reason: entry.reason,
    amountKobo: entry.amountKobo,
    vatKobo: entry.chargeType.vatApplicable ? vatKoboOn(entry.amountKobo, vatRatePercent) : 0,
    status,
  });
  return [
    ...autoApply.map((e) => rowFor(e, "APPLIED")),
    ...suggested.map((e) => rowFor(e, "SUGGESTED")),
  ];
}

// Convenience (non-transactional) persistence. The quote flow uses
// buildAdhocRows inside a transaction instead, so a failure can never leave a
// total that includes a charge with no line behind it.
async function applyAdhocChargesAtQuote({ quoteId, autoApply, suggested, vatRatePercent }) {
  const rows = buildAdhocRows({ quoteId, autoApply, suggested, vatRatePercent: vatRatePercent ?? (await getVatRatePercent()) });
  if (rows.length > 0) await prisma.shipmentAdhocCharge.createMany({ data: rows });
  return { rows, appliedTotalKobo: autoApply.reduce((a, e) => a + e.amountKobo, 0), suggestedCount: suggested.length };
}

/**
 * Re-run at warehouse weigh-in for an already-booked shipment (PRD Sprint 8
 * price-shock flow). New AUTO_APPLY matches are returned so the caller
 * (priceAdjustment.controller.js) can fold them straight into a paused
 * PriceAdjustment. New SUGGEST matches are written as ShipmentAdhocCharge
 * rows with status SUGGESTED so they land in the admin queue; only once
 * admin approves does adhocSuggestion.controller.js turn that into a paused
 * customer-approval adjustment (see decideAdhocSuggestion there).
 */
async function reEvaluateAtWeighIn({ shipmentId, shipmentMode, measurements, basePriceKobo }) {
  const existing = await prisma.shipmentAdhocCharge.findMany({
    where: { shipmentId, status: { notIn: ["DISMISSED", "REJECTED"] } },
    select: { chargeTypeId: true },
  });
  const excludeChargeTypeIds = existing.map((e) => e.chargeTypeId);

  const { autoApply, suggested } = await evaluateRules({
    shipmentMode,
    measurements,
    basePriceKobo,
    excludeChargeTypeIds,
  });

  const vatRate = await getVatRatePercent();
  if (suggested.length > 0) {
    await prisma.shipmentAdhocCharge.createMany({
      data: suggested.map((e) => ({
        shipmentId,
        chargeTypeId: e.chargeType.id,
        ruleId: e.rule.id,
        nameSnapshot: e.chargeType.name,
        reason: e.reason,
        amountKobo: e.amountKobo,
        vatKobo: e.chargeType.vatApplicable ? vatKoboOn(e.amountKobo, vatRate) : 0,
        status: "SUGGESTED",
      })),
    });
  }

  return { autoApply, suggestedCount: suggested.length };
}

module.exports = {
  computeMetrics,
  ruleMatches,
  computeChargeAmountKobo,
  evaluateRules,
  evaluateRulesSync,
  getActiveRules,
  getVatRatePercent,
  vatKoboOn,
  buildAdhocRows,
  applyAdhocChargesAtQuote,
  reEvaluateAtWeighIn,
  describeMetric,
  describeThreshold,
};
