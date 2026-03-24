// ─── promoCode.routes.js ──────────────────────────────────────────────────────
const promoRouter = require('express').Router();
const promoController = require('../controllers/promoCode.controller');
const { authenticate, requireLogisticsOrAbove, requireSuperAdmin } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Promo Codes
 *   description: "Sprint 2 - Discount codes. Priority: Contract Rate > Promo > Standard"
 */

/**
 * @swagger
 * /promo-codes/validate:
 *   post:
 *     summary: Validate and preview promo code discount
 *     tags: [Promo Codes]
 *     description: >
 *       Validates a promo code against the user's account and a given base price.
 *       Returns the discount amount and final price without creating a shipment.
 *       Call this when the user types a promo code in the booking form.
 *       Note: If the user has an active contract rate, promo codes will not apply.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code, basePrice]
 *             properties:
 *               code: { type: string, example: WELCOME20 }
 *               basePrice: { type: number, example: 27000, description: "Base shipping cost before discount" }
 *               serviceType: { type: string, enum: [EXPRESS, STANDARD, ECONOMY], default: STANDARD }
 *     responses:
 *       200:
 *         description: "Promo code valid - discount details returned"
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     code: { type: string, example: WELCOME20 }
 *                     discountType: { type: string, enum: [FLAT, PERCENT] }
 *                     discountAmount: { type: number, example: 5400 }
 *                     finalPrice: { type: number, example: 21600 }
 *                     isValid: { type: boolean, example: true }
 *       400:
 *         description: Invalid/expired code, usage limit reached, or minimum order not met
 */
promoRouter.post('/validate', authenticate, promoController.previewPromoCode);

// ─── Admin ────────────────────────────────────────────────────────────────────
promoRouter.use(authenticate, requireLogisticsOrAbove);

/**
 * @swagger
 * /promo-codes:
 *   post:
 *     summary: Create promo code (Admin)
 *     tags: [Promo Codes]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code]
 *             properties:
 *               code: { type: string, example: WELCOME20, description: "Automatically uppercased" }
 *               description: { type: string, example: "20% off for new customers" }
 *               discountPercent: { type: number, example: 20, description: "Provide this OR flatDiscount" }
 *               flatDiscount: { type: number, example: 5000, description: "₦5000 off. Provide this OR discountPercent" }
 *               minOrderAmount: { type: number, example: 10000, description: "Minimum order value in NGN" }
 *               maxUses: { type: integer, example: 500, description: "null = unlimited" }
 *               validFrom: { type: string, format: date-time }
 *               validUntil: { type: string, format: date-time }
 *               serviceType: { type: string, enum: [EXPRESS, STANDARD, ECONOMY], nullable: true }
 *     responses:
 *       201:
 *         description: Promo code created
 */
promoRouter.post('/', promoController.createPromoCode);

/**
 * @swagger
 * /promo-codes:
 *   get:
 *     summary: List all promo codes (Admin)
 *     tags: [Promo Codes]
 *     parameters:
 *       - in: query
 *         name: isActive
 *         schema: { type: boolean }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *     responses:
 *       200:
 *         description: Promo codes list with redemption counts
 */
promoRouter.get('/', promoController.listPromoCodes);

/**
 * @swagger
 * /promo-codes/{id}:
 *   patch:
 *     summary: Update promo code (Admin)
 *     tags: [Promo Codes]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Updated
 */
promoRouter.patch('/:id', promoController.updatePromoCode);

/**
 * @swagger
 * /promo-codes/{id}:
 *   delete:
 *     summary: Deactivate promo code (Admin)
 *     tags: [Promo Codes]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Deactivated
 */
promoRouter.delete('/:id', requireSuperAdmin, promoController.deletePromoCode);

module.exports = promoRouter;
