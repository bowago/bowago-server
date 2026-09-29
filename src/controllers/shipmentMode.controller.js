// ─── shipmentMode.controller.js ──────────────────────────────────────────────
// GET/PATCH per-mode PHYSICAL / OPERATIONAL settings: volumetric divisor,
// weight & dimension limits, and whether the mode is offered at all.
//
// A mode setting is NOT a delivery promise. The customer-facing SLA belongs to
// an offering on a lane (DeliverySLA: zone + mode + service), so
// `transitHoursDefault` is deprecated and can no longer be written here.
//
// Only ROLE_ADMIN (canManageRates) can write; GET is open so quote forms know
// which modes exist.
const { prisma } = require("../config/db");
const { ApiError } = require("../utils/ApiError");
const { success } = require("../utils/helpers");
const { listModeSettings } = require("../services/pricing.service");

const MODES = ["AIR", "LAND", "SEA"];

function optionalPositive(name, v) {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new ApiError(400, `${name} must be a number greater than 0 (or empty for no limit)`);
  return n;
}

// ─── Public/optional-auth: list mode settings (for the quote form) ──────────
async function listModes(req, res) {
  const modes = await listModeSettings();
  return success(res, { modes });
}

// ─── Admin: update one mode's settings ────────────────────────────────────────
async function updateMode(req, res) {
  const { mode } = req.params;
  if (!MODES.includes(mode)) {
    throw new ApiError(400, `mode must be one of ${MODES.join(", ")}`);
  }

  const { volumetricDivisor, isActive, maxWeightKg, maxLongestSideCm, notes, transitHoursDefault } = req.body;

  if (transitHoursDefault !== undefined) {
    throw new ApiError(
      400,
      "transitHoursDefault is deprecated and is not a delivery promise. Configure delivery times per zone under Delivery SLA (zone + mode + service).",
    );
  }

  const existing = await prisma.shipmentModeSetting.findUnique({ where: { mode } });

  let divisor;
  if (volumetricDivisor !== undefined) {
    divisor = parseInt(volumetricDivisor, 10);
    if (!Number.isInteger(divisor) || divisor <= 0) throw new ApiError(400, "volumetricDivisor must be a whole number greater than 0");
  }
  const maxW = optionalPositive("maxWeightKg", maxWeightKg);
  const maxSide = optionalPositive("maxLongestSideCm", maxLongestSideCm);

  const data = {
    ...(divisor !== undefined && { volumetricDivisor: divisor }),
    ...(isActive !== undefined && { isActive: !!isActive }),
    ...(maxW !== undefined && { maxWeightKg: maxW }),
    ...(maxSide !== undefined && { maxLongestSideCm: maxSide }),
    ...(notes !== undefined && { notes: notes || null }),
  };

  const updated = await prisma.shipmentModeSetting.upsert({
    where: { mode },
    update: data,
    create: {
      mode,
      volumetricDivisor: data.volumetricDivisor ?? 5000,
      isActive: data.isActive !== undefined ? data.isActive : true,
      maxWeightKg: data.maxWeightKg ?? null,
      maxLongestSideCm: data.maxLongestSideCm ?? null,
      notes: data.notes ?? null,
    },
  });

  await prisma.priceAuditLog.create({
    data: {
      entityType: "ShipmentModeSetting",
      entityId: updated.id,
      action: existing ? "UPDATE" : "CREATE",
      previousValue: existing || null,
      newValue: updated,
      changedBy: req.user.id,
      reason: req.body.reason || null,
    },
  });

  return success(res, { mode: updated }, "Shipment mode settings updated");
}

module.exports = { listModes, updateMode };
