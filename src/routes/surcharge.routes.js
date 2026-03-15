const router = require('express').Router();
const surchargeController = require('../controllers/surcharge.controller');
const { authenticate, requireLogisticsOrAbove, requireSuperAdmin } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Surcharges
 *   description: Sprint 2 — Fuel surcharges, VAT, remote area fees, and price audit trail
 */

/**
 * @swagger
 * /surcharges:
 *   get:
 *     summary: List all surcharges
 *     tags: [Surcharges]
 *     security: []
 *     description: Returns all active surcharges with their labels and descriptions. Used to render the transparent quote breakdown on the frontend.
 *     parameters:
 *       - in: query
 *         name: active
 *         schema: { type: boolean }
 *         description: Pass true to return only active surcharges
 *     responses:
 *       200:
 *         description: Surcharges returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     surcharges:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id: { type: string }
 *                           type: { type: string, enum: [FUEL, REMOTE_AREA, VAT, FRAGILE, INSURANCE, OVERSIZE] }
 *                           label: { type: string, example: Fuel Surcharge }
 *                           description: { type: string, example: "Adjusted weekly based on global market prices" }
 *                           ratePercent: { type: number, example: 5.5 }
 *                           flatAmount: { type: number, nullable: true }
 *                           appliesTo: { type: string, example: ALL }
 */
router.get('/', surchargeController.listSurcharges);

/**
 * @swagger
 * /surcharges/preview:
 *   post:
 *     summary: Preview surcharge calculation
 *     tags: [Surcharges]
 *     security: []
 *     description: Given a base price, returns a full surcharge breakdown showing every line item and the grand total. Use this to power the quote result transparency view.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [basePrice]
 *             properties:
 *               basePrice: { type: number, example: 27000 }
 *               serviceType: { type: string, enum: [EXPRESS, STANDARD, ECONOMY], default: STANDARD }
 *               isFragile: { type: boolean, example: false }
 *               requiresInsurance: { type: boolean, example: false }
 *               insuranceValue: { type: number, example: 500000 }
 *     responses:
 *       200:
 *         description: Surcharge breakdown returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     basePrice: { type: number, example: 27000 }
 *                     breakdown:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           type: { type: string, example: FUEL }
 *                           label: { type: string, example: Fuel Surcharge }
 *                           description: { type: string }
 *                           amount: { type: number, example: 1485 }
 *                     totalSurcharge: { type: number, example: 2700 }
 *                     grandTotal: { type: number, example: 29700 }
 *                     currency: { type: string, example: NGN }
 */
router.post('/preview', surchargeController.previewSurcharges);

// ─── Admin routes ─────────────────────────────────────────────────────────────
router.use(authenticate, requireLogisticsOrAbove);

/**
 * @swagger
 * /surcharges:
 *   post:
 *     summary: Create a surcharge (Admin)
 *     tags: [Surcharges]
 *     description: Creates a new surcharge. Changes are logged to the price audit trail.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [type, label]
 *             properties:
 *               type: { type: string, enum: [FUEL, REMOTE_AREA, VAT, FRAGILE, INSURANCE, OVERSIZE] }
 *               label: { type: string, example: "Fuel Surcharge" }
 *               description: { type: string, example: "Adjusted weekly based on global market prices" }
 *               ratePercent: { type: number, example: 5.5, description: "Percentage of base price (provide one of ratePercent or flatAmount)" }
 *               flatAmount: { type: number, example: 500, description: "Fixed NGN amount" }
 *               appliesTo: { type: string, enum: [ALL, EXPRESS, STANDARD, ECONOMY], default: ALL }
 *     responses:
 *       201:
 *         description: Surcharge created
 *       403:
 *         description: Admin access required
 */
router.post('/', surchargeController.createSurcharge);

/**
 * @swagger
 * /surcharges/{id}:
 *   patch:
 *     summary: Update a surcharge (Admin)
 *     tags: [Surcharges]
 *     description: Updates the surcharge. All changes are logged to the price audit trail.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               label: { type: string }
 *               description: { type: string }
 *               ratePercent: { type: number }
 *               flatAmount: { type: number }
 *               isActive: { type: boolean }
 *               reason: { type: string, description: "Reason for change — stored in audit log" }
 *     responses:
 *       200:
 *         description: Surcharge updated
 *       404:
 *         description: Surcharge not found
 */
router.patch('/:id', surchargeController.updateSurcharge);

/**
 * @swagger
 * /surcharges/{id}:
 *   delete:
 *     summary: Delete a surcharge (Admin)
 *     tags: [Surcharges]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Surcharge deleted
 *       404:
 *         description: Not found
 */
router.delete('/:id', surchargeController.deleteSurcharge);

/**
 * @swagger
 * /surcharges/audit-log:
 *   get:
 *     summary: Price change audit trail (Admin)
 *     tags: [Surcharges]
 *     description: Sprint 8 — Full version history of all pricing changes including who changed what and when.
 *     parameters:
 *       - in: query
 *         name: entityType
 *         schema: { type: string, enum: [PriceBand, Surcharge, AppSettings] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *     responses:
 *       200:
 *         description: Audit logs returned
 */
router.get('/audit-log', requireSuperAdmin, surchargeController.getPriceAuditLog);

module.exports = router;
