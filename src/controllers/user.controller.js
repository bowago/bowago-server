const bcrypt = require('bcryptjs');
const { prisma } = require('../config/db');
const { deleteFromCloudinary } = require('../config/cloudinary');
const { ApiError } = require('../utils/ApiError');
const { success, getPagination, buildMeta } = require('../utils/helpers');

// ─── GET PROFILE ──────────────────────────────────────────────────────────────
async function getProfile(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true, email: true, phone: true, firstName: true, lastName: true,
      avatar: true, role: true, adminSubRole: true, authProvider: true,
      isEmailVerified: true, isPhoneVerified: true, isActive: true,
      createdAt: true,
      addresses: { orderBy: { isDefault: 'desc' } },
    },
  });
  return success(res, { user });
}

// ─── UPDATE PROFILE ───────────────────────────────────────────────────────────
async function updateProfile(req, res) {
  const { firstName, lastName, phone } = req.body;

  if (phone && phone !== req.user.phone) {
    const exists = await prisma.user.findFirst({
      where: { phone, NOT: { id: req.user.id } },
    });
    if (exists) throw new ApiError(409, 'Phone number already in use');
  }

  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { firstName, lastName, phone },
    select: {
      id: true, email: true, phone: true, firstName: true, lastName: true, avatar: true,
      role: true, adminSubRole: true, isEmailVerified: true, isPhoneVerified: true,
    },
  });

  return success(res, { user }, 'Profile updated');
}

// ─── UPLOAD AVATAR ────────────────────────────────────────────────────────────
async function uploadAvatar(req, res) {
  if (!req.file) throw new ApiError(400, 'No image uploaded');

  // Delete old avatar
  const currentUser = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { avatarPublicId: true },
  });
  if (currentUser.avatarPublicId) {
    await deleteFromCloudinary(currentUser.avatarPublicId);
  }

  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { avatar: req.file.path, avatarPublicId: req.file.filename },
    select: { id: true, avatar: true },
  });

  return success(res, { avatar: user.avatar }, 'Avatar updated');
}

// ─── ADDRESSES ────────────────────────────────────────────────────────────────
async function addAddress(req, res) {
  const { label, street, city, state, lga, postalCode, isDefault, lat, lng } = req.body;

  if (isDefault) {
    await prisma.address.updateMany({
      where: { userId: req.user.id },
      data: { isDefault: false },
    });
  }

  const address = await prisma.address.create({
    data: { userId: req.user.id, label, street, city, state, lga, postalCode, isDefault: !!isDefault, lat, lng },
  });

  return success(res, { address }, 'Address added', 201);
}

async function updateAddress(req, res) {
  const { id } = req.params;

  const existing = await prisma.address.findFirst({
    where: { id, userId: req.user.id },
  });
  if (!existing) throw new ApiError(404, 'Address not found');

  const { label, street, city, state, lga, postalCode, isDefault, lat, lng } = req.body;

  if (isDefault) {
    await prisma.address.updateMany({
      where: { userId: req.user.id },
      data: { isDefault: false },
    });
  }

  const address = await prisma.address.update({
    where: { id },
    data: { label, street, city, state, lga, postalCode, isDefault: !!isDefault, lat, lng },
  });

  return success(res, { address }, 'Address updated');
}

async function deleteAddress(req, res) {
  const { id } = req.params;

  const existing = await prisma.address.findFirst({
    where: { id, userId: req.user.id },
  });
  if (!existing) throw new ApiError(404, 'Address not found');

  await prisma.address.delete({ where: { id } });
  return success(res, {}, 'Address deleted');
}

// ─── ADMIN: LIST USERS ────────────────────────────────────────────────────────
async function listUsers(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { role, search, isActive } = req.query;

  const where = {
    ...(role && { role }),
    ...(isActive !== undefined && { isActive: isActive === 'true' }),
    ...(search && {
      OR: [
        { email: { contains: search, mode: 'insensitive' } },
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
      ],
    }),
  };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, email: true, phone: true, firstName: true, lastName: true,
        avatar: true, role: true, adminSubRole: true, isActive: true,
        isEmailVerified: true, createdAt: true,
        _count: { select: { shipments: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  return res.json({ success: true, data: { users }, meta: buildMeta(total, page, limit) });
}

// ─── ADMIN: TOGGLE USER STATUS ────────────────────────────────────────────────
async function toggleUserStatus(req, res) {
  const { id } = req.params;

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new ApiError(404, 'User not found');

  const updated = await prisma.user.update({
    where: { id },
    data: { isActive: !user.isActive },
    select: { id: true, isActive: true, email: true },
  });

  return success(res, { user: updated }, `User ${updated.isActive ? 'activated' : 'suspended'}`);
}

// ─── ADMIN: SET ADMIN ROLE ────────────────────────────────────────────────────
async function setAdminRole(req, res) {
  const { id } = req.params;
  const { adminSubRole } = req.body;

  const user = await prisma.user.update({
    where: { id },
    data: { role: 'ADMIN', adminSubRole: adminSubRole || null },
    select: { id: true, email: true, role: true, adminSubRole: true },
  });

  return success(res, { user }, 'Admin role updated');
}

module.exports = {
  getProfile,
  updateProfile,
  uploadAvatar,
  addAddress,
  updateAddress,
  deleteAddress,
  listUsers,
  toggleUserStatus,
  setAdminRole,
};
