// ─── adhocChargeRule.controller.js ───────────────────────────────────────────
// V1 Feature 6 — Admin defines rules comparing a parcel's weight/volume to a
// threshold, linked to one AdhocChargeType, with AUTO_APPLY or SUGGEST
// behaviour. Same immutable-history pattern as PriceBand/AdhocChargeType,
// via PriceAuditLog (entityType "AdhocChargeRule").
const { prisma } = require("../config/db");
const { ApiError } = require("../utils/ApiError");
const { success, created, getPagination, buildMeta } = require("../utils/helpers");

const METRICS = ["ACTUAL_WEIGHT", "VOLUMETRIC_WEIGHT", "BILLABLE_WEIGHT", "VOLUME_CM3", "LONGEST_SIDE"];
const OPERATORS = ["GT", "GTE", "LT", "LTE", "BETWEEN"];
const BEHAVIOURS = ["AUTO_APPLY", "SUGGEST"];

function validateRuleShape({ metric, operator, thresholdMin, thresholdMax, behaviour }) {
  if (!METRICS.includes(metric)) throw new ApiError(400, `metric must be one of ${METRICS.join(", ")}`);
  if (!OPERATORS.includes(operator)) throw new ApiError(400, `operator must be one of ${OPERATORS.join(", ")}`);
  if (thresholdMin === undefined || thresholdMin === null) {
    throw new ApiError(400, "thresholdMin is required");
  }
  if (operator === "BETWEEN" && (thresholdMax === undefined || thresholdMax === null)) {
    throw new ApiError(400, "thresholdMax is required when operator is BETWEEN");
  }
  if (behaviour && !BEHAVIOURS.includes(behaviour)) {
    throw new ApiError(400, `behaviour must be one of ${BEHAVIOURS.join(", ")}`);
  }
}

// ─── Admin: create a rule ─────────────────────────────────────────────────────
async function createRule(req, res) {
  const {
    name,
    metric,
    operator,
    thresholdMin,
    thresholdMax,
    chargeTypeId,
    behaviour,
    applicableModes,
    priority,
    effectiveFrom,
    effectiveTo,
    isActive,
  } = req.body;

  if (!name || !name.trim()) throw new ApiError(400, "name is required");
  validateRuleShape({ metric, operator, thresholdMin, thresholdMax, behaviour });

  const chargeType = await prisma.adhocChargeType.findUnique({ where: { id: chargeTypeId } });
  if (!chargeType) throw new ApiError(404, "Linked adhoc charge type not found");

  const rule = await prisma.adhocChargeRule.create({
    data: {
      name: name.trim(),
      metric,
      operator,
      thresholdMin: parseFloat(thresholdMin),
      thresholdMax: thresholdMax !== undefined && thresholdMax !== null ? parseFloat(thresholdMax) : null,
      chargeTypeId,
      behaviour: behaviour || "SUGGEST",
      applicableModes: Array.isArray(applicableModes) ? applicableModes : [],
      priority: priority !== undefined ? parseInt(priority, 10) : 0,
      effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : null,
      effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
      isActive: isActive !== undefined ? !!isActive : true,
      createdBy: req.user.id,
    },
    include: { chargeType: true },
  });

  await prisma.priceAuditLog.create({
    data: {
      entityType: "AdhocChargeRule",
      entityId: rule.id,
      action: "CREATE",
      newValue: rule,
      changedBy: req.user.id,
    },
  });

  return created(res, { rule }, "Adhoc charge rule created");
}

// ─── Admin: list rules ─────────────────────────────────────────────────────────
async function listRules(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { isActive, behaviour, chargeTypeId } = req.query;

  const where = {
    ...(isActive !== undefined && { isActive: isActive === "true" }),
    ...(behaviour && { behaviour }),
    ...(chargeTypeId && { chargeTypeId }),
  };

  const [rules, total] = await Promise.all([
    prisma.adhocChargeRule.findMany({
      where,
      skip,
      take: limit,
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
      include: { chargeType: { select: { id: true, name: true, calcMethod: true } } },
    }),
    prisma.adhocChargeRule.count({ where }),
  ]);

  return res.json({ success: true, data: { rules }, meta: buildMeta(total, page, limit) });
}

// ─── Admin: get one rule ───────────────────────────────────────────────────────
async function getRule(req, res) {
  const { id } = req.params;
  const rule = await prisma.adhocChargeRule.findUnique({
    where: { id },
    include: { chargeType: true },
  });
  if (!rule) throw new ApiError(404, "Adhoc charge rule not found");
  return success(res, { rule });
}

// ─── Admin: update a rule (creates a new version) ─────────────────────────────
async function updateRule(req, res) {
  const { id } = req.params;
  const existing = await prisma.adhocChargeRule.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "Adhoc charge rule not found");

  const {
    name,
    metric,
    operator,
    thresholdMin,
    thresholdMax,
    chargeTypeId,
    behaviour,
    applicableModes,
    priority,
    effectiveFrom,
    effectiveTo,
    isActive,
    reason,
  } = req.body;

  if (metric !== undefined || operator !== undefined || thresholdMin !== undefined || thresholdMax !== undefined || behaviour !== undefined) {
    validateRuleShape({
      metric: metric !== undefined ? metric : existing.metric,
      operator: operator !== undefined ? operator : existing.operator,
      thresholdMin: thresholdMin !== undefined ? thresholdMin : existing.thresholdMin,
      thresholdMax: thresholdMax !== undefined ? thresholdMax : existing.thresholdMax,
      behaviour: behaviour !== undefined ? behaviour : existing.behaviour,
    });
  }

  if (chargeTypeId) {
    const chargeType = await prisma.adhocChargeType.findUnique({ where: { id: chargeTypeId } });
    if (!chargeType) throw new ApiError(404, "Linked adhoc charge type not found");
  }

  const data = {
    ...(name !== undefined && { name: name.trim() }),
    ...(metric !== undefined && { metric }),
    ...(operator !== undefined && { operator }),
    ...(thresholdMin !== undefined && { thresholdMin: parseFloat(thresholdMin) }),
    ...(thresholdMax !== undefined && {
      thresholdMax: thresholdMax === null ? null : parseFloat(thresholdMax),
    }),
    ...(chargeTypeId !== undefined && { chargeTypeId }),
    ...(behaviour !== undefined && { behaviour }),
    ...(applicableModes !== undefined && { applicableModes }),
    ...(priority !== undefined && { priority: parseInt(priority, 10) }),
    ...(effectiveFrom !== undefined && { effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : null }),
    ...(effectiveTo !== undefined && { effectiveTo: effectiveTo ? new Date(effectiveTo) : null }),
    ...(isActive !== undefined && { isActive: !!isActive }),
    version: { increment: 1 },
  };

  const rule = await prisma.adhocChargeRule.update({
    where: { id },
    data,
    include: { chargeType: true },
  });

  await prisma.priceAuditLog.create({
    data: {
      entityType: "AdhocChargeRule",
      entityId: id,
      action: "UPDATE",
      previousValue: existing,
      newValue: rule,
      changedBy: req.user.id,
      reason: reason || null,
    },
  });

  return success(res, { rule }, "Adhoc charge rule updated");
}

// ─── Admin: deactivate ─────────────────────────────────────────────────────────
async function deactivateRule(req, res) {
  const { id } = req.params;
  const existing = await prisma.adhocChargeRule.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "Adhoc charge rule not found");

  const rule = await prisma.adhocChargeRule.update({
    where: { id },
    data: { isActive: false, version: { increment: 1 } },
  });

  await prisma.priceAuditLog.create({
    data: {
      entityType: "AdhocChargeRule",
      entityId: id,
      action: "UPDATE",
      previousValue: existing,
      newValue: rule,
      changedBy: req.user.id,
      reason: req.body?.reason || "Deactivated",
    },
  });

  return success(res, { rule }, "Adhoc charge rule deactivated");
}

// ─── Admin: version history ───────────────────────────────────────────────────
async function getRuleHistory(req, res) {
  const { id } = req.params;
  const rule = await prisma.adhocChargeRule.findUnique({ where: { id } });
  if (!rule) throw new ApiError(404, "Adhoc charge rule not found");

  const history = await prisma.priceAuditLog.findMany({
    where: { entityType: "AdhocChargeRule", entityId: id },
    orderBy: { createdAt: "desc" },
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
  });

  await prisma.activityLog.create({
    data: {
      userId: req.user.id,
      action: "VIEW_ADHOC_CHARGE_RULE_HISTORY",
      resource: "AdhocChargeRule",
      resourceId: id,
    },
  }).catch(() => {});

  return success(res, { history });
}

module.exports = {
  createRule,
  listRules,
  getRule,
  updateRule,
  deactivateRule,
  getRuleHistory,
};
