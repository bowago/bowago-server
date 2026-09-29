const { prisma } = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { success, created, getPagination, buildMeta } = require('../utils/helpers');
const { validatePromoCode } = require('../services/pricing.service');

// ─── Admin: Create promo code ─────────────────────────────────────────────────
// Scope is explicit: shipmentMode / serviceType empty = applies to ALL modes /
// ALL services. A promo meant for one product never discounts another.
const MODES = ['AIR', 'LAND', 'SEA'];
const SERVICES = ['EXPRESS', 'STANDARD', 'ECONOMY'];
const PROMO_EDITABLE = [
  'description', 'discountPercent', 'flatDiscount', 'minOrderAmount', 'maxUses',
  'isActive', 'validFrom', 'validUntil', 'serviceType', 'shipmentMode',
];
const isEmpty = (v) => v === undefined || v === null || v === '';

function validateScope({ shipmentMode, serviceType }) {
  if (!isEmpty(shipmentMode) && !MODES.includes(shipmentMode)) throw new ApiError(400, `shipmentMode must be one of ${MODES.join(', ')} (or empty for all modes)`);
  if (!isEmpty(serviceType) && !SERVICES.includes(serviceType)) throw new ApiError(400, `serviceType must be one of ${SERVICES.join(', ')} (or empty for all services)`);
}

function validateDiscount({ discountPercent, flatDiscount }) {
  const hasPct = !isEmpty(discountPercent) && Number(discountPercent) !== 0;
  const hasFlat = !isEmpty(flatDiscount) && Number(flatDiscount) !== 0;
  if (!hasPct && !hasFlat) throw new ApiError(400, 'Provide either discountPercent or flatDiscount');
  if (hasPct && hasFlat) throw new ApiError(400, 'Provide either discountPercent OR flatDiscount, not both');
  if (hasPct && (Number(discountPercent) <= 0 || Number(discountPercent) > 100)) throw new ApiError(400, 'discountPercent must be greater than 0 and at most 100');
  if (hasFlat && Number(flatDiscount) <= 0) throw new ApiError(400, 'flatDiscount must be greater than 0');
}

async function createPromoCode(req, res) {
  const {
    code, description, discountPercent, flatDiscount,
    minOrderAmount, maxUses, validFrom, validUntil, serviceType, shipmentMode,
  } = req.body;

  if (!code || !String(code).trim()) throw new ApiError(400, 'code is required');
  validateDiscount({ discountPercent, flatDiscount });
  validateScope({ shipmentMode, serviceType });

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
      shipmentMode: shipmentMode || null,
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
// Whitelisted fields only — `usedCount`, `code`, `createdBy` etc. must not be
// settable through this endpoint.
async function updatePromoCode(req, res) {
  const { id } = req.params;
  const existing = await prisma.promoCode.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Promo code not found');

  const data = Object.fromEntries(Object.entries(req.body).filter(([k]) => PROMO_EDITABLE.includes(k)));
  const merged = { ...existing, ...data };
  validateScope(merged);
  if ('discountPercent' in data || 'flatDiscount' in data) validateDiscount(merged);
  for (const k of ['validFrom', 'validUntil']) if (k in data) data[k] = data[k] ? new Date(data[k]) : null;
  for (const k of ['serviceType', 'shipmentMode']) if (k in data) data[k] = data[k] || null;

  const promo = await prisma.promoCode.update({ where: { id }, data });

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
  const { code, basePrice, serviceType, shipmentMode } = req.body;
  if (!code) throw new ApiError(400, 'code is required');
  if (!basePrice) throw new ApiError(400, 'basePrice is required');

  const userId = req.user?.id || null;
  // Scope is checked against the product being priced, when the caller says which.
  const promo = await validatePromoCode(code, userId, parseFloat(basePrice), { serviceType, shipmentMode });

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
