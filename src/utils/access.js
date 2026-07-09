// ─── Owned-resource access control (PRD Sprint 2 / 8) ────────────────────────
//
// Central authority for "can this user touch a resource owned by user X?"
// Used everywhere a controller previously did:
//
//     if (req.user.role === "CUSTOMER" && owner !== req.user.id) → 403
//
// That pattern had a critical hole: it only blocked CUSTOMER accounts, so any
// ENTERPRISE-role user silently bypassed the ownership check and could read
// other tenants' (and other customers') shipments, invoices, labels, claims,
// tickets, and price adjustments — a direct violation of the PRD's company
// isolation requirement ("No enterprise user should ever see data belonging
// to another company").
//
// Rules enforced here:
//   • Internal ADMIN staff       → allowed (route-level capability guards
//                                  already decide WHICH admins reach the
//                                  handler at all)
//   • Resource owner             → allowed
//   • ENTERPRISE user            → allowed only if the owner is in the SAME
//                                  tenant (owner is their org master, or the
//                                  owner's masterId matches their org master)
//   • Everyone else              → denied
//
// Denied attempts on sensitive resources are written to ActivityLog as
// SECURITY_ACCESS_DENIED events, satisfying the PRD Sprint 2 requirement:
// "Any attempt to view another user's invoice or rate card must trigger a
// security log for Admin review."

const { prisma } = require("../config/db");
const { ApiError } = require("./ApiError");

/**
 * Resolve the org master id for an Enterprise user.
 * ROLE_MASTER users are their own master; team members carry masterId.
 * Returns null for non-Enterprise users or unlinked accounts.
 */
function getOrgMasterId(user) {
  if (!user || user.role !== "ENTERPRISE") return null;
  if (user.enterpriseRole === "ROLE_MASTER") return user.id;
  return user.masterId || null;
}

/**
 * Whether `user` may access a resource owned by `ownerId`.
 * Async because Enterprise checks may need one lookup of the owner's org link.
 */
async function canAccessOwnedResource(user, ownerId) {
  if (!user || !ownerId) return false;

  // Internal BowaGo staff — platform-wide access (route guards gate which
  // admins get this far).
  if (user.role === "ADMIN") return true;

  // Owner themselves.
  if (ownerId === user.id) return true;

  // Enterprise tenant: same-company resources only.
  if (user.role === "ENTERPRISE") {
    const myMaster = getOrgMasterId(user);
    if (!myMaster) return false;
    if (ownerId === myMaster) return true;

    const owner = await prisma.user.findUnique({
      where: { id: ownerId },
      select: { masterId: true },
    });
    return !!owner && owner.masterId === myMaster;
  }

  return false;
}

/**
 * Throws 403 (and writes a SECURITY_ACCESS_DENIED audit entry, non-blocking)
 * when the user may not access the resource.
 *
 * @param {object} user       req.user (must include id, role, enterpriseRole, masterId)
 * @param {string} ownerId    the user id that owns the resource
 * @param {object} [opts]
 * @param {string} [opts.resource]   e.g. "Invoice", "Shipment", "Claim"
 * @param {string} [opts.resourceId] the resource's id for the audit trail
 * @param {object} [opts.req]        express req (for IP logging)
 * @param {string} [opts.message]    override the 403 message
 */
async function assertOwnedResourceAccess(user, ownerId, opts = {}) {
  const allowed = await canAccessOwnedResource(user, ownerId);
  if (allowed) return;

  const { resource = "Resource", resourceId = null, req = null, message } = opts;

  // PRD Sprint 2: unauthorized access attempts on another user's data must be
  // security-logged for admin review. Never let logging failure mask the 403.
  prisma.activityLog
    .create({
      data: {
        userId: user?.id || null,
        action: "SECURITY_ACCESS_DENIED",
        resource,
        resourceId,
        metadata: {
          attemptedOwnerId: ownerId,
          actorRole: user?.role || null,
          actorEnterpriseRole: user?.enterpriseRole || null,
        },
        ipAddress: req?.ip || req?.headers?.["x-forwarded-for"] || null,
      },
    })
    .catch((err) =>
      console.error("[SecurityLog] Failed to record denied access:", err.message),
    );

  throw new ApiError(403, message || "Access denied");
}

/**
 * Returns the list of user ids in the caller's Enterprise tenant (master +
 * all team members), or null when the caller has no org link. Used to scope
 * company-wide listings (shipments, invoices) per PRD Sprint 8.
 */
async function getOrgMemberIds(user) {
  const masterId = getOrgMasterId(user);
  if (!masterId) return null;
  const members = await prisma.user.findMany({
    where: { OR: [{ id: masterId }, { masterId }] },
    select: { id: true },
  });
  return members.map((m) => m.id);
}

module.exports = { getOrgMasterId, getOrgMemberIds, canAccessOwnedResource, assertOwnedResourceAccess };
