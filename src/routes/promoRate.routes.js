const router = require('express').Router();
const ctrl = require('../controllers/promoRate.controller');
const { authenticate, requireLogisticsOrAbove } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Promo Rates
 *   description: >
 *     Sprint 1/2 — Admin-defined promotional rate codes applied at the pricing engine level.
 *     PromoRate is zone/service-aware (e.g. "20% off Zone 1 EXPRESS"). Distinct from PromoCode
 *     (customer-facing coupon codes). The pricing engine checks PromoRates automatically.
 *     Guests and customers can validate a code before booking. Admin manages lifecycle.
 */

/**
 * @swagger
 * /promo-rates/validate:
 *   post:
 *     summary: Validate a promo rate code (Public)
 *     tags: [Promo Rates]
 *     security: []
 *     description: >
 *       Checks if a promo rate code is valid and returns its discount details WITHOUT applying it.
 *       Use this to show the user a discount preview on the quote screen before they confirm booking.
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
 *                 example: PROMO20
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
 *     summary: List all promo rates (Admin)
 *     tags: [Promo Rates]
 *     parameters:
 *       - in: query
 *         name: isActive
 *         schema: { type: boolean }
 *         description: Filter by active/inactive status
 *       - in: query
 *         name: serviceType
 *         schema: { type: string, enum: [EXPRESS, STANDARD, ECONOMY] }
 *       - in: query
 *         name: zone
 *         schema: { type: integer }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Promo rates returned
 *       403:
 *         description: Admin access required
 */
router.get('/', ctrl.listPromoRates);

/**
 * @swagger
 * /promo-rates:
 *   post:
 *     summary: Create a promo rate (Admin)
 *     tags: [Promo Rates]
 *     description: >
 *       Creates a new admin-defined promotional rate code.
 *       Provide exactly ONE of discountPercent or flatDiscount.
 *       Leave scope fields (serviceType, zone, minWeightKg) as null to apply to all shipments.
 *       serviceType is optional — if omitted, the promo applies to all service types (STANDARD, EXPRESS, ECONOMY).
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
 *                 example: PROMO20
 *                 description: Unique code, stored uppercase
 *               label:
 *                 type: string
 *                 example: "20% off all Zone 1 shipments"
 *               description:
 *                 type: string
 *               discountPercent:
 *                 type: number
 *                 example: 20
 *                 description: "% off base price. Provide this OR flatDiscount — not both."
 *               flatDiscount:
 *                 type: number
 *                 example: 5000
 *                 description: "Fixed ₦ off base price. Provide this OR discountPercent — not both."
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
 *               maxUsageCount:
 *                 type: integer
 *                 nullable: true
 *                 description: "null = unlimited uses"
 *               validFrom:  { type: string, format: date-time }
 *               validUntil: { type: string, format: date-time }
 *     responses:
 *       201:
 *         description: Promo rate created
 *       409:
 *         description: Code already exists
 *       400:
 *         description: Invalid discount configuration
 */
router.post('/', ctrl.createPromoRate);

/**
 * @swagger
 * /promo-rates/{id}:
 *   get:
 *     summary: Get a single promo rate (Admin)
 *     tags: [Promo Rates]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Promo rate returned
 *       404:
 *         description: Not found
 */
router.get('/:id', ctrl.getPromoRate);

/**
 * @swagger
 * /promo-rates/{id}:
 *   patch:
 *     summary: Update a promo rate (Admin)
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
 *               serviceType:     { type: string, enum: [EXPRESS, STANDARD, ECONOMY] }
 *               zone:            { type: integer }
 *               validFrom:       { type: string, format: date-time }
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
 *     summary: Delete a promo rate (Admin)
 *     tags: [Promo Rates]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Deleted
 *       404:
 *         description: Not found
 */
router.delete('/:id', ctrl.deletePromoRate);

module.exports = router;
