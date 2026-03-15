// ─── admin.routes.js ──────────────────────────────────────────────────────────
const adminRouter = require('express').Router();
const adminController = require('../controllers/admin.controller');
const { authenticate, requireAdmin, requireSuperAdmin } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Admin
 *   description: Dashboard stats, app settings, and activity logs. All routes require ADMIN role.
 */

adminRouter.use(authenticate, requireAdmin);

/**
 * @swagger
 * /admin/dashboard:
 *   get:
 *     summary: Dashboard statistics overview
 *     tags: [Admin]
 *     description: Returns user counts, shipment counts by status (including last 30 days), and total revenue from paid shipments.
 *     responses:
 *       200:
 *         description: Dashboard stats returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     users:
 *                       type: object
 *                       properties:
 *                         total: { type: integer, example: 520 }
 *                         customers: { type: integer, example: 515 }
 *                         admins: { type: integer, example: 5 }
 *                     shipments:
 *                       type: object
 *                       properties:
 *                         total: { type: integer, example: 1240 }
 *                         pending: { type: integer, example: 24 }
 *                         delivered: { type: integer, example: 980 }
 *                         last30Days:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               status: { type: string }
 *                               _count: { type: object }
 *                     revenue:
 *                       type: object
 *                       properties:
 *                         total: { type: number, example: 12500000 }
 *                         currency: { type: string, example: NGN }
 *       403:
 *         description: Admin access required
 */
adminRouter.get('/dashboard', adminController.getDashboardStats);

/**
 * @swagger
 * /admin/settings:
 *   get:
 *     summary: Get all app settings
 *     tags: [Admin]
 *     description: Returns all app configuration settings as a key-value map, optionally filtered by group.
 *     parameters:
 *       - in: query
 *         name: group
 *         schema: { type: string }
 *         example: pricing
 *         description: Filter settings by group (e.g. general, pricing)
 *     responses:
 *       200:
 *         description: Settings returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     settings:
 *                       type: object
 *                       example:
 *                         currency: { value: "NGN", type: string, group: general }
 *                         fragile_surcharge_percent: { value: "10", type: number, group: pricing }
 *       403:
 *         description: Admin access required
 */
adminRouter.get('/settings', adminController.getSettings);

/**
 * @swagger
 * /admin/settings:
 *   post:
 *     summary: Create or update an app setting (Super Admin)
 *     tags: [Admin]
 *     description: Upserts a configuration value by key. Only callable by SUPER_ADMIN.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [key, value]
 *             properties:
 *               key:
 *                 type: string
 *                 example: fragile_surcharge_percent
 *               value:
 *                 type: string
 *                 example: "15"
 *               type:
 *                 type: string
 *                 enum: [string, number, boolean, json]
 *                 default: string
 *               group:
 *                 type: string
 *                 example: pricing
 *     responses:
 *       200:
 *         description: Setting updated
 *       403:
 *         description: Super admin access required
 */
adminRouter.post('/settings', requireSuperAdmin, adminController.updateSetting);

/**
 * @swagger
 * /admin/activity-logs:
 *   get:
 *     summary: Get activity audit logs
 *     tags: [Admin]
 *     description: Returns the most recent 50 activity log entries per page, with user details.
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *     responses:
 *       200:
 *         description: Activity logs returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     logs:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id: { type: string }
 *                           action: { type: string }
 *                           resource: { type: string }
 *                           resourceId: { type: string }
 *                           ipAddress: { type: string }
 *                           createdAt: { type: string, format: date-time }
 *                           user:
 *                             type: object
 *                             properties:
 *                               id: { type: string }
 *                               firstName: { type: string }
 *                               lastName: { type: string }
 *                               email: { type: string }
 *       403:
 *         description: Admin access required
 */
adminRouter.get('/activity-logs', adminController.getActivityLogs);

module.exports = adminRouter;
