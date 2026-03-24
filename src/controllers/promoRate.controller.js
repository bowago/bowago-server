const { prisma } = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { success, created, getPagination, buildMeta } = require('../utils/helpers');

// ─── Admin: Create promo code ─────────────────────────────────────────────────
async function createPromoRate(req, res) {
  const {
    code, label, description,
    discountPercent, flatDiscount,
    serviceType, zone, minWeightKg,
    maxUsageCount, validFrom, validUntil,
  } = req.body;

  if (!discountPercent && !flatDiscount)
    throw new ApiError(400, 'Provide either discountPercent or flatDiscount');
  if (discountPercent && flatDiscount)
    throw new ApiError(400, 'Only one discount type allowed');

  const upperCode = code.trim().toUpperCase();
  const exists = await prisma.promoRate.findUnique({ where: { code: upperCode } });
  if (exists) throw new ApiError(409, `Promo code "${upperCode}" already exists`);

  const promo = await prisma.promoRate.create({
    data: {
      code: upperCode,
      label,
      description,
      discountPercent: discountPercent ? parseFloat(discountPercent) : null,
      flatDiscount:    flatDiscount    ? parseFloat(flatDiscount)    : null,
      serviceType:     serviceType     || null,
      zone:            zone            ? parseInt(zone) : null,
      minWeightKg:     minWeightKg     ? parseFloat(minWeightKg) : null,
      maxUsageCount:   maxUsageCount   ? parseInt(maxUsageCount) : null,
      validFrom:       validFrom       ? new Date(validFrom)  : null,
      validUntil:      validUntil      ? new Date(validUntil) : null,
    },
  });

  return created(res, { promo }, 'Promo code created');
}

// ─── Admin: List all promo codes ──────────────────────────────────────────────
async function listPromoRates(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { isActive } = req.query;
  const where = isActive !== undefined ? { isActive: isActive === 'true' } : {};
  const [promos, total] = await Promise.all([
    prisma.promoRate.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
    prisma.promoRate.count({ where }),
  ]);
  return res.json({ success: true, data: { promos }, meta: buildMeta(total, page, limit) });
}

// ─── Admin: Update promo code ─────────────────────────────────────────────────
async function updatePromoRate(req, res) {
  const { id } = req.params;
  const existing = await prisma.promoRate.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Promo code not found');

  const { code, validFrom, validUntil, ...rest } = req.body;
  const promo = await prisma.promoRate.update({
    where: { id },
    data: {
      ...rest,
      ...(code       && { code:       code.trim().toUpperCase() }),
      ...(validFrom  && { validFrom:  new Date(validFrom) }),
      ...(validUntil && { validUntil: new Date(validUntil) }),
    },
  });
  return success(res, { promo }, 'Promo code updated');
}

// ─── Admin: Delete ────────────────────────────────────────────────────────────
async function deletePromoRate(req, res) {
  const { id } = req.params;
  await prisma.promoRate.delete({ where: { id } });
  return success(res, {}, 'Promo code deleted');
}

// ─── Public: Validate promo code (preview only — does NOT apply it) ───────────
async function validatePromoCode(req, res) {
  const { code, zone, serviceType, weightKg } = req.body;
  if (!code) throw new ApiError(400, 'Promo code is required');

  const now = new Date();
  const promo = await prisma.promoRate.findFirst({
    where: {
      code: { equals: code.trim().toUpperCase() },
      isActive: true,
      AND: [
        { OR: [{ serviceType: null }, { serviceType: serviceType || null }] },
        { OR: [{ zone: null }, { zone: zone ? parseInt(zone) : null }] },
        { OR: [{ minWeightKg: null }, { minWeightKg: { lte: weightKg ? parseFloat(weightKg) : 99999 } }] },
        { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
        { OR: [{ validUntil: null }, { validUntil: { gte: now } }] },
      ],
    },
  });

  if (!promo) {
    throw new ApiError(404, 'Promo code is invalid, expired, or does not apply to this shipment');
  }

  const usageRemaining = promo.maxUsageCount !== null
    ? Math.max(0, promo.maxUsageCount - promo.usageCount)
    : null;

  if (usageRemaining !== null && usageRemaining === 0) {
    throw new ApiError(400, 'This promo code has reached its usage limit');
  }

  return success(res, {
    valid: true,
    promo: {
      code:            promo.code,
      label:           promo.label,
      description:     promo.description,
      discountPercent: promo.discountPercent,
      flatDiscount:    promo.flatDiscount,
      validUntil:      promo.validUntil,
      usageRemaining,
    },
  }, `"${promo.code}" is valid — ${promo.label}`);
}

module.exports = {
  createPromoRate, listPromoRates, updatePromoRate,
  deletePromoRate, validatePromoCode,
};
