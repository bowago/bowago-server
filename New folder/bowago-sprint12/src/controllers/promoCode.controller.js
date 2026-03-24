const { prisma } = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { success, created, getPagination, buildMeta } = require('../utils/helpers');
const { validatePromoCode } = require('../services/pricing.service');

// ─── Admin: Create promo code ─────────────────────────────────────────────────
async function createPromoCode(req, res) {
  const {
    code, description, discountPercent, flatDiscount,
    minOrderAmount, maxUses, validFrom, validUntil, serviceType,
  } = req.body;

  if (!discountPercent && !flatDiscount) {
    throw new ApiError(400, 'Provide either discountPercent or flatDiscount');
  }
  if (discountPercent && flatDiscount) {
    throw new ApiError(400, 'Provide either discountPercent OR flatDiscount, not both');
  }

  const promo = await prisma.promoCode.create({
    data: {
      code: code.trim().toUpperCase(),
      description,
      discountPercent: discountPercent || null,
      flatDiscount: flatDiscount || null,
      minOrderAmount: minOrderAmount || null,
      maxUses: maxUses || null,
      isActive: true,
      validFrom: validFrom ? new Date(validFrom) : null,
      validUntil: validUntil ? new Date(validUntil) : null,
      serviceType: serviceType || null,
      createdBy: req.user.id,
    },
  });

  return created(res, { promoCode: promo }, 'Promo code created');
}

// ─── Admin: List all promo codes ──────────────────────────────────────────────
async function listPromoCodes(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { isActive, search } = req.query;

  const where = {
    ...(isActive !== undefined && { isActive: isActive === 'true' }),
    ...(search && { code: { contains: search, mode: 'insensitive' } }),
  };

  const [promoCodes, total] = await Promise.all([
    prisma.promoCode.findMany({
      where, skip, take: limit,
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { redemptions: true } } },
    }),
    prisma.promoCode.count({ where }),
  ]);

  return res.json({ success: true, data: { promoCodes }, meta: buildMeta(total, page, limit) });
}

// ─── Admin: Update promo code ─────────────────────────────────────────────────
async function updatePromoCode(req, res) {
  const { id } = req.params;
  const existing = await prisma.promoCode.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Promo code not found');

  const promo = await prisma.promoCode.update({
    where: { id },
    data: req.body,
  });

  return success(res, { promoCode: promo }, 'Promo code updated');
}

// ─── Admin: Delete promo code ─────────────────────────────────────────────────
async function deletePromoCode(req, res) {
  const { id } = req.params;
  await prisma.promoCode.update({ where: { id }, data: { isActive: false } });
  return success(res, {}, 'Promo code deactivated');
}

// ─── Public: Validate a promo code (preview discount before booking) ──────────
async function previewPromoCode(req, res) {
  const { code, basePrice, serviceType } = req.body;
  if (!code) throw new ApiError(400, 'code is required');
  if (!basePrice) throw new ApiError(400, 'basePrice is required');

  const userId = req.user?.id || null;
  const promo = await validatePromoCode(code, userId, parseFloat(basePrice), serviceType || 'STANDARD');

  let discountAmount = 0;
  if (promo.flatDiscount) {
    discountAmount = Math.min(promo.flatDiscount, parseFloat(basePrice));
  } else if (promo.discountPercent) {
    discountAmount = Math.ceil(parseFloat(basePrice) * (promo.discountPercent / 100));
  }

  return success(res, {
    code: promo.code,
    description: promo.description,
    discountType: promo.flatDiscount ? 'FLAT' : 'PERCENT',
    discountPercent: promo.discountPercent,
    flatDiscount: promo.flatDiscount,
    discountAmount,
    finalPrice: Math.max(0, parseFloat(basePrice) - discountAmount),
    isValid: true,
  }, `Promo code "${promo.code}" is valid`);
}

// ─── Internal: Record promo redemption after shipment created ─────────────────
async function recordPromoRedemption(promoCodeStr, userId, shipmentId, discountAmount) {
  if (!promoCodeStr || !userId) return;

  const promo = await prisma.promoCode.findFirst({
    where: { code: { equals: promoCodeStr, mode: 'insensitive' } },
  });
  if (!promo) return;

  await Promise.all([
    prisma.promoRedemption.create({
      data: { promoCodeId: promo.id, userId, shipmentId, discountApplied: discountAmount },
    }),
    prisma.promoCode.update({
      where: { id: promo.id },
      data: { usedCount: { increment: 1 } },
    }),
  ]);
}

module.exports = {
  createPromoCode,
  listPromoCodes,
  updatePromoCode,
  deletePromoCode,
  previewPromoCode,
  recordPromoRedemption,
};
