// ─── src/services/pricing/contractRules.js ───────────────────────────────────
// Pure validation for contract (negotiated) rates. Scope is always explicit:
//   shipmentMode: null = ALL modes, else that mode only
//   serviceType : null = ALL services, else that service only
// A fixed ₦/kg card is an absolute price, so it MUST name a mode.
const { ApiError } = require("../../utils/ApiError");
const { parseFixedMap, MODES, SERVICES } = require("./bandRules");

const nullish = (v) => v === undefined || v === null || v === "";

function normalizeContract(input) {
  const shipmentMode = nullish(input.shipmentMode) ? null : input.shipmentMode;
  const serviceType = nullish(input.serviceType) ? null : input.serviceType;
  if (shipmentMode && !MODES.includes(shipmentMode)) throw new ApiError(400, `shipmentMode must be one of ${MODES.join(", ")} (or empty for all modes)`);
  if (serviceType && !SERVICES.includes(serviceType)) throw new ApiError(400, `serviceType must be one of ${SERVICES.join(", ")} (or empty for all services)`);

  const hasDiscount = !nullish(input.discountPercent);
  const fixed = nullish(input.fixedPricePerKgByZone) ? null : parseFixedMap(input.fixedPricePerKgByZone);
  if (!hasDiscount && !fixed) throw new ApiError(400, "Provide either discountPercent or fixedPricePerKgByZone");
  if (hasDiscount && fixed) throw new ApiError(400, "Provide either discountPercent OR fixedPricePerKgByZone, not both");

  let discountPercent = null;
  if (hasDiscount) {
    discountPercent = Number(input.discountPercent);
    if (!Number.isFinite(discountPercent) || discountPercent <= 0 || discountPercent > 100) {
      throw new ApiError(400, "discountPercent must be greater than 0 and at most 100");
    }
  }
  if (fixed && !shipmentMode) {
    throw new ApiError(400, "A fixed price-per-kg contract must name its shipment mode — an absolute ₦/kg figure is not meaningful across air, land and sea.");
  }

  const validFrom = nullish(input.validFrom) ? null : new Date(input.validFrom);
  const validUntil = nullish(input.validUntil) ? null : new Date(input.validUntil);
  if (validFrom && validUntil && validUntil < validFrom) throw new ApiError(400, "validUntil cannot be before validFrom");

  return {
    label: input.label || null,
    shipmentMode, serviceType, discountPercent, fixedPricePerKgByZone: fixed,
    isActive: input.isActive !== false,
    validFrom, validUntil,
    notes: input.notes || null,
  };
}

const scopeOverlaps = (a, b) =>
  (!a.shipmentMode || !b.shipmentMode || a.shipmentMode === b.shipmentMode) &&
  (!a.serviceType || !b.serviceType || a.serviceType === b.serviceType);

const validityOverlaps = (a, b) =>
  (!a.validUntil || !b.validFrom || new Date(a.validUntil) >= new Date(b.validFrom)) &&
  (!b.validUntil || !a.validFrom || new Date(b.validUntil) >= new Date(a.validFrom));

// Two active contracts for the same user may not both claim the same product
// in the same period — which one applies would be ambiguous.
function findContractConflict(candidate, existing, { ignoreId } = {}) {
  if (!candidate.isActive) return null;
  return existing.find((c) => c.isActive && c.id !== ignoreId && scopeOverlaps(candidate, c) && validityOverlaps(candidate, c)) || null;
}

const describeScope = (c) =>
  `${c.shipmentMode || "all modes"} / ${c.serviceType || "all services"}`;

module.exports = { normalizeContract, findContractConflict, describeScope };
