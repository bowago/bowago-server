const { prisma } = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { success, created, getPagination, buildMeta } = require('../utils/helpers');

// ─── Admin: Create/assign contract rate to a user ─────────────────────────────
async function createContractRate(req, res) {
  const {
    userId, label, serviceType,
    discountPercent, fixedPricePerKgByZone,
    isActive, validFrom, validUntil, notes,
  } = req.body;

  // Verify user exists
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  if (!user) throw new ApiError(404, 'User not found');

  if (!discountPercent && !fixedPricePerKgByZone) {
    throw new ApiError(400, 'Provide either discountPercent or fixedPricePerKgByZone');
  }
  if (discountPercent && fixedPricePerKgByZone) {
    throw new ApiError(400, 'Provide either discountPercent OR fixedPricePerKgByZone, not both');
  }

  // Upsert — each user can only have one contract rate
  const contractRate = await prisma.contractRate.upsert({
    where: { userId },
    update: {
      label, serviceType: serviceType || null,
      discountPercent: discountPercent || null,
      fixedPricePerKgByZone: fixedPricePerKgByZone || null,
      isActive: isActive !== undefined ? isActive : true,
      validFrom: validFrom ? new Date(validFrom) : null,
      validUntil: validUntil ? new Date(validUntil) : null,
      notes,
      createdBy: req.user.id,
    },
    create: {
      userId, label,
      serviceType: serviceType || null,
      discountPercent: discountPercent || null,
      fixedPricePerKgByZone: fixedPricePerKgByZone || null,
      isActive: isActive !== undefined ? isActive : true,
      validFrom: validFrom ? new Date(validFrom) : null,
      validUntil: validUntil ? new Date(validUntil) : null,
      notes,
      createdBy: req.user.id,
    },
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
  });

  return created(res, { contractRate }, `Contract rate assigned to ${user.firstName} ${user.lastName}`);
}

// ─── Admin: List all contract rates ──────────────────────────────────────────
async function listContractRates(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { isActive, search } = req.query;

  const where = {
    ...(isActive !== undefined && { isActive: isActive === 'true' }),
    ...(search && {
      OR: [
        { label: { contains: search, mode: 'insensitive' } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
        { user: { firstName: { contains: search, mode: 'insensitive' } } },
      ],
    }),
  };

  const [rates, total] = await Promise.all([
    prisma.contractRate.findMany({
      where, skip, take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
      },
    }),
    prisma.contractRate.count({ where }),
  ]);

  return res.json({ success: true, data: { rates }, meta: buildMeta(total, page, limit) });
}

// ─── Admin: Get single contract rate ─────────────────────────────────────────
async function getContractRate(req, res) {
  const { id } = req.params;

  const rate = await prisma.contractRate.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  });

  if (!rate) throw new ApiError(404, 'Contract rate not found');

  return success(res, { contractRate: rate });
}

// ─── Admin: Update contract rate ──────────────────────────────────────────────
async function updateContractRate(req, res) {
  const { id } = req.params;
  const existing = await prisma.contractRate.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Contract rate not found');

  const {
    label, serviceType, discountPercent,
    fixedPricePerKgByZone, isActive, validFrom, validUntil, notes,
  } = req.body;

  const rate = await prisma.contractRate.update({
    where: { id },
    data: {
      ...(label !== undefined && { label }),
      ...(serviceType !== undefined && { serviceType: serviceType || null }),
      ...(discountPercent !== undefined && { discountPercent }),
      ...(fixedPricePerKgByZone !== undefined && { fixedPricePerKgByZone }),
      ...(isActive !== undefined && { isActive }),
      ...(validFrom !== undefined && { validFrom: validFrom ? new Date(validFrom) : null }),
      ...(validUntil !== undefined && { validUntil: validUntil ? new Date(validUntil) : null }),
      ...(notes !== undefined && { notes }),
    },
    include: {
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  });

  return success(res, { contractRate: rate }, 'Contract rate updated');
}

// ─── Admin: Delete/deactivate ─────────────────────────────────────────────────
async function deleteContractRate(req, res) {
  const { id } = req.params;
  const existing = await prisma.contractRate.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Contract rate not found');

  // Soft-deactivate rather than delete (preserve history)
  await prisma.contractRate.update({ where: { id }, data: { isActive: false } });

  return success(res, {}, 'Contract rate deactivated');
}

// ─── Customer: Get my contract rate (if any) ─────────────────────────────────
async function getMyContractRate(req, res) {
  const rate = await prisma.contractRate.findUnique({
    where: { userId: req.user.id },
  });

  if (!rate || !rate.isActive) {
    return success(res, { contractRate: null, hasContract: false });
  }

  // Security audit log — viewing own rate card
  await prisma.activityLog.create({
    data: {
      userId: req.user.id,
      action: 'VIEW_CONTRACT_RATE',
      resource: 'ContractRate',
      resourceId: rate.id,
    },
  });

  return success(res, {
    contractRate: rate,
    hasContract: true,
    discountType: rate.discountPercent ? 'PERCENT' : 'FIXED_PER_ZONE',
  });
}

module.exports = {
  createContractRate,
  listContractRates,
  getContractRate,
  updateContractRate,
  deleteContractRate,
  getMyContractRate,
};
