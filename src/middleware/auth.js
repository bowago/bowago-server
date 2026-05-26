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
      firstName: true,
      lastName: true,
      role: true,
      adminSubRole: true,
      isActive: true,
      isEmailVerified: true,
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

// Covers: SUPER_ADMIN, LOGISTICS_MANAGER (legacy), ROLE_ADMIN, ROLE_AGENT, ROLE_MASTER,
//         ROLE_DISPATCHER, ROLE_FINANCE — i.e. any ADMIN-role user
function requireLogisticsOrAbove(req, res, next) {
  if (req.user.role !== 'ADMIN') {
    throw new ApiError(403, 'Admin access required');
  }
  next();
}

// ─── PRD v2 Sub-Role Guards ────────────────────────────────────────────────────
// Use these for routes that correspond to specific PRD role capabilities.
// They all accept SUPER_ADMIN + LOGISTICS_MANAGER (backward compat) in addition
// to the named role — so existing integrations don't break.

const SUPER_COMPAT = ['SUPER_ADMIN', 'LOGISTICS_MANAGER'];

function requireSubRole(...subRoles) {
  return (req, res, next) => {
    if (req.user.role !== 'ADMIN') throw new ApiError(403, 'Admin access required');
    const allowed = [...subRoles, ...SUPER_COMPAT];
    if (!allowed.includes(req.user.adminSubRole)) {
      throw new ApiError(403, `Access requires one of: ${subRoles.join(', ')}`);
    }
    next();
  };
}

// Capability-based guard for ROLE_ADMIN custom roles
// Checks AdminRolePermission table for specific capability flag
function requireCapability(capability) {
  return async (req, res, next) => {
    if (req.user.role !== 'ADMIN') throw new ApiError(403, 'Admin access required');

    // SUPER_ADMIN and LOGISTICS_MANAGER bypass capability checks
    if (SUPER_COMPAT.includes(req.user.adminSubRole)) return next();

    const perm = await prisma.adminRolePermission.findUnique({
      where: { userId: req.user.id },
    });

    if (!perm || !perm[capability]) {
      throw new ApiError(403, `You don't have the "${capability}" capability`);
    }
    next();
  };
}

// Shorthand helpers for common capability checks
const requireRateManagement   = requireCapability('canManageRates');
const requireUserManagement   = requireCapability('canManageUsers');
const requireTicketManagement = requireCapability('canManageTickets');
const requireInvoiceAccess    = requireCapability('canManageInvoices');
const requireAnalyticsAccess  = requireCapability('canViewAnalytics');
const requireAuditLogAccess   = requireCapability('canViewAuditLogs');
const requireBulkNotify       = requireCapability('canBulkNotify');
const requireClaimsAccess     = requireCapability('canManageClaims');

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
  optionalAuth,
};
