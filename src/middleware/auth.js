const { verifyAccessToken } = require('../config/jwt');
const { prisma } = require('../config/db');
const { ApiError } = require('../utils/ApiError');

// ─── Authenticate ─────────────────────────────────────────────────────────────
async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new ApiError(401, 'Authentication required');
  }

  const token = header.split(' ')[1];

  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch (err) {
    throw new ApiError(401, err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token');
  }

  const user = await prisma.user.findUnique({
    where: { id: decoded.sub },
    select: {
      id: true,
      email: true,
      phone: true,
      firstName: true,
      lastName: true,
      role: true,
      adminSubRole: true,
      isActive: true,
      isEmailVerified: true,
      twoFactorEnabled: true,
      twoFactorMethod: true,
    },
  });

  if (!user) throw new ApiError(401, 'User not found');
  if (!user.isActive) throw new ApiError(403, 'Account suspended');

  req.user = user;
  next();
}

// ─── Role Guards ──────────────────────────────────────────────────────────────

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      throw new ApiError(403, 'Insufficient permissions');
    }
    next();
  };
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'ADMIN') {
    throw new ApiError(403, 'Admin access required');
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (req.user.role !== 'ADMIN' || req.user.adminSubRole !== 'SUPER_ADMIN') {
    throw new ApiError(403, 'Super admin access required');
  }
  next();
}

// Covers any ADMIN-role user — used for generic read-only admin views
function requireLogisticsOrAbove(req, res, next) {
  if (req.user.role !== 'ADMIN') {
    throw new ApiError(403, 'Admin access required');
  }
  next();
}

// ─── PRD v2 RBAC ──────────────────────────────────────────────────────────────
//
// SUPER_ADMIN   → bypasses ALL guards (full system access)
// LOGISTICS_MANAGER → legacy alias for SUPER_ADMIN, same bypass
// ROLE_DISPATCHER   → named sub-role for shipment operations
// ROLE_FINANCE      → named sub-role for invoice/payment operations
// ROLE_AGENT        → named sub-role for ticket/CS operations
// ROLE_MASTER       → named sub-role for org/team management
// ROLE_ADMIN        → custom capability flags set by SUPER_ADMIN
//
// Guard priority:
//   1. SUPER_ADMIN / LOGISTICS_MANAGER → always pass
//   2. Explicit named sub-role match   → pass
//   3. ROLE_ADMIN with matching capability flag → pass
//   4. Otherwise → 403

const SUPER_COMPAT = ['SUPER_ADMIN', 'LOGISTICS_MANAGER'];

// Map each named sub-role to its equivalent capability flag.
// When a ROLE_ADMIN has this capability, they can do what the named role does.
const SUBROLE_TO_CAPABILITY = {
  ROLE_DISPATCHER: 'canManageShipments',
  ROLE_FINANCE:    'canManageInvoices',
  ROLE_AGENT:      'canManageTickets',
  ROLE_MASTER:     'canManageOrganization',
};

/**
 * requireSubRole('ROLE_DISPATCHER')
 * Allows: SUPER_ADMIN, LOGISTICS_MANAGER, ROLE_DISPATCHER,
 *         and ROLE_ADMIN with canManageShipments capability.
 */
function requireSubRole(...subRoles) {
  return async (req, res, next) => {
    if (req.user.role !== 'ADMIN') throw new ApiError(403, 'Admin access required');

    // SUPER_ADMIN and LOGISTICS_MANAGER bypass everything
    if (SUPER_COMPAT.includes(req.user.adminSubRole)) return next();

    // Named sub-role match
    if (subRoles.includes(req.user.adminSubRole)) return next();

    // ROLE_ADMIN: check if they have the equivalent capability for any of the required sub-roles
    if (req.user.adminSubRole === 'ROLE_ADMIN') {
      const requiredCaps = subRoles
        .map(r => SUBROLE_TO_CAPABILITY[r])
        .filter(Boolean);

      if (requiredCaps.length > 0) {
        const perm = await prisma.adminRolePermission.findUnique({
          where: { userId: req.user.id },
        });
        if (perm && requiredCaps.some(cap => perm[cap])) return next();
      }
    }

    throw new ApiError(403, `Access requires one of: ${subRoles.join(', ')}`);
  };
}

/**
 * requireCapability('canManageRates')
 * Allows: SUPER_ADMIN, LOGISTICS_MANAGER,
 *         and ROLE_ADMIN with the matching capability flag.
 * All other named sub-roles (DISPATCHER, FINANCE, etc.) are denied
 * unless SUPER_ADMIN grants them the capability via ROLE_ADMIN assignment.
 */
function requireCapability(capability) {
  return async (req, res, next) => {
    if (req.user.role !== 'ADMIN') throw new ApiError(403, 'Admin access required');

    // SUPER_ADMIN and LOGISTICS_MANAGER bypass all capability checks
    if (SUPER_COMPAT.includes(req.user.adminSubRole)) return next();

    // Named sub-roles (DISPATCHER, FINANCE, etc.) do NOT have capabilities
    // unless they are also assigned ROLE_ADMIN with the flag.
    // Check AdminRolePermission for ROLE_ADMIN only.
    if (req.user.adminSubRole !== 'ROLE_ADMIN') {
      throw new ApiError(403, `You don't have the "${capability}" capability`);
    }

    const perm = await prisma.adminRolePermission.findUnique({
      where: { userId: req.user.id },
    });

    if (!perm || !perm[capability]) {
      throw new ApiError(403, `You don't have the "${capability}" capability`);
    }
    next();
  };
}

// ─── Shorthand capability guards ──────────────────────────────────────────────
const requireRateManagement   = requireCapability('canManageRates');
const requireUserManagement   = requireCapability('canManageUsers');
const requireTicketManagement = requireCapability('canManageTickets');
const requireInvoiceAccess    = requireCapability('canManageInvoices');
const requireAnalyticsAccess  = requireCapability('canViewAnalytics');
const requireAuditLogAccess   = requireCapability('canViewAuditLogs');
const requireBulkNotify       = requireCapability('canBulkNotify');
const requireClaimsAccess     = requireCapability('canManageClaims');
const requireSurchargeManagement = requireCapability('canManageSurcharges');
const requirePromoManagement     = requireCapability('canManagePromos');

// ─── Optional Auth (for public + private combined routes) ─────────────────────
async function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return next();

  try {
    const token = header.split(' ')[1];
    const decoded = verifyAccessToken(token);
    const user = await prisma.user.findUnique({
      where: { id: decoded.sub },
      select: { id: true, email: true, role: true, adminSubRole: true, isActive: true },
    });
    if (user && user.isActive) req.user = user;
  } catch (_) {
    // silently fail
  }
  next();
}

module.exports = {
  authenticate,
  requireRole,
  requireAdmin,
  requireSuperAdmin,
  requireLogisticsOrAbove,
  requireSubRole,
  requireCapability,
  requireRateManagement,
  requireUserManagement,
  requireTicketManagement,
  requireInvoiceAccess,
  requireAnalyticsAccess,
  requireAuditLogAccess,
  requireBulkNotify,
  requireClaimsAccess,
  requireSurchargeManagement,
  requirePromoManagement,
  optionalAuth,
};
