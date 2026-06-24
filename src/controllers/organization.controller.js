/**
 * Organization Team Invite — Sprint 8
 * PRD: Master Account invites team members; invite expires 7 days.
 * Roles available: ADMIN, ROLE_DISPATCHER, ROLE_FINANCE, ROLE_USER (viewer).
 */

const crypto = require('crypto');
const { prisma } = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { success, created, getPagination, buildMeta } = require('../utils/helpers');

const INVITE_EXPIRY_DAYS = 7;
const ALLOWED_INVITE_ROLES = [
  'ROLE_ADMIN',
  'ROLE_DISPATCHER',
  'ROLE_FINANCE',
  'ROLE_USER',
  'ROLE_MASTER',
];

// ─── POST /organization/invite-member ─────────────────────────────────────────
// ROLE_MASTER or SUPER_ADMIN invites a new team member.
async function inviteMember(req, res) {
  const { email, role } = req.body;

  if (!email || !role) throw new ApiError(400, 'email and role are required');
  if (!ALLOWED_INVITE_ROLES.includes(role)) {
    throw new ApiError(400, `Invalid role. Must be one of: ${ALLOWED_INVITE_ROLES.join(', ')}`);
  }

  // Only ROLE_MASTER and SUPER_ADMIN can send invites
  const inviter = req.user;
  const canInvite =
    inviter.adminSubRole === 'SUPER_ADMIN' ||
    inviter.adminSubRole === 'LOGISTICS_MANAGER' ||
    inviter.adminSubRole === 'ROLE_MASTER';
  if (!canInvite) {
    throw new ApiError(403, 'Only Master users or Super Admins can invite team members.');
  }

  // Check if email already registered
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new ApiError(409, `A user with email "${email}" already exists.`);

  // Cancel any existing pending invite for this email
  await prisma.orgInvite.updateMany({
    where: { email, status: 'PENDING' },
    data: { status: 'CANCELLED' },
  });

  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const invite = await prisma.orgInvite.create({
    data: {
      email,
      role,
      invitedBy: inviter.id,
      token,
      expiresAt,
      status: 'PENDING',
    },
  });

  // Build invite URL
  const baseUrl = process.env.FRONTEND_URL || 'https://app.bowago.com';
  const inviteUrl = `${baseUrl}/auth/accept-invite?token=${token}`;

  // Send invite email (non-blocking)
  const { transporter } = require('../config/email');
  if (transporter) {
    transporter.sendMail({
      to:      email,
      from:    process.env.EMAIL_FROM || 'noreply@bowago.com',
      subject: `You've been invited to join BowaGO`,
      html: `
        <p>Hi,</p>
        <p><strong>${inviter.firstName} ${inviter.lastName}</strong> has invited you to join the BowaGO platform as a <strong>${role.replace('ROLE_', '')}</strong>.</p>
        <p>Click the link below to accept your invite and set your password. This link expires in ${INVITE_EXPIRY_DAYS} days.</p>
        <p><a href="${inviteUrl}" style="background:#1F3A70;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;">Accept Invite</a></p>
        <p>Or copy this link: <code>${inviteUrl}</code></p>
        <p>If you did not expect this invite, you can safely ignore this email.</p>
      `,
    }).catch((err) => console.error('[OrgInvite] Email send failed:', err.message));
  }

  return created(res, {
    inviteId:  invite.id,
    email:     invite.email,
    role:      invite.role,
    expiresAt: invite.expiresAt,
    inviteUrl, // returned for dev/test — omit or mask in production UI
  }, 'Invite sent successfully');
}

// ─── POST /organization/accept-invite ────────────────────────────────────────
// Invited user clicks the link, sets their password, account is created.
async function acceptInvite(req, res) {
  const { token, firstName, lastName, password, phone } = req.body;

  if (!token || !firstName || !lastName || !password) {
    throw new ApiError(400, 'token, firstName, lastName, and password are required');
  }

  const invite = await prisma.orgInvite.findUnique({ where: { token } });
  if (!invite) throw new ApiError(404, 'Invalid or expired invite link');
  if (invite.status !== 'PENDING') {
    throw new ApiError(400, `This invite has already been ${invite.status.toLowerCase()}`);
  }
  if (new Date() > invite.expiresAt) {
    await prisma.orgInvite.update({ where: { id: invite.id }, data: { status: 'EXPIRED' } });
    throw new ApiError(400, 'This invite has expired. Ask your team lead to send a new one.');
  }

  // Create the user with the invited role
  const bcrypt = require('bcryptjs');
  const passwordHash = await bcrypt.hash(password, 12);

  const isAdminRole = ['SUPER_ADMIN', 'LOGISTICS_MANAGER', 'ROLE_ADMIN', 'ROLE_AGENT'].includes(invite.role);

  const user = await prisma.user.create({
    data: {
      email:         invite.email,
      firstName,
      lastName,
      phone:         phone || null,
      passwordHash,
      role:          isAdminRole ? 'ADMIN' : 'CUSTOMER',
      adminSubRole:  invite.role,
      isEmailVerified: true, // Invite flow skips email verification
      authProvider:  'EMAIL',
    },
  });

  // Mark invite as accepted
  await prisma.orgInvite.update({
    where: { id: invite.id },
    data: { status: 'ACCEPTED', acceptedAt: new Date() },
  });

  const { generateTokenPair } = require('../config/jwt');
  const tokens = await generateTokenPair(user, req.headers['user-agent'], req.ip);

  const { passwordHash: _ph, ...safeUser } = user;
  return success(res, { user: safeUser, ...tokens }, 'Welcome to BowaGO! Your account has been created.');
}

// ─── GET /organization/invites ────────────────────────────────────────────────
// List all invites sent (master/super-admin view).
async function listInvites(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { status } = req.query;

  const where = {
    ...(status && { status }),
  };

  // ROLE_MASTER can only see invites they sent; SUPER_ADMIN sees all
  if (
    req.user.adminSubRole === 'ROLE_MASTER' ||
    req.user.adminSubRole === 'LOGISTICS_MANAGER'
  ) {
    where.invitedBy = req.user.id;
  }

  const [invites, total] = await Promise.all([
    prisma.orgInvite.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.orgInvite.count({ where }),
  ]);

  return success(res, { invites }, 'Invites retrieved', 200, buildMeta(total, page, limit));
}

// ─── DELETE /organization/invites/:id ────────────────────────────────────────
// Cancel a pending invite.
async function cancelInvite(req, res) {
  const { id } = req.params;

  const invite = await prisma.orgInvite.findUnique({ where: { id } });
  if (!invite) throw new ApiError(404, 'Invite not found');
  if (invite.status !== 'PENDING') {
    throw new ApiError(400, 'Only pending invites can be cancelled');
  }

  // ROLE_MASTER can only cancel their own invites
  if (
    req.user.adminSubRole === 'ROLE_MASTER' &&
    invite.invitedBy !== req.user.id
  ) {
    throw new ApiError(403, 'You can only cancel invites you sent');
  }

  await prisma.orgInvite.update({
    where: { id },
    data: { status: 'CANCELLED' },
  });

  return success(res, {}, 'Invite cancelled');
}

// ─── POST /organization/invites/:id/resend ────────────────────────────────────
// Resend an expired or pending invite (generates a new token, resets expiry).
async function resendInvite(req, res) {
  const { id } = req.params;

  const invite = await prisma.orgInvite.findUnique({ where: { id } });
  if (!invite) throw new ApiError(404, 'Invite not found');
  if (invite.status === 'ACCEPTED') {
    throw new ApiError(400, 'This invite has already been accepted');
  }

  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const updated = await prisma.orgInvite.update({
    where: { id },
    data: { token, expiresAt, status: 'PENDING' },
  });

  const baseUrl   = process.env.FRONTEND_URL || 'https://app.bowago.com';
  const inviteUrl = `${baseUrl}/auth/accept-invite?token=${token}`;

  const { transporter } = require('../config/email');
  if (transporter) {
    transporter.sendMail({
      to:      invite.email,
      from:    process.env.EMAIL_FROM || 'noreply@bowago.com',
      subject: `Your BowaGO invite has been resent`,
      html: `<p>Your invite to join BowaGO as <strong>${invite.role.replace('ROLE_', '')}</strong> has been refreshed.</p>
             <p><a href="${inviteUrl}">Accept Invite</a> (expires in ${INVITE_EXPIRY_DAYS} days)</p>`,
    }).catch(() => {});
  }

  return success(res, { inviteId: updated.id, expiresAt: updated.expiresAt }, 'Invite resent');
}

// ─── POST /organization/register ─────────────────────────────────────────────
// Self-service: any CUSTOMER upgrades their account to a Business (ROLE_MASTER).
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
    throw new ApiError(400, 'companyName is required to register as a business');
  }

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) throw new ApiError(404, 'User not found');

  // Already an organisation — idempotent: just update company details
  if (user.adminSubRole === 'ROLE_MASTER' || user.role === 'ADMIN') {
    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        companyName:    companyName.trim(),
        industry:       industry       || null,
        companyEmail:   companyEmail   || null,
        companyPhone:   companyPhone   || null,
        companyWebsite: companyWebsite || null,
        companyStreet:  streetAddress  || null,
        companyCity:    city           || null,
        companyState:   state          || null,
        companyCountry: country        || null,
        companyZip:     zipCode        || null,
      },
      select: {
        id: true, firstName: true, lastName: true, email: true,
        role: true, adminSubRole: true,
        companyName: true, industry: true, companyEmail: true,
      },
    });
    return success(res, { user: updated, isNewOrganization: false },
      'Business details updated');
  }

  // Upgrade: CUSTOMER → ROLE_MASTER
  const upgraded = await prisma.user.update({
    where: { id: req.user.id },
    data: {
      role:           'ADMIN',
      adminSubRole:   'ROLE_MASTER',
      companyName:    companyName.trim(),
      industry:       industry       || null,
      companyEmail:   companyEmail   || null,
      companyPhone:   companyPhone   || null,
      companyWebsite: companyWebsite || null,
      companyStreet:  streetAddress  || null,
      companyCity:    city           || null,
      companyState:   state          || null,
      companyCountry: country        || null,
      companyZip:     zipCode        || null,
    },
    select: {
      id: true, firstName: true, lastName: true, email: true,
      role: true, adminSubRole: true,
      companyName: true, industry: true, companyEmail: true,
      companyPhone: true, companyWebsite: true,
    },
  });

  // Audit log
  await prisma.activityLog.create({
    data: {
      userId: req.user.id,
      action: 'UPGRADE_TO_BUSINESS',
      resource: 'User',
      resourceId: req.user.id,
      metadata: { companyName: companyName.trim(), previousRole: 'CUSTOMER' },
    },
  });

  return created(res, { user: upgraded, isNewOrganization: true },
    `Welcome! "${companyName.trim()}" is now registered as a business account. You can invite your team members.`);
}

// ─── GET /organization/status ─────────────────────────────────────────────────
// Returns the current user's organisation status and company details.
async function getOrganizationStatus(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true, role: true, adminSubRole: true,
      companyName: true, industry: true, companyEmail: true,
      companyPhone: true, companyWebsite: true,
      companyStreet: true, companyCity: true,
      companyState: true, companyCountry: true, companyZip: true,
    },
  });

  const isBusiness = user.adminSubRole === 'ROLE_MASTER';

  // Count team members invited by this user
  const teamCount = isBusiness
    ? await prisma.orgInvite.count({
        where: { invitedBy: req.user.id, status: 'ACCEPTED' },
      })
    : 0;

  return success(res, {
    isBusiness,
    role: user.role,
    adminSubRole: user.adminSubRole,
    company: isBusiness ? {
      name:     user.companyName,
      industry: user.industry,
      email:    user.companyEmail,
      phone:    user.companyPhone,
      website:  user.companyWebsite,
      address: {
        street:  user.companyStreet,
        city:    user.companyCity,
        state:   user.companyState,
        country: user.companyCountry,
        zip:     user.companyZip,
      },
    } : null,
    teamCount,
  });
}

module.exports = {
  inviteMember,
  acceptInvite,
  listInvites,
  cancelInvite,
  resendInvite,
  registerOrganization,
  getOrganizationStatus,
};
