// ─── shipmentMode.controller.js ──────────────────────────────────────────────
// V1 Feature 1 — GET/PATCH per-mode settings: volumetric divisor, default
// transit hours, and whether the mode is offered at all. Only ROLE_ADMIN
// (canManageRates — mode settings are part of the rate engine) can write;
// GET is open to any authenticated caller and to guests building a quote
// form (so the frontend knows which modes to offer).
const { prisma } = require("../config/db");
const { ApiError } = require("../utils/ApiError");
const { success } = require("../utils/helpers");
const { listModeSettings } = require("../services/pricing.service");

const MODES = ["AIR", "LAND", "SEA"];

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

  const { volumetricDivisor, transitHoursDefault, isActive } = req.body;

  const existing = await prisma.shipmentModeSetting.findUnique({ where: { mode } });

  const data = {
    ...(volumetricDivisor !== undefined && {
      volumetricDivisor: parseInt(volumetricDivisor, 10),
    }),
    ...(transitHoursDefault !== undefined && {
      transitHoursDefault: transitHoursDefault === null ? null : parseInt(transitHoursDefault, 10),
    }),
    ...(isActive !== undefined && { isActive: !!isActive }),
  };

  const updated = await prisma.shipmentModeSetting.upsert({
    where: { mode },
    update: data,
    create: {
      mode,
      volumetricDivisor: data.volumetricDivisor ?? 5000,
      transitHoursDefault: data.transitHoursDefault ?? null,
      isActive: data.isActive !== undefined ? data.isActive : true,
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
