const bcrypt = require("bcryptjs");
const { prisma } = require("../config/db");
const { deleteFromCloudinary } = require("../config/cloudinary");
const { ApiError } = require("../utils/ApiError");
const { success, getPagination, buildMeta } = require("../utils/helpers");

// ─── GET PROFILE ──────────────────────────────────────────────────────────────
async function getProfile(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true,
      email: true,
      phone: true,
      firstName: true,
      lastName: true,
      avatar: true,
      role: true,
      adminSubRole: true,
      authProvider: true,
      isEmailVerified: true,
      isPhoneVerified: true,
      isActive: true,
      createdAt: true,
      twoFactorEnabled: true,
      companyName: true,
      industry: true,
      companyEmail: true,
      companyPhone: true,
      companyWebsite: true,
      companyStreet: true,
      companyCity: true,
      companyState: true,
      companyCountry: true,
      companyZip: true,
      addresses: { orderBy: { isDefault: "desc" } },
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
    if (exists) throw new ApiError(409, "Phone number already in use");
  }

  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { firstName, lastName, phone },
    select: {
      id: true,
      email: true,
      phone: true,
      firstName: true,
      lastName: true,
      avatar: true,
      role: true,
      adminSubRole: true,
      isEmailVerified: true,
      isPhoneVerified: true,
    },
  });

  return success(res, { user }, "Profile updated");
}

// ─── UPDATE COMPANY INFO ────────────────────────────────────────────────────
async function updateCompanyInfo(req, res) {
  const {
    companyName, industry, companyEmail, companyPhone, companyWebsite,
    streetAddress, city, state, country, zipCode,
  } = req.body;

  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: {
      ...(companyName    !== undefined && { companyName }),
      ...(industry       !== undefined && { industry }),
      ...(companyEmail   !== undefined && { companyEmail }),
      ...(companyPhone   !== undefined && { companyPhone }),
      ...(companyWebsite !== undefined && { companyWebsite }),
      ...(streetAddress  !== undefined && { companyStreet: streetAddress }),
      ...(city           !== undefined && { companyCity: city }),
      ...(state          !== undefined && { companyState: state }),
      ...(country        !== undefined && { companyCountry: country }),
      ...(zipCode        !== undefined && { companyZip: zipCode }),
    },
    select: {
      companyName: true, industry: true, companyEmail: true, companyPhone: true,
      companyWebsite: true, companyStreet: true, companyCity: true,
      companyState: true, companyCountry: true, companyZip: true,
    },
  });

  return success(res, { company: user }, "Company information updated");
}

// ─── UPLOAD AVATAR ────────────────────────────────────────────────────────────
async function uploadAvatar(req, res) {
  if (!req.file) throw new ApiError(400, "No image uploaded");

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

  return success(res, { avatar: user.avatar }, "Avatar updated");
}

// ─── ADDRESSES ────────────────────────────────────────────────────────────────
async function addAddress(req, res) {
  const { label, street, city, state, lga, postalCode, isDefault, lat, lng } =
    req.body;

  if (isDefault) {
    await prisma.address.updateMany({
      where: { userId: req.user.id },
      data: { isDefault: false },
    });
  }

  const address = await prisma.address.create({
    data: {
      userId: req.user.id,
      label,
      street,
      city,
      state,
      lga,
      postalCode,
      isDefault: !!isDefault,
      lat,
      lng,
    },
  });

  return success(res, { address }, "Address added", 201);
}

async function updateAddress(req, res) {
  const { id } = req.params;

  const existing = await prisma.address.findFirst({
    where: { id, userId: req.user.id },
  });
  if (!existing) throw new ApiError(404, "Address not found");

  const { label, street, city, state, lga, postalCode, isDefault, lat, lng } =
    req.body;

  if (isDefault) {
    await prisma.address.updateMany({
      where: { userId: req.user.id },
      data: { isDefault: false },
    });
  }

  const address = await prisma.address.update({
    where: { id },
    data: {
      label,
      street,
      city,
      state,
      lga,
      postalCode,
      isDefault: !!isDefault,
      lat,
      lng,
    },
  });

  return success(res, { address }, "Address updated");
}

async function deleteAddress(req, res) {
  const { id } = req.params;

  const existing = await prisma.address.findFirst({
    where: { id, userId: req.user.id },
  });
  if (!existing) throw new ApiError(404, "Address not found");

  await prisma.address.delete({ where: { id } });
  return success(res, {}, "Address deleted");
}

// ─── ADMIN: LIST USERS ────────────────────────────────────────────────────────
async function listUsers(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { role, search, isActive } = req.query;

  const where = {
    ...(role && { role }),
    ...(isActive !== undefined && { isActive: isActive === "true" }),
    ...(search && {
      OR: [
        { email: { contains: search, mode: "insensitive" } },
        { firstName: { contains: search, mode: "insensitive" } },
        { lastName: { contains: search, mode: "insensitive" } },
        { phone: { contains: search } },
      ],
    }),
  };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
        avatar: true,
        role: true,
        adminSubRole: true,
        isActive: true,
        isEmailVerified: true,
        createdAt: true,
        _count: { select: { shipments: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  return res.json({
    success: true,
    data: { users },
    meta: buildMeta(total, page, limit),
  });
}

// ─── ADMIN: TOGGLE USER STATUS ────────────────────────────────────────────────
async function toggleUserStatus(req, res) {
  const { id } = req.params;

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new ApiError(404, "User not found");

  const updated = await prisma.user.update({
    where: { id },
    data: { isActive: !user.isActive },
    select: { id: true, isActive: true, email: true },
  });

  return success(
    res,
    { user: updated },
    `User ${updated.isActive ? "activated" : "suspended"}`,
  );
}

// ─── ADMIN: SET ADMIN ROLE ────────────────────────────────────────────────────
async function setAdminRole(req, res) {
  const { id } = req.params;
  const { adminSubRole, role } = req.body;

  if (id === req.user.id) {
    throw new ApiError(400, "You cannot change your own role");
  }

  const target = await prisma.user.findUnique({
    where: { id },
    select: { adminSubRole: true },
  });
  if (!target) throw new ApiError(404, "User not found");
  if (target.adminSubRole === "SUPER_ADMIN") {
    throw new ApiError(403, "Cannot change another SUPER_ADMIN's role");
  }

  // Demote back to a regular customer — clears ADMIN role + sub-role +
  // any custom capability record.
  if (role === "CUSTOMER" || adminSubRole === "CUSTOMER") {
    const user = await prisma.user.update({
      where: { id },
      data: { role: "CUSTOMER", adminSubRole: null },
      select: { id: true, email: true, role: true, adminSubRole: true },
    });
    await prisma.adminRolePermission.deleteMany({ where: { userId: id } });
    return success(res, { user }, "User reverted to CUSTOMER role");
  }

  const user = await prisma.user.update({
    where: { id },
    data: { role: "ADMIN", adminSubRole: adminSubRole || null },
    select: { id: true, email: true, role: true, adminSubRole: true },
  });

  return success(res, { user }, "Admin role updated");
}

// ─── ADMIN: GET USER BY ID ────────────────────────────────────────────────────
async function getUserById(req, res) {
  const { id } = req.params;

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      phone: true,
      firstName: true,
      lastName: true,
      avatar: true,
      role: true,
      adminSubRole: true,
      authProvider: true,
      isActive: true,
      isEmailVerified: true,
      isPhoneVerified: true,
      createdAt: true,
      updatedAt: true,
      addresses: { orderBy: { isDefault: "desc" } },
      _count: { select: { shipments: true } },
    },
  });

  if (!user) throw new ApiError(404, "User not found");

  // Fetch recent shipments
  const shipments = await prisma.shipment.findMany({
    where: { customerId: id },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      trackingNumber: true,
      status: true,
      paymentStatus: true,
      quotedPrice: true,
      senderCity: true,
      recipientCity: true,
      createdAt: true,
    },
  });

  return success(res, { user, shipments });
}

// ─── ADMIN: DELETE USER ───────────────────────────────────────────────────────
async function deleteUser(req, res) {
  const { id } = req.params;

  // Prevent self-deletion
  if (id === req.user.id) {
    throw new ApiError(400, "You cannot delete your own account");
  }

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new ApiError(404, "User not found");

  // Prevent deletion of other SUPER_ADMINs
  if (user.adminSubRole === "SUPER_ADMIN") {
    throw new ApiError(403, "Cannot delete another Super Admin");
  }

  await prisma.user.delete({ where: { id } });

  return success(res, {}, "User deleted successfully");
}

// ─── SAVED CARDS ────────────────────────────────────────────────────────────
// Cards are populated automatically by paystack.service.verifyPayment()
// when a successful charge returns a reusable authorization.

async function listSavedCards(req, res) {
  const cards = await prisma.savedCard.findMany({
    where: { userId: req.user.id },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  });
  return success(res, { cards });
}

async function setDefaultCard(req, res) {
  const { id } = req.params;

  const card = await prisma.savedCard.findFirst({
    where: { id, userId: req.user.id },
  });
  if (!card) throw new ApiError(404, "Saved card not found");

  await prisma.$transaction([
    prisma.savedCard.updateMany({
      where: { userId: req.user.id },
      data: { isDefault: false },
    }),
    prisma.savedCard.update({ where: { id }, data: { isDefault: true } }),
  ]);

  return success(res, {}, "Default card updated");
}

async function deleteSavedCard(req, res) {
  const { id } = req.params;

  const card = await prisma.savedCard.findFirst({
    where: { id, userId: req.user.id },
  });
  if (!card) throw new ApiError(404, "Saved card not found");

  await prisma.savedCard.delete({ where: { id } });

  // If we deleted the default card, promote the next most recent one
  if (card.isDefault) {
    const next = await prisma.savedCard.findFirst({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
    });
    if (next) {
      await prisma.savedCard.update({ where: { id: next.id }, data: { isDefault: true } });
    }
  }

  return success(res, {}, "Card removed");
}

module.exports = {
  getProfile,
  updateProfile,
  updateCompanyInfo,
  uploadAvatar,
  addAddress,
  updateAddress,
  deleteAddress,
  listUsers,
  toggleUserStatus,
  setAdminRole,
  getUserById,
  deleteUser,
  listSavedCards,
  setDefaultCard,
  deleteSavedCard,
  deleteOwnAccount,
};

// ─── CUSTOMER: DELETE OWN ACCOUNT ──────────────────────────────────────────
async function deleteOwnAccount(req, res) {
  const { password } = req.body;
  if (!password) throw new ApiError(400, 'Password is required to delete your account');

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) throw new ApiError(404, 'User not found');

  if (user.passwordHash) {
    const bcrypt = require('bcryptjs');
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new ApiError(401, 'Incorrect password. Account not deleted.');
  }

  // Soft-delete via deactivation to preserve shipment/invoice history,
  // OR hard-delete if you prefer. Hard-delete cascades via Prisma schema.
  await prisma.user.delete({ where: { id: req.user.id } });

  return success(res, {}, 'Your account has been permanently deleted.');
}
