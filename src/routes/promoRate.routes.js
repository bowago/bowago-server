const router = require('express').Router();
const ctrl = require('../controllers/promoRate.controller');
const { authenticate, requireLogisticsOrAbove } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Promo Rates
 *   description: >
 *     Sprint 2 — Promotional discount codes. Applied when no contract rate exists.
 *     Guests and customers can validate a code before applying it.
 *     Admin manages creation and lifecycle.
 */

/**
 * @swagger
 * /promo-rates/validate:
 *   post:
 *     summary: Validate a promo code (Public — Guest & Customer)
 *     tags: [Promo Rates]
 *     security: []
 *     description: >
 *       Checks if a promo code is valid and returns its discount details WITHOUT applying it
 *       and WITHOUT incrementing the usage count. Use this to show the user a discount preview
 *       on the quote screen before they confirm booking.
 *       To actually apply the discount, pass the promoCode in POST /pricing/quote.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code]
 *             properties:
 *               code:
 *                 type: string
 *                 example: LAUNCH20
 *                 description: Case-insensitive promo code
 *               zone:
 *                 type: integer
 *                 description: Optional — validate against a specific zone
 *               serviceType:
 *                 type: string
 *                 enum: [EXPRESS, STANDARD, ECONOMY]
 *               weightKg:
 *                 type: number
 *                 description: Optional — check minimum weight requirement
 *     responses:
 *       200:
 *         description: Code is valid
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     valid: { type: boolean, example: true }
 *                     promo:
 *                       type: object
 *                       properties:
 *                         code:            { type: string, example: LAUNCH20 }
 *                         label:           { type: string, example: "20% off standard shipments" }
 *                         discountPercent: { type: number, example: 20, nullable: true }
 *                         flatDiscount:    { type: number, nullable: true }
 *                         validUntil:      { type: string, format: date-time, nullable: true }
 *                         usageRemaining:  { type: integer, nullable: true, description: "null = unlimited" }
 *       404:
 *         description: Invalid, expired, or does not apply to this shipment
 *       400:
 *         description: Usage limit reached
 */
router.post('/validate', ctrl.validatePromoCode);

// ─── Admin routes ─────────────────────────────────────────────────────────────
router.use(authenticate, requireLogisticsOrAbove);

/**
 * @swagger
 * /promo-rates:
 *   get:
 *     summary: List all promo codes (Admin)
 *     tags: [Promo Rates]
 *     parameters:
 *       - in: query
 *         name: isActive
 *         schema: { type: boolean }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *     responses:
 *       200:
 *         description: Promo codes returned
 *       403:
 *         description: Admin access required
 */
router.get('/', ctrl.listPromoRates);

/**
 * @swagger
 * /promo-rates:
 *   post:
 *     summary: Create a promo code (Admin)
 *     tags: [Promo Rates]
 *     description: >
 *       Creates a new promotional discount code.
 *       Provide exactly ONE of discountPercent or flatDiscount.
 *       Leave scope fields (serviceType, zone, minWeightKg) as null to apply to all shipments.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code, label]
 *             properties:
 *               code:
 *                 type: string
 *                 example: LAUNCH20
 *                 description: Unique code, stored uppercase, case-insensitive on validation
 *               label:
 *                 type: string
 *                 example: "Launch Promo — 20% off all standard shipments"
 *               description:
 *                 type: string
 *                 example: "Valid for first 500 customers through March 2026"
 *               discountPercent:
 *                 type: number
 *                 example: 20
 *                 description: "% off base price. Use ONE of this or flatDiscount."
 *               flatDiscount:
 *                 type: number
 *                 example: 2000
 *                 description: "Fixed ₦2,000 off base price"
 *               serviceType:
 *                 type: string
 *                 enum: [EXPRESS, STANDARD, ECONOMY]
 *                 nullable: true
 *                 description: "null = applies to all service types"
 *               zone:
 *                 type: integer
 *                 nullable: true
 *                 description: "null = applies to all zones"
 *               minWeightKg:
 *                 type: number
 *                 nullable: true
 *                 description: "Minimum shipment weight to qualify"
 *               maxUsageCount:
 *                 type: integer
 *                 nullable: true
 *                 description: "null = unlimited uses"
 *               validFrom:  { type: string, format: date-time }
 *               validUntil: { type: string, format: date-time }
 *     responses:
 *       201:
 *         description: Promo code created
 *       409:
 *         description: Code already exists
 *       400:
 *         description: Invalid discount configuration
 */
router.post('/', ctrl.createPromoRate);

/**
 * @swagger
 * /promo-rates/{id}:
 *   patch:
 *     summary: Update a promo code (Admin)
 *     tags: [Promo Rates]
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
 *               label:           { type: string }
 *               isActive:        { type: boolean }
 *               maxUsageCount:   { type: integer }
 *               discountPercent: { type: number }
 *               flatDiscount:    { type: number }
 *               validUntil:      { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Updated
 *       404:
 *         description: Not found
 */
router.patch('/:id', ctrl.updatePromoRate);

/**
 * @swagger
 * /promo-rates/{id}:
 *   delete:
 *     summary: Delete a promo code (Admin)
 *     tags: [Promo Rates]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Deleted
 */
router.delete('/:id', ctrl.deletePromoRate);

module.exports = router;
