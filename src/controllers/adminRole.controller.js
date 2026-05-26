const { prisma } = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { success, created, getPagination, buildMeta } = require('../utils/helpers');

// All capabilities the SUPER_ADMIN can toggle
const ALL_CAPABILITIES = [
  'canManageRates', 'canManageUsers', 'canManageShipments',
  'canViewAnalytics', 'canManageTickets', 'canManageInvoices',
  'canManageSurcharges', 'canManagePromos', 'canManageClaims',
  'canBulkNotify', 'canViewAuditLogs', 'canManageOrganization',
];

// ─── Create or assign a custom admin role to a staff member ──────────────────
// SUPER_ADMIN-only. Sets the adminSubRole to ROLE_ADMIN and defines their capabilities.
async function assignCustomRole(req, res) {
  const {
    userId, roleLabel, notes,
    canManageRates, canManageUsers, canManageShipments,
    canViewAnalytics, canManageTickets, canManageInvoices,
    canManageSurcharges, canManagePromos, canManageClaims,
    canBulkNotify, canViewAuditLogs, canManageOrganization,
  } = req.body;

  // Ensure target user exists and is an ADMIN
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, adminSubRole: true, email: true, firstName: true, lastName: true },
  });
  if (!target) throw new ApiError(404, 'User not found');
  if (target.role !== 'ADMIN') throw new ApiError(400, 'Target user must be an ADMIN role user');

  // Cannot downgrade another SUPER_ADMIN
  if (target.adminSubRole === 'SUPER_ADMIN') {
    throw new ApiError(403, 'Cannot modify another SUPER_ADMIN\'s role');
  }

  const capData = {
    canManageRates:        !!canManageRates,
    canManageUsers:        !!canManageUsers,
    canManageShipments:    !!canManageShipments,
    canViewAnalytics:      !!canViewAnalytics,
    canManageTickets:      !!canManageTickets,
    canManageInvoices:     !!canManageInvoices,
    canManageSurcharges:   !!canManageSurcharges,
    canManagePromos:       !!canManagePromos,
    canManageClaims:       !!canManageClaims,
    canBulkNotify:         !!canBulkNotify,
    canViewAuditLogs:      !!canViewAuditLogs,
    canManageOrganization: !!canManageOrganization,
    roleLabel:             roleLabel || null,
    notes:                 notes || null,
  };

  // Upsert role permission record
  const perm = await prisma.adminRolePermission.upsert({
    where: { userId },
    update: { ...capData, updatedBy: req.user.id },
    create: { userId, ...capData, createdBy: req.user.id },
  });

  // Update user's adminSubRole to ROLE_ADMIN
  await prisma.user.update({
    where: { id: userId },
    data: { adminSubRole: 'ROLE_ADMIN' },
  });

  // Audit log
  await prisma.activityLog.create({
    data: {
      userId: req.user.id,
      action: 'ASSIGN_CUSTOM_ROLE',
      resource: 'AdminRolePermission',
      resourceId: userId,
      metadata: { roleLabel, capabilities: capData, target: `${target.firstName} ${target.lastName}` },
    },
  });

  return created(res, { perm, target: { id: target.id, email: target.email } },
    `Custom role "${roleLabel || 'ROLE_ADMIN'}" assigned to ${target.firstName} ${target.lastName}`);
}

// ─── Update a custom role's capabilities ─────────────────────────────────────
async function updateCustomRole(req, res) {
  const { userId } = req.params;

  const existing = await prisma.adminRolePermission.findUnique({ where: { userId } });
  if (!existing) throw new ApiError(404, 'Custom role not found for this user');

  const target = await prisma.user.findUnique({ where: { id: userId }, select: { adminSubRole: true } });
  if (target?.adminSubRole === 'SUPER_ADMIN') throw new ApiError(403, 'Cannot modify a SUPER_ADMIN');

  const updateData = {};
  for (const cap of ALL_CAPABILITIES) {
    if (req.body[cap] !== undefined) updateData[cap] = !!req.body[cap];
  }
  if (req.body.roleLabel !== undefined) updateData.roleLabel = req.body.roleLabel;
  if (req.body.notes !== undefined)     updateData.notes     = req.body.notes;
  updateData.updatedBy = req.user.id;

  const perm = await prisma.adminRolePermission.update({ where: { userId }, data: updateData });

  await prisma.activityLog.create({
    data: {
      userId: req.user.id,
      action: 'UPDATE_CUSTOM_ROLE',
      resource: 'AdminRolePermission',
      resourceId: userId,
      metadata: { updates: updateData },
    },
  });

  return success(res, { perm }, 'Custom role updated');
}

// ─── Revoke custom role — revert to LOGISTICS_MANAGER (legacy default) ────────
async function revokeCustomRole(req, res) {
  const { userId } = req.params;

  const target = await prisma.user.findUnique({ where: { id: userId }, select: { adminSubRole: true, firstName: true, lastName: true } });
  if (!target) throw new ApiError(404, 'User not found');
  if (target.adminSubRole === 'SUPER_ADMIN') throw new ApiError(403, 'Cannot revoke a SUPER_ADMIN');

  await prisma.adminRolePermission.deleteMany({ where: { userId } });
  await prisma.user.update({ where: { id: userId }, data: { adminSubRole: 'LOGISTICS_MANAGER' } });

  await prisma.activityLog.create({
    data: {
      userId: req.user.id,
      action: 'REVOKE_CUSTOM_ROLE',
      resource: 'AdminRolePermission',
      resourceId: userId,
      metadata: { target: `${target.firstName} ${target.lastName}` },
    },
  });

  return success(res, {}, `Custom role revoked. ${target.firstName} ${target.lastName} reverted to LOGISTICS_MANAGER`);
}

// ─── List all staff with their custom role assignments ────────────────────────
async function listAdminRoles(req, res) {
  const { page, limit, skip } = getPagination(req.query);

  const [perms, total] = await Promise.all([
    prisma.adminRolePermission.findMany({
      skip, take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        user:    { select: { id: true, firstName: true, lastName: true, email: true, adminSubRole: true, isActive: true } },
        creator: { select: { id: true, firstName: true, lastName: true } },
      },
    }),
    prisma.adminRolePermission.count(),
  ]);

  return res.json({ success: true, data: { perms }, meta: buildMeta(total, page, limit) });
}

// ─── Get a single user's role permissions ────────────────────────────────────
async function getAdminRole(req, res) {
  const { userId } = req.params;
  const perm = await prisma.adminRolePermission.findUnique({
    where: { userId },
    include: {
      user:    { select: { id: true, firstName: true, lastName: true, email: true, adminSubRole: true } },
      creator: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  if (!perm) throw new ApiError(404, 'No custom role found for this user');
  return success(res, { perm });
}

// ─── List all available capabilities ─────────────────────────────────────────
async function listCapabilities(req, res) {
  return success(res, {
    capabilities: ALL_CAPABILITIES.map(cap => ({
      key:         cap,
      label:       cap.replace(/^can/, '').replace(/([A-Z])/g, ' $1').trim(),
      description: capabilityDescriptions[cap] || cap,
    })),
  });
}

const capabilityDescriptions = {
  canManageRates:        'Create, update, and delete price bands, contract rates, and promo rates',
  canManageUsers:        'View, activate/deactivate user accounts; assign admin roles',
  canManageShipments:    'Update shipment status, assign shipments, view all shipments',
  canViewAnalytics:      'Access reporting, KPI dashboards, and revenue analytics',
  canManageTickets:      'Read, reply to, escalate, and close support tickets',
  canManageInvoices:     'View and download invoices; process refunds',
  canManageSurcharges:   'Create and update surcharge configurations',
  canManagePromos:       'Create, activate/deactivate promo codes and promo rates',
  canManageClaims:       'Review, approve, and reject insurance claims',
  canBulkNotify:         'Send bulk delay alerts and notifications to customers',
  canViewAuditLogs:      'Access pricing audit trail and activity logs',
  canManageOrganization: 'Manage organization members, invite team members, assign company roles',
};

module.exports = {
  assignCustomRole, updateCustomRole, revokeCustomRole,
  listAdminRoles, getAdminRole, listCapabilities,
};
