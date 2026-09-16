/**
 * Enterprise Team Invite — Sprint 8
 * PRD: ROLE_MASTER invites team members into their Enterprise tenant; invite
 * expires 7 days. Invited users are created with role = ENTERPRISE and an
 * enterpriseRole — they are NEVER given role = ADMIN. This endpoint has
 * nothing to do with Internal BowaGo Administration (see adminRole.controller.js
 * for that).
 * Roles available: ROLE_MASTER, ROLE_AGENT, ROLE_DISPATCHER, ROLE_FINANCE, ROLE_USER.
 */

const crypto = require("crypto");
const { prisma } = require("../config/db");
const { ApiError } = require("../utils/ApiError");
const { getOrgMasterId, getOrgMemberIds } = require("../utils/access");
const {
  success,
  created,
  getPagination,
  buildMeta,
} = require("../utils/helpers");
const { sendInviteEmail } = require("../config/email");

// Internal staff who may act on behalf of ANY tenant (not just their own,
// unlike a ROLE_MASTER): SUPER_ADMIN/LOGISTICS_MANAGER always qualify; a
// ROLE_ADMIN qualifies only if explicitly granted the "canManageOrganization"
// capability (see adminRole.controller.js — that capability was previously
// described and toggleable in the Super Admin's role UI but never actually
// checked anywhere, so granting it had zero effect. This is that check).
const SUPER_COMPAT = ["SUPER_ADMIN", "LOGISTICS_MANAGER"];
async function isInternalOrgManager(user) {
  if (user.role !== "ADMIN") return false;
  if (SUPER_COMPAT.includes(user.adminSubRole)) return true;
  if (user.adminSubRole !== "ROLE_ADMIN") return false;
  const perm = await prisma.adminRolePermission.findUnique({
    where: { userId: user.id },
  });
  return !!(perm && perm.canManageOrganization);
}

const INVITE_EXPIRY_DAYS = 7;
const ALLOWED_INVITE_ROLES = [
  "ROLE_AGENT",
  "ROLE_DISPATCHER",
  "ROLE_FINANCE",
  "ROLE_USER",
  "ROLE_MASTER",
];

// ─── POST /organization/invite-member ─────────────────────────────────────────
// ROLE_MASTER (owner of the tenant) or internal SUPER_ADMIN invites a new
// Enterprise team member. This never creates internal ADMIN users.
async function inviteMember(req, res) {
  const { email, role } = req.body;

  if (!email || !role) throw new ApiError(400, "email and role are required");
  if (!ALLOWED_INVITE_ROLES.includes(role)) {
    throw new ApiError(
      400,
      `Invalid role. Must be one of: ${ALLOWED_INVITE_ROLES.join(", ")}`,
    );
  }

  // Only the tenant's ROLE_MASTER, or internal platform staff assisting with
  // onboarding, can send Enterprise invites.
  const inviter = req.user;
  const isInternalStaff = await isInternalOrgManager(inviter);
  const isOrgMaster =
    inviter.role === "ENTERPRISE" && inviter.enterpriseRole === "ROLE_MASTER";

  if (!isInternalStaff && !isOrgMaster) {
    throw new ApiError(
      403,
      "Only your company's Master user or Super Admins can invite team members.",
    );
  }

  // Check if email already registered
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing)
    throw new ApiError(409, `A user with email "${email}" already exists.`);

  // Cancel any existing pending invite for this email
  await prisma.orgInvite.updateMany({
    where: { email, status: "PENDING" },
    data: { status: "CANCELLED" },
  });

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(
    Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  );

  // Invites sent by internal staff on behalf of a tenant still need to be
  // scoped to that tenant's masterId — an org master invites under their
  // tenant's true root (getOrgMasterId resolves this even for a co-owner
  // ROLE_MASTER who was themselves invited by the original owner, so a
  // multi-master org stays a single flat tenant instead of forking every
  // time one master invites someone), and internal staff must pass
  // masterId explicitly in the body.
  const masterId = isOrgMaster ? getOrgMasterId(inviter) : req.body.masterId || null;
  if (isInternalStaff && !masterId) {
    throw new ApiError(
      400,
      "masterId is required when an internal admin sends an Enterprise invite",
    );
  }

  const invite = await prisma.orgInvite.create({
    data: {
      email,
      role,
      invitedBy: masterId,
      token,
      expiresAt,
      status: "PENDING",
    },
  });

  const baseUrl = process.env.FRONTEND_URL || "https://bowago.app";
  const inviteUrl = `${baseUrl}/auth/accept-invite?token=${token}`;

  let emailSent = true;
  let emailError = null;
  try {
    await sendInviteEmail({
      toEmail: email,
      inviterName: `${inviter.firstName} ${inviter.lastName}`,
      role,
      inviteUrl,
      expiryDays: INVITE_EXPIRY_DAYS,
    });
  } catch (err) {
    emailSent = false;
    emailError = err.message || "Unknown error";
    console.error("[OrgInvite] Email send failed:", emailError);
  }

  await prisma.orgInvite.update({
    where: { id: invite.id },
    data: { emailSent, emailError },
  });

  return created(
    res,
    {
      inviteId: invite.id,
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expiresAt,
      inviteUrl, // returned for dev/test — omit or mask in production UI
      emailSent,
      emailError,
    },
    emailSent
      ? "Invite sent successfully"
      : "Invite created, but the email failed to send — use Resend or share the invite link directly.",
  );
}

// ─── POST /organization/accept-invite ────────────────────────────────────────
// Invited user clicks the link, sets their password, account is created.
async function acceptInvite(req, res) {
  const { token, firstName, lastName, password, phone } = req.body;

  if (!token || !firstName || !lastName || !password) {
    throw new ApiError(
      400,
      "token, firstName, lastName, and password are required",
    );
  }

  const invite = await prisma.orgInvite.findUnique({ where: { token } });
  if (!invite) throw new ApiError(404, "Invalid or expired invite link");
  if (invite.status !== "PENDING") {
    throw new ApiError(
      400,
      `This invite has already been ${invite.status.toLowerCase()}`,
    );
  }
  if (new Date() > invite.expiresAt) {
    await prisma.orgInvite.update({
      where: { id: invite.id },
      data: { status: "EXPIRED" },
    });
    throw new ApiError(
      400,
      "This invite has expired. Ask your team lead to send a new one.",
    );
  }

  // Create the user with the invited role
  const bcrypt = require("bcryptjs");
  const passwordHash = await bcrypt.hash(password, 12);

  // Every org-invited role is an Enterprise tenant role. Enterprise users are
  // NEVER given role = ADMIN — that field is reserved for internal BowaGo staff.
  const user = await prisma.user.create({
    data: {
      email: invite.email,
      firstName,
      lastName,
      phone: phone || null,
      passwordHash,
      role: "ENTERPRISE",
      enterpriseRole: invite.role,
      // Org membership: stamp masterId so shipments/invoices can be scoped to this org
      masterId: invite.invitedBy,
      isEmailVerified: true, // Invite flow skips email verification
      authProvider: "EMAIL",
    },
  });

  // Mark invite as accepted
  await prisma.orgInvite.update({
    where: { id: invite.id },
    data: { status: "ACCEPTED", acceptedAt: new Date() },
  });

  const { generateTokenPair } = require("../config/jwt");
  const tokens = await generateTokenPair(
    user,
    req.headers["user-agent"],
    req.ip,
  );

  const { passwordHash: _ph, ...safeUser } = user;
  return success(
    res,
    { user: safeUser, ...tokens },
    "Welcome to BowaGO! Your account has been created.",
  );
}

// ─── GET /organization/invites ────────────────────────────────────────────────
// List all invites sent (master/super-admin view).
async function listInvites(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { status } = req.query;

  const where = {
    ...(status && { status }),
  };

  // A master (root owner or an invited co-owner) sees their whole company's
  // invite history — invitedBy is always stamped with the tenant's resolved
  // root (see inviteMember), so a co-owner must look up that same root
  // rather than filtering on their own id. Internal SUPER_ADMIN/
  // LOGISTICS_MANAGER, or a ROLE_ADMIN granted canManageOrganization, see
  // everything, across every tenant.
  const isInternalStaff = await isInternalOrgManager(req.user);
  if (!isInternalStaff) {
    const orgMasterId = getOrgMasterId(req.user);
    if (!orgMasterId) {
      throw new ApiError(403, "Only your company's Master user or Super Admins can view invites");
    }
    where.invitedBy = orgMasterId;
  }

  const [invites, total] = await Promise.all([
    prisma.orgInvite.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.orgInvite.count({ where }),
  ]);

  return success(
    res,
    { invites },
    "Invites retrieved",
    200,
    buildMeta(total, page, limit),
  );
}

// ─── DELETE /organization/invites/:id ────────────────────────────────────────
// Cancel a pending invite.
async function cancelInvite(req, res) {
  const { id } = req.params;

  const invite = await prisma.orgInvite.findUnique({ where: { id } });
  if (!invite) throw new ApiError(404, "Invite not found");

  // A master (root or co-owner) can act on any invite for their company —
  // invitedBy is stamped with the tenant's resolved root, so compare against
  // that, not the caller's own id. Internal staff (including a ROLE_ADMIN
  // granted canManageOrganization) can act on any tenant's.
  const isInternalStaff = await isInternalOrgManager(req.user);
  if (!isInternalStaff && invite.invitedBy !== getOrgMasterId(req.user)) {
    throw new ApiError(403, "You can only manage invites for your own company");
  }

  if (invite.status === "PENDING") {
    // Original behaviour, unchanged: cancelling a still-open invite just
    // marks it CANCELLED (soft) — the row stays visible so there's a
    // record of what happened and who sent it.
    await prisma.orgInvite.update({
      where: { id },
      data: { status: "CANCELLED" },
    });
    return success(res, {}, "Invite cancelled");
  }

  if (["CANCELLED", "EXPIRED"].includes(invite.status)) {
    // Previously calling this same endpoint again on an already-cancelled
    // invite threw "Only pending invites can be cancelled" — there was no
    // way to actually clear a dead invite out of the list, it just sat
    // there forever. A terminal (already-cancelled/expired) invite carries
    // no useful history once you're done with it, so this permanently
    // removes the row instead.
    await prisma.orgInvite.delete({ where: { id } });
    return success(res, {}, "Invite removed");
  }

  throw new ApiError(
    400,
    invite.status === "ACCEPTED"
      ? "This invite has already been accepted and cannot be removed here."
      : "This invite cannot be cancelled or removed in its current state.",
  );
}

// ─── POST /organization/invites/:id/resend ────────────────────────────────────
// Resend an expired or pending invite (generates a new token, resets expiry).
async function resendInvite(req, res) {
  const { id } = req.params;

  const invite = await prisma.orgInvite.findUnique({ where: { id } });
  if (!invite) throw new ApiError(404, "Invite not found");
  if (invite.status === "ACCEPTED") {
    throw new ApiError(400, "This invite has already been accepted");
  }

  // Same isolation rule as cancelInvite: a master (root or co-owner) may
  // resend any invite for their own company — compare against the tenant's
  // resolved root, not the caller's own id — internal staff (including a
  // ROLE_ADMIN granted canManageOrganization) may resend any.
  const isInternalStaff = await isInternalOrgManager(req.user);
  if (!isInternalStaff && invite.invitedBy !== getOrgMasterId(req.user)) {
    throw new ApiError(403, "You can only manage invites for your own company");
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(
    Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  );

  const updated = await prisma.orgInvite.update({
    where: { id },
    data: { token, expiresAt, status: "PENDING" },
  });

  const baseUrl = process.env.FRONTEND_URL || "https://bowago.app";
  const inviteUrl = `${baseUrl}/auth/accept-invite?token=${token}`;

  let emailSent = true;
  let emailError = null;
  try {
    await sendInviteEmail({
      toEmail: invite.email,
      inviterName: "your team admin",
      role: invite.role,
      inviteUrl,
      expiryDays: INVITE_EXPIRY_DAYS,
    });
  } catch (err) {
    emailSent = false;
    emailError = err.message || "Unknown error";
    console.error("[OrgInvite] Resend email failed:", emailError);
  }

  await prisma.orgInvite.update({
    where: { id },
    data: { emailSent, emailError },
  });

  return success(
    res,
    {
      inviteId: updated.id,
      expiresAt: updated.expiresAt,
      emailSent,
      emailError,
    },
    emailSent
      ? "Invite resent"
      : "Invite refreshed, but the email failed to send — share the invite link directly.",
  );
}

// ─── POST /organization/register ─────────────────────────────────────────────
// Self-service: any CUSTOMER upgrades their account to an Enterprise tenant
// (role = ENTERPRISE, enterpriseRole = ROLE_MASTER). This NEVER touches the
// internal ADMIN role — an Enterprise owner is not, and never becomes, BowaGo
// platform staff.
// PRD Sprint 8: "First user to sign up with company email → ROLE_MASTER"
// Requires companyName at minimum. Once upgraded the user can invite team members.
async function registerOrganization(req, res) {
  const {
    companyName,
    industry,
    companyEmail,
    companyPhone,
    companyWebsite,
    streetAddress,
    city,
    state,
    country,
    zipCode,
  } = req.body;

  if (!companyName || !companyName.trim()) {
    throw new ApiError(
      400,
      "companyName is required to register as a business",
    );
  }

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) throw new ApiError(404, "User not found");

  if (user.role === "ADMIN") {
    throw new ApiError(
      400,
      "Internal BowaGo staff accounts cannot register an Enterprise tenant",
    );
  }

  // Already an organisation — idempotent: just update company details
  if (user.role === "ENTERPRISE" && user.enterpriseRole === "ROLE_MASTER") {
    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        companyName: companyName.trim(),
        industry: industry || null,
        companyEmail: companyEmail || null,
        companyPhone: companyPhone || null,
        companyWebsite: companyWebsite || null,
        companyStreet: streetAddress || null,
        companyCity: city || null,
        companyState: state || null,
        companyCountry: country || null,
        companyZip: zipCode || null,
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
        enterpriseRole: true,
        companyName: true,
        industry: true,
        companyEmail: true,
      },
    });
    return success(
      res,
      { user: updated, isNewOrganization: false },
      "Business details updated",
    );
  }

  // Upgrade: CUSTOMER → ENTERPRISE / ROLE_MASTER
  const upgraded = await prisma.user.update({
    where: { id: req.user.id },
    data: {
      role: "ENTERPRISE",
      enterpriseRole: "ROLE_MASTER",
      companyName: companyName.trim(),
      industry: industry || null,
      companyEmail: companyEmail || null,
      companyPhone: companyPhone || null,
      companyWebsite: companyWebsite || null,
      companyStreet: streetAddress || null,
      companyCity: city || null,
      companyState: state || null,
      companyCountry: country || null,
      companyZip: zipCode || null,
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      role: true,
      enterpriseRole: true,
      companyName: true,
      industry: true,
      companyEmail: true,
      companyPhone: true,
      companyWebsite: true,
    },
  });

  // Audit log
  await prisma.activityLog.create({
    data: {
      userId: req.user.id,
      action: "UPGRADE_TO_BUSINESS",
      resource: "User",
      resourceId: req.user.id,
      metadata: { companyName: companyName.trim(), previousRole: "CUSTOMER" },
    },
  });

  return created(
    res,
    { user: upgraded, isNewOrganization: true },
    `Welcome! "${companyName.trim()}" is now registered as a business account. You can invite your team members.`,
  );
}

// ─── GET /organization/status ─────────────────────────────────────────────────
// Returns the current user's organisation status and company details.
async function getOrganizationStatus(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true,
      role: true,
      enterpriseRole: true,
      masterId: true,
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
    },
  });

  const isBusiness =
    user.role === "ENTERPRISE" && user.enterpriseRole === "ROLE_MASTER";

  // Live count of everyone actually in the tenant (root + team members),
  // not a count of invite rows this exact user happened to send — a
  // co-owner ROLE_MASTER should see the same total as the original owner.
  // Excludes the master themselves from "team" count (root + N members,
  // minus 1 for the root).
  const teamCount = isBusiness
    ? Math.max(0, ((await getOrgMemberIds(user)) || []).length - 1)
    : 0;

  return success(res, {
    isBusiness,
    role: user.role,
    enterpriseRole: user.enterpriseRole,
    company: isBusiness
      ? {
          name: user.companyName,
          industry: user.industry,
          email: user.companyEmail,
          phone: user.companyPhone,
          website: user.companyWebsite,
          address: {
            street: user.companyStreet,
            city: user.companyCity,
            state: user.companyState,
            country: user.companyCountry,
            zip: user.companyZip,
          },
        }
      : null,
    teamCount,
  });
}

// ─── GET /organization/members ─────────────────────────────────────────────
// The actual current team roster (live User rows) — as opposed to
// listInvites, which only shows invite history. This is what a ROLE_MASTER
// needs to see who is currently active in their company and what role each
// person holds, which nothing previously exposed.
async function listTeamMembers(req, res) {
  const isInternalStaff = await isInternalOrgManager(req.user);

  let masterId;
  if (isInternalStaff) {
    masterId = req.query.masterId;
    if (!masterId) {
      throw new ApiError(
        400,
        "masterId query param is required for internal staff",
      );
    }
  } else {
    masterId = getOrgMasterId(req.user);
    if (!masterId) {
      throw new ApiError(
        403,
        "Only your company's Master user or Super Admins can view the team roster",
      );
    }
  }

  const members = await prisma.user.findMany({
    where: { OR: [{ id: masterId }, { masterId }] },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      enterpriseRole: true,
      isActive: true,
      createdAt: true,
    },
    orderBy: [{ enterpriseRole: "asc" }, { createdAt: "asc" }],
  });

  return success(res, { members });
}

// ─── PATCH /organization/members/:id/role ──────────────────────────────────
// A ROLE_MASTER changes a teammate's enterpriseRole after they've already
// joined — the piece that was missing: previously the only lever a master
// had was inviteMember, which only sets the role once at invite time.
async function updateMemberRole(req, res) {
  const { id } = req.params;
  const { role } = req.body;

  if (req.user.role !== "ENTERPRISE" || req.user.enterpriseRole !== "ROLE_MASTER") {
    throw new ApiError(403, "Only your company's Master user can manage team members");
  }
  if (!ALLOWED_INVITE_ROLES.includes(role)) {
    throw new ApiError(
      400,
      `Invalid role. Must be one of: ${ALLOWED_INVITE_ROLES.join(", ")}`,
    );
  }

  const masterId = getOrgMasterId(req.user);
  if (id === masterId) {
    throw new ApiError(400, "Cannot change the company owner's role here");
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target || target.role !== "ENTERPRISE" || target.masterId !== masterId) {
    throw new ApiError(404, "Team member not found");
  }

  const updated = await prisma.user.update({
    where: { id },
    data: { enterpriseRole: role },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      enterpriseRole: true,
    },
  });

  await prisma.activityLog
    .create({
      data: {
        userId: req.user.id,
        action: "UPDATE_TEAM_MEMBER_ROLE",
        resource: "User",
        resourceId: id,
        metadata: { newRole: role },
      },
    })
    .catch(() => {});

  return success(res, { user: updated }, "Team member role updated");
}

// ─── PATCH /organization/members/:id/status ────────────────────────────────
// A ROLE_MASTER's way to "remove" a team member — soft (isActive toggle,
// same mechanism used platform-wide by requireUserManagement's
// toggleUserStatus), so it's reversible and doesn't destroy their history.
// Previously the only account status lever was /users/:id/status, which is
// internal-ADMIN-only — a company owner had no way to do this themselves.
async function toggleMemberStatus(req, res) {
  const { id } = req.params;

  if (req.user.role !== "ENTERPRISE" || req.user.enterpriseRole !== "ROLE_MASTER") {
    throw new ApiError(403, "Only your company's Master user can manage team members");
  }

  const masterId = getOrgMasterId(req.user);
  if (id === masterId) {
    throw new ApiError(400, "Cannot change your own access here");
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target || target.role !== "ENTERPRISE" || target.masterId !== masterId) {
    throw new ApiError(404, "Team member not found");
  }

  const updated = await prisma.user.update({
    where: { id },
    data: { isActive: !target.isActive },
    select: { id: true, email: true, isActive: true },
  });

  await prisma.activityLog
    .create({
      data: {
        userId: req.user.id,
        action: updated.isActive
          ? "REACTIVATE_TEAM_MEMBER"
          : "REMOVE_TEAM_MEMBER",
        resource: "User",
        resourceId: id,
      },
    })
    .catch(() => {});

  return success(
    res,
    { user: updated },
    `Team member ${updated.isActive ? "reactivated" : "removed"}`,
  );
}

module.exports = {
  inviteMember,
  acceptInvite,
  listInvites,
  cancelInvite,
  resendInvite,
  registerOrganization,
  getOrganizationStatus,
  listTeamMembers,
  updateMemberRole,
  toggleMemberStatus,
};
