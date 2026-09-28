// ─── adhocCharge.controller.js ────────────────────────────────────────────────
// V1 Feature 5 — Admin defines, edits and deactivates adhoc charge types
// (oversize handling, extra packaging, storage, re-delivery, weekend pickup,
// etc). Charges are never hard-deleted. Every create/update/deactivate writes
// an immutable entry to PriceAuditLog (entityType "AdhocChargeType") — the
// exact same audit pattern PriceBand rates already use, so admins get one
// consistent history/rollback UI instead of a second bespoke table.
const { prisma } = require("../config/db");
const { ApiError } = require("../utils/ApiError");
const { success, created, getPagination, buildMeta } = require("../utils/helpers");

const CALC_METHODS = ["FIXED", "PER_KG", "PERCENTAGE"];

function validateCalc({ calcMethod, amountKobo, percentage }) {
  if (!CALC_METHODS.includes(calcMethod)) {
    throw new ApiError(400, `calcMethod must be one of ${CALC_METHODS.join(", ")}`);
  }
  if (calcMethod === "PERCENTAGE") {
    if (percentage === undefined || percentage === null || percentage <= 0) {
      throw new ApiError(400, "percentage is required and must be greater than 0 for calcMethod PERCENTAGE");
    }
  } else if (amountKobo === undefined || amountKobo === null || amountKobo <= 0) {
    throw new ApiError(400, `amountKobo is required and must be greater than 0 for calcMethod ${calcMethod}`);
  }
}

// ─── Admin: create a charge type ─────────────────────────────────────────────
async function createChargeType(req, res) {
  const {
    name,
    description,
    calcMethod,
    amountKobo,
    percentage,
    vatApplicable,
    applicableModes,
    effectiveFrom,
    effectiveTo,
    isActive,
  } = req.body;

  if (!name || !name.trim()) throw new ApiError(400, "name is required");
  validateCalc({ calcMethod, amountKobo, percentage });

  const chargeType = await prisma.adhocChargeType.create({
    data: {
      name: name.trim(),
      description: description || null,
      calcMethod,
      amountKobo: calcMethod === "PERCENTAGE" ? null : parseInt(amountKobo, 10),
      percentage: calcMethod === "PERCENTAGE" ? parseFloat(percentage) : null,
      vatApplicable: vatApplicable !== undefined ? !!vatApplicable : true,
      applicableModes: Array.isArray(applicableModes) ? applicableModes : [],
      effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : null,
      effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
      isActive: isActive !== undefined ? !!isActive : true,
      createdBy: req.user.id,
    },
  });

  await prisma.priceAuditLog.create({
    data: {
      entityType: "AdhocChargeType",
      entityId: chargeType.id,
      action: "CREATE",
      newValue: chargeType,
      changedBy: req.user.id,
    },
  });

  return created(res, { chargeType }, "Adhoc charge type created");
}

// ─── Admin: list charge types ─────────────────────────────────────────────────
async function listChargeTypes(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { isActive, search } = req.query;

  const where = {
    ...(isActive !== undefined && { isActive: isActive === "true" }),
    ...(search && { name: { contains: search, mode: "insensitive" } }),
  };

  const [chargeTypes, total] = await Promise.all([
    prisma.adhocChargeType.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.adhocChargeType.count({ where }),
  ]);

  return res.json({ success: true, data: { chargeTypes }, meta: buildMeta(total, page, limit) });
}

// ─── Admin: get one charge type ───────────────────────────────────────────────
async function getChargeType(req, res) {
  const { id } = req.params;
  const chargeType = await prisma.adhocChargeType.findUnique({ where: { id } });
  if (!chargeType) throw new ApiError(404, "Adhoc charge type not found");
  return success(res, { chargeType });
}

// ─── Admin: update a charge type (creates a new version) ────────────────────
async function updateChargeType(req, res) {
  const { id } = req.params;
  const existing = await prisma.adhocChargeType.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "Adhoc charge type not found");

  const {
    name,
    description,
    calcMethod,
    amountKobo,
    percentage,
    vatApplicable,
    applicableModes,
    effectiveFrom,
    effectiveTo,
    reason,
  } = req.body;

  const resolvedCalcMethod = calcMethod || existing.calcMethod;
  if (
    calcMethod !== undefined ||
    amountKobo !== undefined ||
    percentage !== undefined
  ) {
    validateCalc({
      calcMethod: resolvedCalcMethod,
      amountKobo: amountKobo !== undefined ? amountKobo : existing.amountKobo,
      percentage: percentage !== undefined ? percentage : existing.percentage,
    });
  }

  const data = {
    ...(name !== undefined && { name: name.trim() }),
    ...(description !== undefined && { description }),
    ...(calcMethod !== undefined && { calcMethod }),
    ...(amountKobo !== undefined && {
      amountKobo: resolvedCalcMethod === "PERCENTAGE" ? null : parseInt(amountKobo, 10),
    }),
    ...(percentage !== undefined && {
      percentage: resolvedCalcMethod === "PERCENTAGE" ? parseFloat(percentage) : null,
    }),
    ...(vatApplicable !== undefined && { vatApplicable: !!vatApplicable }),
    ...(applicableModes !== undefined && { applicableModes }),
    ...(effectiveFrom !== undefined && {
      effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : null,
    }),
    ...(effectiveTo !== undefined && {
      effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
    }),
    version: { increment: 1 },
  };

  const chargeType = await prisma.adhocChargeType.update({ where: { id }, data });

  await prisma.priceAuditLog.create({
    data: {
      entityType: "AdhocChargeType",
      entityId: id,
      action: "UPDATE",
      previousValue: existing,
      newValue: chargeType,
      changedBy: req.user.id,
      reason: reason || null,
    },
  });

  return success(res, { chargeType }, "Adhoc charge type updated");
}

// ─── Admin: deactivate (never delete) ────────────────────────────────────────
async function deactivateChargeType(req, res) {
  const { id } = req.params;
  const existing = await prisma.adhocChargeType.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "Adhoc charge type not found");

  const chargeType = await prisma.adhocChargeType.update({
    where: { id },
    data: { isActive: false, version: { increment: 1 } },
  });

  await prisma.priceAuditLog.create({
    data: {
      entityType: "AdhocChargeType",
      entityId: id,
      action: "UPDATE",
      previousValue: existing,
      newValue: chargeType,
      changedBy: req.user.id,
      reason: req.body?.reason || "Deactivated",
    },
  });

  return success(res, { chargeType }, "Adhoc charge type deactivated");
}

// ─── Admin: version history (viewing is itself logged, per PRD) ─────────────
async function getChargeTypeHistory(req, res) {
  const { id } = req.params;
  const chargeType = await prisma.adhocChargeType.findUnique({ where: { id } });
  if (!chargeType) throw new ApiError(404, "Adhoc charge type not found");

  const history = await prisma.priceAuditLog.findMany({
    where: { entityType: "AdhocChargeType", entityId: id },
    orderBy: { createdAt: "desc" },
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
  });

  await prisma.activityLog.create({
    data: {
      userId: req.user.id,
      action: "VIEW_ADHOC_CHARGE_HISTORY",
      resource: "AdhocChargeType",
      resourceId: id,
    },
  }).catch(() => {});

  return success(res, { history });
}

module.exports = {
  createChargeType,
  listChargeTypes,
  getChargeType,
  updateChargeType,
  deactivateChargeType,
  getChargeTypeHistory,
};
