const { prisma } = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { success, created } = require('../utils/helpers');

// ─── Public: Get active policy by key ────────────────────────────────────────
// Story 9.4: Displayed at point of payment and quote generation
async function getPolicy(req, res) {
  const { key } = req.params;

  const policy = await prisma.policyContent.findFirst({
    where: { key, isActive: true },
  });

  if (!policy) throw new ApiError(404, `Policy "${key}" not found`);

  return success(res, { policy });
}

// ─── Public: Get all active policies ─────────────────────────────────────────
async function listPolicies(req, res) {
  const policies = await prisma.policyContent.findMany({
    where: { isActive: true },
    orderBy: { key: 'asc' },
    select: { id: true, key: true, title: true, isActive: true, updatedAt: true },
  });

  return success(res, { policies });
}

// ─── Admin: Upsert policy content ────────────────────────────────────────────
async function upsertPolicy(req, res) {
  const { key, title, body, isActive } = req.body;

  if (!key || !title || !body) {
    throw new ApiError(400, 'key, title, and body are required');
  }

  const policy = await prisma.policyContent.upsert({
    where: { key },
    update: { title, body, isActive: isActive !== undefined ? isActive : true, updatedBy: req.user.id },
    create: { key, title, body, isActive: isActive !== undefined ? isActive : true, updatedBy: req.user.id },
  });

  return created(res, { policy }, 'Policy saved');
}

// ─── Admin: Delete policy ─────────────────────────────────────────────────────
async function deletePolicy(req, res) {
  const { key } = req.params;
  const existing = await prisma.policyContent.findUnique({ where: { key } });
  if (!existing) throw new ApiError(404, 'Policy not found');

  await prisma.policyContent.update({ where: { key }, data: { isActive: false } });
  return success(res, {}, 'Policy deactivated');
}

// ─── Public: List packaging guides ───────────────────────────────────────────
// Story 11.5: Accessible within two clicks from booking confirmation page
async function listPackagingGuides(req, res) {
  const { category } = req.query;

  const guides = await prisma.packagingGuide.findMany({
    where: {
      isActive: true,
      ...(category && { category: { equals: category, mode: 'insensitive' } }),
    },
    orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
  });

  // Group by category for accordion UI
  const grouped = guides.reduce((acc, g) => {
    (acc[g.category] = acc[g.category] || []).push(g);
    return acc;
  }, {});

  // Highlight dangerous goods separately
  const dangerousGoods = guides.filter(g => g.isDangerous);

  return success(res, { guides, grouped, dangerousGoods });
}

// ─── Public: Get single packaging guide ──────────────────────────────────────
async function getPackagingGuide(req, res) {
  const { id } = req.params;
  const guide = await prisma.packagingGuide.findFirst({ where: { id, isActive: true } });
  if (!guide) throw new ApiError(404, 'Packaging guide not found');
  return success(res, { guide });
}

// ─── Admin: Create packaging guide ───────────────────────────────────────────
async function createPackagingGuide(req, res) {
  const { title, body, category, imageUrl, sortOrder, isDangerous } = req.body;

  const guide = await prisma.packagingGuide.create({
    data: {
      title, body,
      category: category || 'GENERAL',
      imageUrl,
      sortOrder: sortOrder || 0,
      isDangerous: !!isDangerous,
      createdBy: req.user.id,
    },
  });

  return created(res, { guide }, 'Packaging guide created');
}

// ─── Admin: Update packaging guide ───────────────────────────────────────────
async function updatePackagingGuide(req, res) {
  const { id } = req.params;
  const existing = await prisma.packagingGuide.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Packaging guide not found');

  const guide = await prisma.packagingGuide.update({ where: { id }, data: req.body });
  return success(res, { guide }, 'Packaging guide updated');
}

// ─── Admin: Delete packaging guide ───────────────────────────────────────────
async function deletePackagingGuide(req, res) {
  const { id } = req.params;
  await prisma.packagingGuide.update({ where: { id }, data: { isActive: false } });
  return success(res, {}, 'Packaging guide deleted');
}

module.exports = {
  getPolicy, listPolicies, upsertPolicy, deletePolicy,
  listPackagingGuides, getPackagingGuide,
  createPackagingGuide, updatePackagingGuide, deletePackagingGuide,
};
