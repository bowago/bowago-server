const router = require('express').Router();
const ctrl = require('../controllers/adminRole.controller');
const { authenticate, requireSuperAdmin } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Admin Roles
 *   description: >
 *     Sprint 2 (PRD v2) — SUPER_ADMIN creates custom admin staff roles with specific
 *     capability flags. This implements the ROLE_ADMIN system where each admin staff
 *     member has a tailored set of permissions instead of blanket access.
 *     Only SUPER_ADMIN can access these endpoints.
 */

router.use(authenticate, requireSuperAdmin);

/**
 * @swagger
 * /admin/roles/capabilities:
 *   get:
 *     summary: List all available capability flags (SUPER_ADMIN)
 *     tags: [Admin Roles]
 *     description: Returns the full list of capability keys that can be toggled when assigning a custom role.
 *     responses:
 *       200:
 *         description: Capabilities listed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     capabilities:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           key: { type: string, example: canManageRates }
 *                           label: { type: string, example: Manage Rates }
 *                           description: { type: string }
 */
router.get('/capabilities', ctrl.listCapabilities);

/**
 * @swagger
 * /admin/roles:
 *   get:
 *     summary: List all staff custom role assignments (SUPER_ADMIN)
 *     tags: [Admin Roles]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Role assignments returned
 */
router.get('/', ctrl.listAdminRoles);

/**
 * @swagger
 * /admin/roles/{userId}:
 *   get:
 *     summary: Get a specific staff member's role permissions (SUPER_ADMIN)
 *     tags: [Admin Roles]
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Role permissions returned
 *       404:
 *         description: No custom role found for this user
 */
router.get('/:userId', ctrl.getAdminRole);

/**
 * @swagger
 * /admin/roles:
 *   post:
 *     summary: Assign a custom admin role to a staff member (SUPER_ADMIN)
 *     tags: [Admin Roles]
 *     description: >
 *       Creates or replaces the custom role for an admin user. Sets their adminSubRole
 *       to ROLE_ADMIN and defines which capabilities they have. The user must already
 *       have role=ADMIN. Cannot be used on another SUPER_ADMIN.
 *
 *       **Available capabilities:**
 *       - canManageRates — price bands, contract rates, promo rates
 *       - canManageUsers — user accounts, admin role assignment
 *       - canManageShipments — update/assign shipments
 *       - canViewAnalytics — reporting and KPI dashboards
 *       - canManageTickets — support ticket operations
 *       - canManageInvoices — invoices and refunds
 *       - canManageSurcharges — surcharge configuration
 *       - canManagePromos — promo codes and rates
 *       - canManageClaims — insurance claim review
 *       - canBulkNotify — bulk delay alerts and notifications
 *       - canViewAuditLogs — pricing audit trail and activity logs
 *       - canManageOrganization — organization members and invites
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId:
 *                 type: string
 *                 format: uuid
 *                 description: ID of the admin user to assign the role to
 *               roleLabel:
 *                 type: string
 *                 example: "Rate Manager"
 *                 description: Human-readable label for this custom role
 *               notes:
 *                 type: string
 *                 example: "Handles Zone 1 pricing only"
 *               canManageRates:        { type: boolean, default: false }
 *               canManageUsers:        { type: boolean, default: false }
 *               canManageShipments:    { type: boolean, default: false }
 *               canViewAnalytics:      { type: boolean, default: false }
 *               canManageTickets:      { type: boolean, default: false }
 *               canManageInvoices:     { type: boolean, default: false }
 *               canManageSurcharges:   { type: boolean, default: false }
 *               canManagePromos:       { type: boolean, default: false }
 *               canManageClaims:       { type: boolean, default: false }
 *               canBulkNotify:         { type: boolean, default: false }
 *               canViewAuditLogs:      { type: boolean, default: false }
 *               canManageOrganization: { type: boolean, default: false }
 *     responses:
 *       201:
 *         description: Custom role assigned
 *       403:
 *         description: Cannot modify a SUPER_ADMIN
 *       404:
 *         description: Target user not found
 */
router.post('/', ctrl.assignCustomRole);

/**
 * @swagger
 * /admin/roles/{userId}:
 *   patch:
 *     summary: Update a staff member's custom role capabilities (SUPER_ADMIN)
 *     tags: [Admin Roles]
 *     description: Update one or more capability flags for an existing custom role. Only the fields provided are updated.
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               roleLabel:             { type: string }
 *               notes:                 { type: string }
 *               canManageRates:        { type: boolean }
 *               canManageUsers:        { type: boolean }
 *               canManageShipments:    { type: boolean }
 *               canViewAnalytics:      { type: boolean }
 *               canManageTickets:      { type: boolean }
 *               canManageInvoices:     { type: boolean }
 *               canManageSurcharges:   { type: boolean }
 *               canManagePromos:       { type: boolean }
 *               canManageClaims:       { type: boolean }
 *               canBulkNotify:         { type: boolean }
 *               canViewAuditLogs:      { type: boolean }
 *               canManageOrganization: { type: boolean }
 *     responses:
 *       200:
 *         description: Role updated
 *       404:
 *         description: Custom role not found
 */
router.patch('/:userId', ctrl.updateCustomRole);

/**
 * @swagger
 * /admin/roles/{userId}:
 *   delete:
 *     summary: Revoke a staff member's custom role (SUPER_ADMIN)
 *     tags: [Admin Roles]
 *     description: >
 *       Removes the custom role assignment and reverts the user to LOGISTICS_MANAGER (the legacy
 *       default admin sub-role). The user retains ADMIN role access but loses all custom capabilities.
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Role revoked
 *       403:
 *         description: Cannot revoke a SUPER_ADMIN
 */
router.delete('/:userId', ctrl.revokeCustomRole);

module.exports = router;
