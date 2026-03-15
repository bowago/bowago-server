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

function requireLogisticsOrAbove(req, res, next) {
  if (req.user.role !== 'ADMIN') {
    throw new ApiError(403, 'Admin access required');
  }
  // Both LOGISTICS_MANAGER and SUPER_ADMIN can pass
  next();
}

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
  optionalAuth,
};
