// ─── deliverySLA.controller.js ───────────────────────────────────────────────
// Delivery promise per ZONE × SHIPMENT MODE × SERVICE TYPE.
//
// The promise depends on how freight physically moves (mode) as well as on the
// service commitment, so the mode is part of the key. There are no fallback
// values anywhere: an offering with no SLA for a zone is simply not sellable
// there (unless the offering explicitly allows no-SLA service).
const { prisma } = require("../config/db");
const { ApiError } = require("../utils/ApiError");
const { success } = require("../utils/helpers");
const { formatDeliveryLabel } = require("../services/pricing.service");

const MODES = ["AIR", "LAND", "SEA"];
const SERVICES = ["EXPRESS", "STANDARD", "ECONOMY"];

function parseDays(minDays, maxDays) {
  const min = Number(minDays);
  const max = Number(maxDays);
  // 0 is a legitimate value (same-day); only reject missing / non-integer / negative.
  if (minDays === undefined || minDays === null || minDays === "" || maxDays === undefined || maxDays === null || maxDays === "") {
    throw new ApiError(400, "minDays and maxDays are required");
  }
  if (!Number.isInteger(min) || !Number.isInteger(max)) throw new ApiError(400, "minDays and maxDays must be whole numbers");
  if (min < 0 || max < 0) throw new ApiError(400, "Days must be positive numbers");
  if (min > max) throw new ApiError(400, "minDays cannot be greater than maxDays");
  return { min, max };
}

function parseKey({ zone, shipmentMode, serviceType }) {
  const z = Number(zone);
  if (!Number.isInteger(z) || z < 0) throw new ApiError(400, "zone must be a whole number");
  if (!MODES.includes(shipmentMode)) throw new ApiError(400, `shipmentMode must be one of ${MODES.join(", ")}`);
  const svc = String(serviceType || "").toUpperCase();
  if (!SERVICES.includes(svc)) throw new ApiError(400, `serviceType must be one of ${SERVICES.join(", ")}`);
  return { zone: z, shipmentMode, serviceType: svc };
}

async function audit(req, entityId, action, previousValue, newValue) {
  await prisma.priceAuditLog.create({
    data: {
      entityType: "DeliverySLA", entityId, action,
      previousValue: previousValue || undefined, newValue: newValue || undefined,
      changedBy: req.user.id, reason: req.body?.reason || null,
    },
  });
}

// ─── GET /pricing/delivery-sla ───────────────────────────────────────────────
// Public read (admin screens + diagnostics). Customer-facing UIs must NOT build
// their own delivery times from this — they use the offerings endpoint, which
// resolves the SLA server-side for the exact product and route.
async function listSLAs(req, res) {
  const { zone, shipmentMode, serviceType } = req.query;
  const slas = await prisma.deliverySLA.findMany({
    where: {
      ...(zone !== undefined && zone !== "" && { zone: Number(zone) }),
      ...(shipmentMode && { shipmentMode }),
      ...(serviceType && { serviceType: String(serviceType).toUpperCase() }),
    },
    orderBy: [{ shipmentMode: "asc" }, { zone: "asc" }, { serviceType: "asc" }],
  });
  return success(res, { slas });
}

// ─── PUT /pricing/delivery-sla ───────────────────────────────────────────────
// Create or update the SLA for one zone + mode + service.
async function upsertSLA(req, res) {
  const key = parseKey(req.body);
  const { min, max } = parseDays(req.body.minDays, req.body.maxDays);

  // An SLA for a product BowaGO does not offer would be dead configuration.
  const offering = await prisma.serviceOffering.findUnique({
    where: { shipmentMode_serviceType: { shipmentMode: key.shipmentMode, serviceType: key.serviceType } },
  });
  if (!offering) {
    throw new ApiError(400, `${key.shipmentMode} + ${key.serviceType} is not a defined offering. Create the offering first.`);
  }

  const existing = await prisma.deliverySLA.findUnique({ where: { zone_shipmentMode_serviceType: key } });
  const data = { minDays: min, maxDays: max, label: formatDeliveryLabel(min, max) };
  const sla = await prisma.deliverySLA.upsert({
    where: { zone_shipmentMode_serviceType: key },
    update: data,
    create: { ...key, ...data, createdBy: req.user?.id },
  });
  await audit(req, sla.id, existing ? "UPDATE" : "CREATE", existing, sla);
  return success(res, { sla }, "Delivery SLA saved");
}

// ─── PATCH /pricing/delivery-sla/:id ─────────────────────────────────────────
async function updateSLA(req, res) {
  const { id } = req.params;
  const { min, max } = parseDays(req.body.minDays, req.body.maxDays);
  const existing = await prisma.deliverySLA.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "Delivery SLA not found");

  const sla = await prisma.deliverySLA.update({
    where: { id },
    data: { minDays: min, maxDays: max, label: formatDeliveryLabel(min, max) },
  });
  await audit(req, id, "UPDATE", existing, sla);
  return success(res, { sla }, "Delivery SLA updated");
}

// ─── DELETE /pricing/delivery-sla/:id ────────────────────────────────────────
// Removing an SLA makes that offering unsellable in that zone (by design).
async function deleteSLA(req, res) {
  const { id } = req.params;
  const existing = await prisma.deliverySLA.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "Delivery SLA not found");
  await prisma.deliverySLA.delete({ where: { id } });
  await audit(req, id, "DELETE", existing, null);
  return success(res, {}, "Delivery SLA removed — this option is no longer sellable in that zone");
}

module.exports = { listSLAs, upsertSLA, updateSLA, deleteSLA };
