// ─── offering.controller.js ──────────────────────────────────────────────────
// Admin management of SHIPPING OFFERINGS — the real, purchasable products
// (shipment mode + service type) BowaGO sells, with their eligibility limits
// and lane availability. Offerings are never hard-deleted: deactivate instead,
// so historical quotes/shipments keep pointing at something real.
const { prisma } = require("../config/db");
const { ApiError } = require("../utils/ApiError");
const { success, created } = require("../utils/helpers");
const { computeCoverage, rateWarnings } = require("../services/pricing/offeringRules");

const MODES = ["AIR", "LAND", "SEA"];
const SERVICES = ["EXPRESS", "STANDARD", "ECONOMY"];

const EDITABLE = [
  "displayName", "description", "isActive", "allowsNoSla",
  "minWeightKg", "maxWeightKg", "maxLongestSideCm", "minChargeNaira", "sortOrder", "notes",
];

function optionalPositive(name, v) {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ApiError(400, `${name} must be a number ≥ 0 (or empty)`);
  return n === 0 ? null : n;
}

function cleanFields(body) {
  const out = {};
  for (const k of EDITABLE) if (body[k] !== undefined) out[k] = body[k];
  for (const k of ["minWeightKg", "maxWeightKg", "maxLongestSideCm", "minChargeNaira"]) {
    if (k in out) out[k] = optionalPositive(k, out[k]);
  }
  if ("sortOrder" in out) out.sortOrder = parseInt(out.sortOrder, 10) || 0;
  if ("isActive" in out) out.isActive = !!out.isActive;
  if ("allowsNoSla" in out) out.allowsNoSla = !!out.allowsNoSla;
  if (out.minWeightKg && out.maxWeightKg && out.maxWeightKg < out.minWeightKg) {
    throw new ApiError(400, "maxWeightKg cannot be lower than minWeightKg");
  }
  return out;
}

async function audit(req, entityId, action, previousValue, newValue) {
  await prisma.priceAuditLog.create({
    data: {
      entityType: "ServiceOffering", entityId, action,
      previousValue: previousValue || undefined, newValue: newValue || undefined,
      changedBy: req.user.id, reason: req.body?.reason || null,
    },
  });
}

async function loadCoverage(offering) {
  const [zoneRows, slas, bands] = await Promise.all([
    prisma.zoneMatrix.findMany({ where: { isActive: true }, distinct: ["zone"], select: { zone: true }, orderBy: { zone: "asc" } }),
    prisma.deliverySLA.findMany({ where: { shipmentMode: offering.shipmentMode, serviceType: offering.serviceType } }),
    prisma.priceBand.findMany({ where: { isActive: true, shipmentMode: offering.shipmentMode, serviceType: offering.serviceType } }),
  ]);
  return computeCoverage({ offering, zones: zoneRows.map((z) => z.zone), slas, bands });
}

// ─── GET /admin/offerings ────────────────────────────────────────────────────
async function listOfferings(req, res) {
  const offerings = await prisma.serviceOffering.findMany({
    include: { lanes: true },
    orderBy: [{ sortOrder: "asc" }, { shipmentMode: "asc" }, { serviceType: "asc" }],
  });
  const withCoverage = await Promise.all(
    offerings.map(async (o) => {
      const coverage = await loadCoverage(o);
      return {
        ...o,
        coverage: {
          zones: coverage.length,
          sellableZones: coverage.filter((c) => c.sellable).length,
          missingSla: coverage.filter((c) => c.missing.includes("SLA")).map((c) => c.zone),
          missingRate: coverage.filter((c) => c.missing.includes("RATE")).map((c) => c.zone),
        },
      };
    }),
  );
  return success(res, { offerings: withCoverage });
}

// ─── GET /admin/offerings/:id/coverage ───────────────────────────────────────
async function getCoverage(req, res) {
  const offering = await prisma.serviceOffering.findUnique({ where: { id: req.params.id } });
  if (!offering) throw new ApiError(404, "Offering not found");
  return success(res, { offering, coverage: await loadCoverage(offering) });
}

// ─── GET /admin/offerings/warnings (advisory) ────────────────────────────────
async function getRateWarnings(req, res) {
  const probeKg = req.query.probeKg ? Number(req.query.probeKg) : 10;
  if (!Number.isFinite(probeKg) || probeKg <= 0) throw new ApiError(400, "probeKg must be a number greater than 0");
  const [zoneRows, bands] = await Promise.all([
    prisma.zoneMatrix.findMany({ where: { isActive: true }, distinct: ["zone"], select: { zone: true }, orderBy: { zone: "asc" } }),
    prisma.priceBand.findMany({ where: { isActive: true } }),
  ]);
  return success(res, { advisory: true, probeKg, warnings: rateWarnings({ bands, zones: zoneRows.map((z) => z.zone), probeKg }) });
}

// ─── POST /admin/offerings ───────────────────────────────────────────────────
// Defining an offering says "BowaGO operates this product". It is created
// INACTIVE unless explicitly activated, and activation is gated on coverage.
async function createOffering(req, res) {
  const { shipmentMode, serviceType } = req.body;
  if (!MODES.includes(shipmentMode)) throw new ApiError(400, `shipmentMode must be one of ${MODES.join(", ")}`);
  if (!SERVICES.includes(serviceType)) throw new ApiError(400, `serviceType must be one of ${SERVICES.join(", ")}`);
  const fields = cleanFields(req.body);
  const wantsActive = fields.isActive === true;
  fields.isActive = false;

  const dup = await prisma.serviceOffering.findUnique({ where: { shipmentMode_serviceType: { shipmentMode, serviceType } } });
  if (dup) throw new ApiError(409, `${shipmentMode} + ${serviceType} is already defined`);

  let offering = await prisma.serviceOffering.create({
    data: { shipmentMode, serviceType, ...fields, createdBy: req.user.id },
  });
  await audit(req, offering.id, "CREATE", null, offering);

  let note = "Offering created inactive. Add rates and SLAs, then activate it.";
  if (wantsActive) {
    const coverage = await loadCoverage(offering);
    if (coverage.some((c) => c.sellable)) {
      offering = await prisma.serviceOffering.update({ where: { id: offering.id }, data: { isActive: true } });
      await audit(req, offering.id, "ACTIVATE", null, offering);
      note = "Offering created and activated.";
    } else {
      note = "Offering created inactive: it has no zone with both a rate and a delivery SLA yet, so it cannot be activated.";
    }
  }
  return created(res, { offering }, note);
}

// ─── PATCH /admin/offerings/:id ──────────────────────────────────────────────
async function updateOffering(req, res) {
  const existing = await prisma.serviceOffering.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new ApiError(404, "Offering not found");
  const fields = cleanFields(req.body);

  const activating = fields.isActive === true && !existing.isActive;
  if (activating) {
    const merged = { ...existing, ...fields };
    const coverage = await loadCoverage(merged);
    if (!coverage.some((c) => c.sellable)) {
      throw new ApiError(
        400,
        "Cannot activate: no zone has both a usable rate and a delivery SLA for this offering (or enable 'allows no SLA').",
        coverage.map((c) => ({ zone: c.zone, missing: c.missing })),
        "OFFERING_NOT_SELLABLE",
      );
    }
  }

  const offering = await prisma.serviceOffering.update({ where: { id: existing.id }, data: fields });
  await audit(req, offering.id, activating ? "ACTIVATE" : fields.isActive === false && existing.isActive ? "DEACTIVATE" : "UPDATE", existing, offering);
  return success(res, { offering }, "Offering updated");
}

// ─── Lanes ───────────────────────────────────────────────────────────────────
async function addLane(req, res) {
  const offering = await prisma.serviceOffering.findUnique({ where: { id: req.params.id } });
  if (!offering) throw new ApiError(404, "Offering not found");
  const { fromCityId, toCityId, zone, isAvailable, reason } = req.body;
  const hasCity = !!(fromCityId || toCityId);
  const hasZone = zone !== undefined && zone !== null && zone !== "";
  if (!hasCity && !hasZone) throw new ApiError(400, "Provide a city pair (fromCityId/toCityId) or a zone");
  if (hasCity && hasZone) throw new ApiError(400, "Provide either cities or a zone, not both");
  if (hasZone && !Number.isInteger(Number(zone))) throw new ApiError(400, "zone must be a whole number");

  const lane = await prisma.offeringLane.create({
    data: {
      offeringId: offering.id,
      fromCityId: fromCityId || null,
      toCityId: toCityId || null,
      zone: hasZone ? Number(zone) : null,
      isAvailable: isAvailable !== false,
      reason: reason || null,
      createdBy: req.user.id,
    },
  });
  await audit(req, offering.id, "LANE_ADD", null, lane);
  return created(res, { lane }, "Lane rule added");
}

async function removeLane(req, res) {
  const lane = await prisma.offeringLane.findUnique({ where: { id: req.params.laneId } });
  if (!lane || lane.offeringId !== req.params.id) throw new ApiError(404, "Lane rule not found");
  await prisma.offeringLane.delete({ where: { id: lane.id } });
  await audit(req, req.params.id, "LANE_REMOVE", lane, null);
  return success(res, {}, "Lane rule removed");
}

module.exports = { listOfferings, getCoverage, getRateWarnings, createOffering, updateOffering, addLane, removeLane };
