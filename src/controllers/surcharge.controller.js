const { prisma } = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { success, created } = require('../utils/helpers');

// ─── List all surcharges (public — used in quote breakdown) ───────────────────
async function listSurcharges(req, res) {
  const { active } = req.query;
  const surcharges = await prisma.surcharge.findMany({
    where: active === 'true' ? { isActive: true } : {},
    orderBy: { type: 'asc' },
  });
  return success(res, { surcharges });
}

// ─── Create surcharge (Admin) ─────────────────────────────────────────────────
async function createSurcharge(req, res) {
  const { type, label, description, ratePercent, flatAmount, appliesTo } = req.body;

  if (!ratePercent && !flatAmount) {
    throw new ApiError(400, 'Provide either ratePercent or flatAmount');
  }

  // Log to price audit trail
  const surcharge = await prisma.surcharge.create({
    data: { type, label, description, ratePercent, flatAmount, appliesTo: appliesTo || 'ALL' },
  });

  await prisma.priceAuditLog.create({
    data: {
      entityType: 'Surcharge',
      entityId: surcharge.id,
      action: 'CREATE',
      newValue: surcharge,
      changedBy: req.user.id,
    },
  });

  return created(res, { surcharge }, 'Surcharge created');
}

// ─── Update surcharge (Admin) ─────────────────────────────────────────────────
async function updateSurcharge(req, res) {
  const { id } = req.params;

  const existing = await prisma.surcharge.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Surcharge not found');

  const surcharge = await prisma.surcharge.update({
    where: { id },
    data: req.body,
  });

  await prisma.priceAuditLog.create({
    data: {
      entityType: 'Surcharge',
      entityId: id,
      action: 'UPDATE',
      previousValue: existing,
      newValue: surcharge,
      changedBy: req.user.id,
      reason: req.body.reason,
    },
  });

  return success(res, { surcharge }, 'Surcharge updated');
}

// ─── Delete surcharge ─────────────────────────────────────────────────────────
async function deleteSurcharge(req, res) {
  const { id } = req.params;

  const existing = await prisma.surcharge.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Surcharge not found');

  await prisma.surcharge.delete({ where: { id } });

  await prisma.priceAuditLog.create({
    data: {
      entityType: 'Surcharge',
      entityId: id,
      action: 'DELETE',
      previousValue: existing,
      changedBy: req.user.id,
    },
  });

  return success(res, {}, 'Surcharge deleted');
}

// ─── Calculate surcharges for a given base price ──────────────────────────────
// Called internally by the pricing service and also exposed as a utility endpoint
async function calculateSurcharges(basePrice, serviceType = 'STANDARD', options = {}) {
  const surcharges = await prisma.surcharge.findMany({
    where: {
      isActive: true,
      OR: [
        { appliesTo: 'ALL' },
        { appliesTo: serviceType },
      ],
    },
  });

  const breakdown = [];
  let totalSurcharge = 0;

  for (const s of surcharges) {
    // Skip fragile/insurance surcharges if not applicable
    if (s.type === 'FRAGILE' && !options.isFragile) continue;
    if (s.type === 'INSURANCE' && !options.requiresInsurance) continue;

    let amount = 0;
    if (s.ratePercent) {
      if (s.type === 'INSURANCE' && options.insuranceValue) {
        amount = Math.ceil(options.insuranceValue * (s.ratePercent / 100));
      } else {
        amount = Math.ceil(basePrice * (s.ratePercent / 100));
      }
    } else if (s.flatAmount) {
      amount = s.flatAmount;
    }

    if (amount > 0) {
      breakdown.push({
        type: s.type,
        label: s.label,
        description: s.description,
        amount,
      });
      totalSurcharge += amount;
    }
  }

  return { breakdown, totalSurcharge };
}

// ─── GET surcharge calculation preview ───────────────────────────────────────
async function previewSurcharges(req, res) {
  const { basePrice, serviceType, isFragile, requiresInsurance, insuranceValue } = req.body;

  if (!basePrice) throw new ApiError(400, 'basePrice is required');

  const result = await calculateSurcharges(
    parseFloat(basePrice),
    serviceType || 'STANDARD',
    { isFragile, requiresInsurance, insuranceValue }
  );

  return success(res, {
    basePrice: parseFloat(basePrice),
    ...result,
    grandTotal: parseFloat(basePrice) + result.totalSurcharge,
    currency: 'NGN',
  });
}

// ─── Price audit log ──────────────────────────────────────────────────────────
async function getPriceAuditLog(req, res) {
  const { entityType, page = 1 } = req.query;
  const limit = 50;
  const skip = (parseInt(page) - 1) * limit;

  const logs = await prisma.priceAuditLog.findMany({
    where: entityType ? { entityType } : {},
    skip,
    take: limit,
    orderBy: { createdAt: 'desc' },
    include: {
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  });

  return success(res, { logs });
}

module.exports = {
  listSurcharges,
  createSurcharge,
  updateSurcharge,
  deleteSurcharge,
  calculateSurcharges,
  previewSurcharges,
  getPriceAuditLog,
};
