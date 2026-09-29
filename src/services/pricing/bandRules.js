// ─── src/services/pricing/bandRules.js ───────────────────────────────────────
// Server-side validation for PriceBand writes (pure — no DB). A rate row must
// unambiguously identify its product (mode + service), its zone(s), its weight
// range and a usable price; two active rows must never price the same thing.
const { ApiError } = require("../../utils/ApiError");
const { bandZones } = require("./core");

const MODES = ["AIR", "LAND", "SEA"];
const SERVICES = ["EXPRESS", "STANDARD", "ECONOMY"];

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const pos = (v) => v !== null && v !== undefined && Number(v) > 0;
const date = (v) => (v ? new Date(v) : null);

function parseFixedMap(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  let map = raw;
  if (typeof raw === "string") {
    try { map = JSON.parse(raw); } catch { throw new ApiError(400, "fixedPricePerKgByZone must be valid JSON"); }
  }
  if (typeof map !== "object" || Array.isArray(map)) throw new ApiError(400, "fixedPricePerKgByZone must be an object like {\"1\":150,\"2\":200}");
  const out = {};
  for (const [z, v] of Object.entries(map)) {
    if (!Number.isInteger(Number(z))) throw new ApiError(400, `fixedPricePerKgByZone has an invalid zone key "${z}"`);
    if (!pos(v)) throw new ApiError(400, `fixedPricePerKgByZone[${z}] must be a price greater than 0`);
    out[String(Number(z))] = Number(v);
  }
  if (Object.keys(out).length === 0) throw new ApiError(400, "fixedPricePerKgByZone must contain at least one zone");
  return out;
}

/**
 * Normalise + validate a full band description. `input` is the complete
 * intended state (for updates: existing row merged with the patch).
 */
function normalizeBand(input) {
  const shipmentMode = input.shipmentMode;
  const serviceType = input.serviceType;
  if (!MODES.includes(shipmentMode)) throw new ApiError(400, `shipmentMode is required and must be one of ${MODES.join(", ")}`);
  if (!SERVICES.includes(serviceType)) throw new ApiError(400, `serviceType is required and must be one of ${SERVICES.join(", ")}`);

  const isActive = input.isActive !== false;
  const minKg = num(input.minKg) ?? 0;
  const maxKg = num(input.maxKg);
  if (minKg < 0) throw new ApiError(400, "minKg cannot be negative");
  if (maxKg !== null && maxKg <= minKg) throw new ApiError(400, "maxKg must be greater than minKg");

  const validFrom = date(input.validFrom);
  const validUntil = date(input.validUntil);
  if (validFrom && validUntil && validUntil < validFrom) throw new ApiError(400, "validUntil cannot be before validFrom");

  const fixed = parseFixedMap(input.fixedPricePerKgByZone);
  const zone = input.zone === null || input.zone === undefined || input.zone === "" ? null : Number(input.zone);
  if (zone !== null && !Number.isInteger(zone)) throw new ApiError(400, "zone must be a whole number");
  if (fixed && zone !== null) throw new ApiError(400, "Provide either a single zone or fixedPricePerKgByZone, not both");

  const pricePerKg = num(input.pricePerKg);
  const basePrice = num(input.basePrice);
  const hasPrice = pos(pricePerKg) || pos(basePrice) || !!fixed;

  if (isActive) {
    if (!hasPrice) {
      // A discount alone is not a price; ₦0 placeholders must be inactive.
      throw new ApiError(400, "An active rate needs a price: pricePerKg, basePrice or fixedPricePerKgByZone greater than 0 (a discount alone is not a price)");
    }
    if (!fixed && zone === null) throw new ApiError(400, "Provide a zone (single-zone rate) or fixedPricePerKgByZone (multi-zone rate)");
    if ((pos(pricePerKg) || pos(basePrice)) && zone === null) throw new ApiError(400, "pricePerKg / basePrice need a zone");
  }
  if (pricePerKg !== null && pricePerKg < 0) throw new ApiError(400, "pricePerKg cannot be negative");
  if (basePrice !== null && basePrice < 0) throw new ApiError(400, "basePrice cannot be negative");

  return {
    label: input.label || null,
    shipmentMode, serviceType, isActive,
    zone: fixed ? null : zone,
    pricePerKg: pos(pricePerKg) ? pricePerKg : null,
    basePrice: pos(basePrice) ? basePrice : null,
    fixedPricePerKgByZone: fixed,
    discountPercent: input.discountPercent === undefined ? null : num(input.discountPercent),
    minKg, maxKg,
    minTons: num(input.minTons) ?? 0, maxTons: num(input.maxTons),
    minCartons: input.minCartons === undefined || input.minCartons === null ? 0 : parseInt(input.minCartons, 10),
    maxCartons: input.maxCartons === undefined || input.maxCartons === null ? null : parseInt(input.maxCartons, 10),
    validFrom, validUntil,
    notes: input.notes || null,
  };
}

const overlapsRange = (aMin, aMax, bMin, bMax) =>
  aMin < (bMax ?? Infinity) && bMin < (aMax ?? Infinity); // touching edges are not an overlap

const overlapsValidity = (a, b) =>
  (!a.validUntil || !b.validFrom || new Date(a.validUntil) >= new Date(b.validFrom)) &&
  (!b.validUntil || !a.validFrom || new Date(b.validUntil) >= new Date(a.validFrom));

/**
 * Returns the existing active band that would double-price the same product
 * (same mode + service + a shared zone + overlapping weight AND validity), or null.
 */
function findConflict(candidate, existingBands, { ignoreId } = {}) {
  if (!candidate.isActive) return null;
  const zones = new Set(bandZones(candidate));
  for (const b of existingBands) {
    if (!b.isActive || b.id === ignoreId) continue;
    if (b.shipmentMode !== candidate.shipmentMode || b.serviceType !== candidate.serviceType) continue;
    if (!bandZones(b).some((z) => zones.has(z))) continue;
    if (!overlapsRange(candidate.minKg, candidate.maxKg, b.minKg, b.maxKg)) continue;
    if (!overlapsValidity(candidate, b)) continue;
    return b;
  }
  return null;
}

module.exports = { normalizeBand, findConflict, parseFixedMap, MODES, SERVICES };
