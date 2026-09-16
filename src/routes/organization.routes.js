const router = require('express').Router();
const orgController = require('../controllers/organization.controller');
const { authenticate } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Organization
 *   description: B2B team management — Sprint 8 (Master Account + Role Assignment)
 */

/**
 * @swagger
 * /organization/invite-member:
 *   post:
 *     summary: Invite a team member (ROLE_MASTER / SUPER_ADMIN)
 *     tags: [Organization]
 *     description: >
 *       Sends an email invite to join the BowaGO platform with the specified role.
 *       The invite expires after 7 days. PRD Sprint 8.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, role]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "dispatcher@company.ng"
 *               role:
 *                 type: string
 *                 enum: [ROLE_MASTER, ROLE_DISPATCHER, ROLE_FINANCE, ROLE_AGENT, ROLE_USER]
 *                 example: "ROLE_DISPATCHER"
 *     responses:
 *       201:
 *         description: Invite sent
 *       400:
 *         description: Validation error or user already exists
 *       403:
 *         description: Not authorized to invite
 */
router.post('/invite-member', authenticate, orgController.inviteMember);

/**
 * @swagger
 * /organization/accept-invite:
 *   post:
 *     summary: Accept an invite and create account (public)
 *     tags: [Organization]
 *     description: >
 *       Invited user submits token + name + password to activate their account.
 *       Returns an access token on success.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, firstName, lastName, password]
 *             properties:
 *               token:     { type: string, description: "Token from invite email" }
 *               firstName: { type: string, example: "Amaka" }
 *               lastName:  { type: string, example: "Obi" }
 *               password:  { type: string, format: password }
 *               phone:     { type: string, example: "+2348012345678" }
 *     responses:
 *       200:
 *         description: Account created, tokens returned
 *       400:
 *         description: Invalid, expired, or already-used token
 */
router.post('/accept-invite', orgController.acceptInvite);

/**
 * @swagger
 * /organization/invites:
 *   get:
 *     summary: List sent invites (Admin / ROLE_MASTER)
 *     tags: [Organization]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [PENDING, ACCEPTED, EXPIRED, CANCELLED]
 *     responses:
 *       200:
 *         description: Invites list
 */
router.get('/invites', authenticate, orgController.listInvites);

/**
 * @swagger
 * /organization/invites/{id}:
 *   delete:
 *     summary: Cancel a pending invite
 *     tags: [Organization]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Invite cancelled
 */
router.delete('/invites/:id', authenticate, orgController.cancelInvite);

/**
 * @swagger
 * /organization/invites/{id}/resend:
 *   post:
 *     summary: Resend / refresh an invite
 *     tags: [Organization]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Invite resent with new token
 */
router.post('/invites/:id/resend', authenticate, orgController.resendInvite);

/**
 * @swagger
 * /organization/register:
 *   post:
 *     summary: Upgrade to Business account (self-service)
 *     tags: [Organization]
 *     description: >
 *       Any CUSTOMER can self-upgrade to a Business account (ROLE_MASTER).
 *       Requires company name at minimum. Once upgraded the user can invite
 *       team members with DISPATCHER, FINANCE, or VIEWER roles.
 *       Calling again updates company details only (idempotent).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [companyName]
 *             properties:
 *               companyName:    { type: string, example: "Obi Logistics Ltd" }
 *               industry:       { type: string, example: "Logistics" }
 *               companyEmail:   { type: string, format: email }
 *               companyPhone:   { type: string }
 *               companyWebsite: { type: string }
 *               streetAddress:  { type: string }
 *               city:           { type: string }
 *               state:          { type: string }
 *               country:        { type: string, default: "Nigeria" }
 *               zipCode:        { type: string }
 *     responses:
 *       201: { description: Upgraded to business account }
 *       200: { description: Already a business — company details updated }
 *       400: { description: companyName required }
 */
router.post('/register', authenticate, orgController.registerOrganization);

/**
 * @swagger
 * /organization/status:
 *   get:
 *     summary: Get my organisation status
 *     tags: [Organization]
 *     description: Returns isBusiness flag, company info, and team member count.
 *     responses:
 *       200: { description: Org status returned }
 */
router.get('/status', authenticate, orgController.getOrganizationStatus);

/**
 * @swagger
 * /organization/members:
 *   get:
 *     summary: List my company's actual team roster (ROLE_MASTER)
 *     tags: [Organization]
 *     description: >
 *       Unlike /organization/invites (invite history), this returns the live
 *       User rows currently in the tenant — id, name, enterpriseRole,
 *       isActive — so a Master can see and manage who is actually in the
 *       company today. Internal SUPER_ADMIN/LOGISTICS_MANAGER may pass
 *       ?masterId= to inspect a specific tenant for support.
 *     parameters:
 *       - in: query
 *         name: masterId
 *         schema: { type: string, format: uuid }
 *         description: Required for internal staff; ignored for a Master (uses their own tenant).
 *     responses:
 *       200: { description: Team roster returned }
 *       403: { description: Not a Master or internal staff }
 */
router.get('/members', authenticate, orgController.listTeamMembers);

/**
 * @swagger
 * /organization/members/{id}/role:
 *   patch:
 *     summary: Change a team member's role (ROLE_MASTER)
 *     tags: [Organization]
 *     description: >
 *       Updates an existing team member's enterpriseRole. Cannot be used on
 *       the company owner. The target must already belong to your company.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [role]
 *             properties:
 *               role:
 *                 type: string
 *                 enum: [ROLE_MASTER, ROLE_DISPATCHER, ROLE_FINANCE, ROLE_AGENT, ROLE_USER]
 *     responses:
 *       200: { description: Role updated }
 *       403: { description: Only the company Master can do this }
 *       404: { description: Team member not found in your company }
 */
router.patch('/members/:id/role', authenticate, orgController.updateMemberRole);

/**
 * @swagger
 * /organization/members/{id}/status:
 *   patch:
 *     summary: Remove or reactivate a team member (ROLE_MASTER)
 *     tags: [Organization]
 *     description: >
 *       Toggles isActive on a team member's account — the company owner's
 *       way to revoke (and later restore) a teammate's access. Reversible;
 *       does not delete their history.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Status toggled }
 *       403: { description: Only the company Master can do this }
 *       404: { description: Team member not found in your company }
 */
router.patch('/members/:id/status', authenticate, orgController.toggleMemberStatus);

module.exports = router;
