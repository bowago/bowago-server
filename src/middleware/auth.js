const { verifyAccessToken } = require("../config/jwt");
const { prisma } = require("../config/db");
const { ApiError } = require("../utils/ApiError");

// ─── Authenticate ─────────────────────────────────────────────────────────────
async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new ApiError(401, "Authentication required");
  }

  const token = header.split(" ")[1];

  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch (err) {
    throw new ApiError(
      401,
      err.name === "TokenExpiredError" ? "Token expired" : "Invalid token",
    );
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
      enterpriseRole: true,
      masterId: true, // org membership (Enterprise tenant scoping)
      isActive: true,
      isEmailVerified: true,
      twoFactorEnabled: true,
      twoFactorMethod: true,
    },
  });

  if (!user) throw new ApiError(401, "User not found");
  if (!user.isActive) throw new ApiError(403, "Account suspended");

  req.user = user;
  next();
}

// ─── Role Guards ──────────────────────────────────────────────────────────────

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      throw new ApiError(403, "Insufficient permissions");
    }
    next();
  };
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "ADMIN") {
    throw new ApiError(403, "Admin access required");
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (req.user.role !== "ADMIN" || req.user.adminSubRole !== "SUPER_ADMIN") {
    throw new ApiError(403, "Super admin access required");
  }
  next();
}

// Covers any ADMIN-role user — used for generic read-only admin views
// requireLogisticsOrAbove = SUPER_ADMIN | LOGISTICS_MANAGER | ROLE_ADMIN(canManageShipments)
//
// This has been documented with that exact contract at several call sites
// for a while (see shipment.routes.js's assign-shipment route), but the
// implementation itself never actually checked the capability — it was
// just "any ADMIN, full stop." That meant canManageShipments had zero real
// effect anywhere this guard was used: a ROLE_ADMIN with that capability
// deliberately left off could still assign shipments, export shipment CSVs,
// view stats, review address-change requests, manage invoices/promo
// codes/policies/FAQs, and delete uploaded documents — every one of the 11
// routes across 7 files that use this guard. Now it actually delegates to
// the same capability check requireShipmentOpsManagement already uses.
function requireLogisticsOrAbove(req, res, next) {
  return requireCapability("canManageShipments")(req, res, next);
}

// ─── Internal Admin Capability RBAC ────────────────────────────────────────────
//
// SUPER_ADMIN       → bypasses ALL guards (full system access)
// LOGISTICS_MANAGER → legacy alias for SUPER_ADMIN, same bypass
// ROLE_ADMIN        → custom capability flags set by SUPER_ADMIN (never hardcoded)
//
// This is exclusively for role = ADMIN (internal BowaGo staff). Enterprise
// tenant roles (ROLE_MASTER, ROLE_AGENT, ROLE_DISPATCHER, ROLE_FINANCE,
// ROLE_USER) are governed separately below by requireEnterpriseRole — they
// are never checked here and never receive AdminRolePermission capabilities.
//
// Guard priority:
//   1. SUPER_ADMIN / LOGISTICS_MANAGER → always pass
//   2. ROLE_ADMIN with matching capability flag → pass
//   3. Otherwise → 403

const SUPER_COMPAT = ["SUPER_ADMIN", "LOGISTICS_MANAGER"];

/**
 * requireCapability('canManageRates')
 * Allows: SUPER_ADMIN, LOGISTICS_MANAGER,
 *         and ROLE_ADMIN with the matching capability flag.
 */
function requireCapability(capability) {
  return async (req, res, next) => {
    if (req.user.role !== "ADMIN")
      throw new ApiError(403, "Admin access required");

    // SUPER_ADMIN and LOGISTICS_MANAGER bypass all capability checks
    if (SUPER_COMPAT.includes(req.user.adminSubRole)) return next();

    // Only ROLE_ADMIN can hold capability flags at all.
    if (req.user.adminSubRole !== "ROLE_ADMIN") {
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
const requireRateManagement = requireCapability("canManageRates");
const requireUserManagement = requireCapability("canManageUsers");
const requireTicketManagement = requireCapability("canManageTickets");
const requireInvoiceAccess = requireCapability("canManageInvoices");
const requireAnalyticsAccess = requireCapability("canViewAnalytics");
const requireAuditLogAccess = requireCapability("canViewAuditLogs");
const requireBulkNotify = requireCapability("canBulkNotify");
const requireClaimsAccess = requireCapability("canManageClaims");
const requireSurchargeManagement = requireCapability("canManageSurcharges");
const requirePromoManagement = requireCapability("canManagePromos");
// Internal ops guard for platform-wide shipment operations (warehouse
// weighing, address-change review, delay-alert broadcast, status updates
// across ALL customers/enterprises). Distinct from the Enterprise tenant's
// own ROLE_DISPATCHER, which only ever touches that tenant's shipments.
const requireShipmentOpsManagement = requireCapability("canManageShipments");

// ─── Shipment status/dispatch access (internal ops OR the shipment's own
// enterprise company) ──────────────────────────────────────────────────────
// Two distinct groups may update a shipment's status/location:
//   1. Internal BowaGo staff — ADMIN role with canManageShipments capability
//      (SUPER_ADMIN/LOGISTICS_MANAGER always pass; ROLE_ADMIN needs the flag).
//      These act platform-wide, across every company's shipments.
//   2. An Enterprise company's own dispatch staff — ENTERPRISE role with
//      enterpriseRole ROLE_MASTER or ROLE_DISPATCHER. These may ONLY act on
//      shipments belonging to their own company (enforced in the controller,
//      which has the shipment's owning customer already loaded — see
//      shipment.controller.js#updateShipmentStatus for the company-match
//      check). ROLE_DISPATCHER is intentionally enterprise-only — it does
//      NOT grant access to any other company's or BowaGo's own internal
//      shipments; that's what SUPER_ADMIN/LOGISTICS_MANAGER are for.
// This middleware only narrows down to "is this caller in one of the two
// eligible groups at all" — the per-shipment company-ownership check for
// group 2 happens in the controller, since it needs the shipment loaded.
function requireShipmentDispatchAccess(req, res, next) {
  if (req.user.role === "ADMIN") {
    return requireShipmentOpsManagement(req, res, next);
  }
  if (
    req.user.role === "ENTERPRISE" &&
    ["ROLE_MASTER", "ROLE_DISPATCHER"].includes(req.user.enterpriseRole)
  ) {
    return next();
  }
  throw new ApiError(
    403,
    "Only internal shipment-ops staff or your company's dispatcher/owner can update shipment status.",
  );
}

// ─── Enterprise Tenant RBAC ────────────────────────────────────────────────────
//
// Completely separate system from Internal Admin above. Enterprise users
// (role = ENTERPRISE) never touch AdminRolePermission or platform-wide data —
// every guard here is just a role-name check, since Enterprise permissions
// are role-based, not capability-based. Internal SUPER_ADMIN/LOGISTICS_MANAGER
// may optionally be allowed through for support/impersonation-style admin
// tooling by passing { allowInternalStaff: true }.
//
//   requireEnterpriseRole('ROLE_MASTER')
//   requireEnterpriseRole('ROLE_DISPATCHER', 'ROLE_MASTER')
function requireEnterpriseRole(...enterpriseRoles) {
  return (req, res, next) => {
    if (
      req.user.role === "ENTERPRISE" &&
      enterpriseRoles.includes(req.user.enterpriseRole)
    ) {
      return next();
    }
    throw new ApiError(
      403,
      `Enterprise access requires one of: ${enterpriseRoles.join(", ")}`,
    );
  };
}

// Any authenticated member of an Enterprise tenant, regardless of their
// specific enterpriseRole (ROLE_MASTER down to ROLE_USER).
function requireEnterprise(req, res, next) {
  if (req.user.role !== "ENTERPRISE") {
    throw new ApiError(403, "Enterprise account required");
  }
  next();
}

// ─── Gap 5: 2FA session guard for sensitive routes (e.g. Invoices) ───────────
//
// Usage:  router.use(authenticate, requireRecentMFA());
//
// PRD requirement: "Users cannot access the Invoices page without passing
// 2FA verification." This is a MANDATORY gate — it is not conditional on
// whether the user has previously opted in to 2FA. Rules:
//   • If the user does NOT have 2FA enabled → blocked with code
//     'MFA_SETUP_REQUIRED' so the frontend can route them to enroll in 2FA
//     before they can proceed (instead of silently letting them through).
//   • If the user HAS 2FA enabled but has no recent verification stamp on
//     their token → blocked with 'MFA_REQUIRED'.
//   • If the user's last verification is older than MAX_MFA_AGE_HOURS →
//     blocked with 'MFA_EXPIRED'.
//   • Only a token carrying a fresh mfaVerifiedAt claim passes through.
//
const MAX_MFA_AGE_HOURS = parseInt(process.env.MFA_SESSION_HOURS) || 8;

function requireRecentMFA() {
  return async (req, res, next) => {
    const user = req.user;
    if (!user) return next(new ApiError(401, "Authentication required"));

    // 2FA must be enabled at all to access this resource — no bypass for
    // users who simply never set it up.
    if (!user.twoFactorEnabled) {
      return res.status(403).json({
        success: false,
        code: "MFA_SETUP_REQUIRED",
        message:
          "This page requires two-factor authentication. Please set up 2FA on your account to continue.",
      });
    }

    // Re-read the raw token to get mfaVerifiedAt from its claims
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return next(new ApiError(401, "Authentication required"));
    }

    const { verifyAccessToken } = require("../config/jwt");
    let claims;
    try {
      claims = verifyAccessToken(header.split(" ")[1]);
    } catch {
      return next(new ApiError(401, "Invalid or expired token"));
    }

    if (!claims.mfaVerifiedAt) {
      return res.status(403).json({
        success: false,
        code: "MFA_REQUIRED",
        message:
          "This page requires two-factor authentication. Please verify your identity.",
      });
    }

    const verifiedAt = new Date(claims.mfaVerifiedAt);
    const ageMs = Date.now() - verifiedAt.getTime();
    const maxMs = MAX_MFA_AGE_HOURS * 60 * 60 * 1000;

    if (ageMs > maxMs) {
      return res.status(403).json({
        success: false,
        code: "MFA_EXPIRED",
        message: `Your two-factor session has expired. Please re-verify to access this page (sessions last ${MAX_MFA_AGE_HOURS} hours).`,
      });
    }

    next();
  };
}

// ─── Optional Auth (for public + private combined routes) ─────────────────────
async function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return next();

  try {
    const token = header.split(" ")[1];
    const decoded = verifyAccessToken(token);
    const user = await prisma.user.findUnique({
      where: { id: decoded.sub },
      select: {
        id: true,
        email: true,
        role: true,
        adminSubRole: true,
        enterpriseRole: true,
        isActive: true,
      },
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
  requireCapability,
  requireRecentMFA,
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
  requireShipmentOpsManagement,
  requireShipmentDispatchAccess,
  requireEnterprise,
  requireEnterpriseRole,
  optionalAuth,
};
