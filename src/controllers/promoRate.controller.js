const { prisma } = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { success, created, getPagination, buildMeta } = require('../utils/helpers');

// ─── Admin: Create Promo Rate ─────────────────────────────────────────────────
// PromoRate = admin-defined time-limited discount bands (zone/service aware).
// Distinct from PromoCode (customer coupon codes like "LAUNCH20").
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
    throw new ApiError(400, 'Only one discount type allowed — provide discountPercent OR flatDiscount, not both');

  const upperCode = code.trim().toUpperCase();
  const exists = await prisma.promoRate.findUnique({ where: { code: upperCode } });
  if (exists) throw new ApiError(409, `Promo rate code "${upperCode}" already exists`);

  const promo = await prisma.promoRate.create({
    data: {
      code:          upperCode,
      label:         label || null,
      description:   description || null,
      discountPercent: discountPercent ? parseFloat(discountPercent) : null,
      flatDiscount:    flatDiscount    ? parseFloat(flatDiscount)    : null,
      serviceType:   serviceType || null,
      zone:          zone !== undefined && zone !== null ? parseInt(zone) : null,
      minWeightKg:   minWeightKg  ? parseFloat(minWeightKg) : null,
      maxUsageCount: maxUsageCount ? parseInt(maxUsageCount) : null,
      validFrom:     validFrom  ? new Date(validFrom)  : null,
      validUntil:    validUntil ? new Date(validUntil) : null,
      createdBy:     req.user.id,
    },
  });

  return created(res, { promo }, 'Promo rate created');
}

// ─── Admin: List all Promo Rates ──────────────────────────────────────────────
async function listPromoRates(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { isActive, serviceType, zone } = req.query;

  const where = {
    ...(isActive !== undefined && { isActive: isActive === 'true' }),
    ...(serviceType && { serviceType }),
    ...(zone !== undefined && { zone: parseInt(zone) }),
  };

  const [promos, total] = await Promise.all([
    prisma.promoRate.findMany({
      where, skip, take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.promoRate.count({ where }),
  ]);

  return res.json({ success: true, data: { promos }, meta: buildMeta(total, page, limit) });
}

// ─── Admin: Get single Promo Rate ─────────────────────────────────────────────
async function getPromoRate(req, res) {
  const { id } = req.params;
  const promo = await prisma.promoRate.findUnique({ where: { id } });
  if (!promo) throw new ApiError(404, 'Promo rate not found');
  return success(res, { promo });
}

// ─── Admin: Update Promo Rate ─────────────────────────────────────────────────
async function updatePromoRate(req, res) {
  const { id } = req.params;
  const existing = await prisma.promoRate.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Promo rate not found');

  const { code, validFrom, validUntil, discountPercent, flatDiscount, zone, minWeightKg, maxUsageCount, ...rest } = req.body;

  const newDiscount = discountPercent !== undefined ? discountPercent : existing.discountPercent;
  const newFlat     = flatDiscount    !== undefined ? flatDiscount    : existing.flatDiscount;
  if (newDiscount && newFlat)
    throw new ApiError(400, 'Only one discount type allowed — provide discountPercent OR flatDiscount, not both');

  const promo = await prisma.promoRate.update({
    where: { id },
    data: {
      ...rest,
      ...(code       && { code:       code.trim().toUpperCase() }),
      ...(validFrom  !== undefined && { validFrom:  validFrom  ? new Date(validFrom)  : null }),
      ...(validUntil !== undefined && { validUntil: validUntil ? new Date(validUntil) : null }),
      ...(discountPercent !== undefined && { discountPercent: discountPercent ? parseFloat(discountPercent) : null }),
      ...(flatDiscount    !== undefined && { flatDiscount:    flatDiscount    ? parseFloat(flatDiscount)    : null }),
      ...(zone        !== undefined && { zone:        zone        !== null ? parseInt(zone)        : null }),
      ...(minWeightKg !== undefined && { minWeightKg: minWeightKg !== null ? parseFloat(minWeightKg) : null }),
      ...(maxUsageCount !== undefined && { maxUsageCount: maxUsageCount !== null ? parseInt(maxUsageCount) : null }),
    },
  });

  return success(res, { promo }, 'Promo rate updated');
}

// ─── Admin: Delete Promo Rate ─────────────────────────────────────────────────
async function deletePromoRate(req, res) {
  const { id } = req.params;
  const existing = await prisma.promoRate.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Promo rate not found');

  await prisma.promoRate.delete({ where: { id } });
  return success(res, {}, 'Promo rate deleted');
}

// ─── Public: Validate a promo rate code (preview — does NOT apply it) ─────────
async function validatePromoCode(req, res) {
  const { code, zone, serviceType, weightKg } = req.body;
  if (!code) throw new ApiError(400, 'Promo code is required');

  const now = new Date();
  const promo = await prisma.promoRate.findFirst({
    where: {
      code:     { equals: code.trim().toUpperCase() },
      isActive: true,
      AND: [
        { OR: [{ serviceType: null }, { serviceType: serviceType || null }] },
        { OR: [{ zone: null },        { zone: zone ? parseInt(zone) : undefined }] },
        { OR: [{ minWeightKg: null }, { minWeightKg: { lte: weightKg ? parseFloat(weightKg) : 99999 } }] },
        { OR: [{ validFrom: null },   { validFrom:  { lte: now } }] },
        { OR: [{ validUntil: null },  { validUntil: { gte: now } }] },
      ],
    },
  });

  if (!promo) {
    throw new ApiError(404, 'Promo rate is invalid, expired, or does not apply to this shipment');
  }

  const usageRemaining = promo.maxUsageCount !== null
    ? Math.max(0, promo.maxUsageCount - promo.usageCount)
    : null;

  if (usageRemaining !== null && usageRemaining === 0) {
    throw new ApiError(400, 'This promo rate has reached its usage limit');
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
  }, `"${promo.code}" is valid${promo.label ? ` — ${promo.label}` : ''}`);
}

module.exports = {
  createPromoRate, listPromoRates, getPromoRate,
  updatePromoRate, deletePromoRate, validatePromoCode,
};
