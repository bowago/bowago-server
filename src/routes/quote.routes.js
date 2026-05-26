const router = require('express').Router();
const ctrl = require('../controllers/quote.controller');
const { optionalAuth, authenticate } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Quotes
 *   description: >
 *     Sprint 1 (Gap Fix) — Quote lifecycle management.
 *     Quotes are valid for exactly 15 minutes (expiresAt = createdAt + 15 min).
 *     Status transitions: GENERATED → EXPIRED (auto) | GENERATED → BOOKED | GENERATED → CANCELLED.
 *     All prices stored in Kobo internally to avoid floating-point errors.
 *     Guest access allowed — no authentication required to generate a quote.
 */

/**
 * @swagger
 * /quotes:
 *   post:
 *     summary: Generate a shipping quote (Guest or Authenticated)
 *     tags: [Quotes]
 *     security: []
 *     description: >
 *       Calculates a shipping quote based on weight/dimensions, origin, destination, and service type.
 *       Returns a quoteId valid for exactly 15 minutes. If the user is authenticated, contract rates
 *       and promo codes are evaluated. All prices returned in both Naira (display) and Kobo (audit).
 *       At booking time, the frontend passes quoteId to POST /shipments — the quote is locked.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [originCity, destinationCity]
 *             properties:
 *               originCity:
 *                 type: string
 *                 example: "Lagos"
 *               destinationCity:
 *                 type: string
 *                 example: "Aba"
 *               weightKg:
 *                 type: number
 *                 example: 15
 *                 description: "Provide one of: weightKg, tons, cartons, or dimensions"
 *               tons:          { type: number, example: 0.015 }
 *               cartons:       { type: integer, example: 2 }
 *               lengthCm:      { type: number, example: 50 }
 *               widthCm:       { type: number, example: 40 }
 *               heightCm:      { type: number, example: 30 }
 *               boxDimensionId: { type: string, format: uuid }
 *               serviceType:
 *                 type: string
 *                 enum: [EXPRESS, STANDARD, ECONOMY]
 *                 default: STANDARD
 *               insuranceSelected:
 *                 type: boolean
 *                 default: false
 *                 description: "User opts in to insurance coverage"
 *               declaredValue:
 *                 type: number
 *                 example: 500000
 *                 description: "Declared value of goods in Naira (required if insuranceSelected=true)"
 *               promoCode:
 *                 type: string
 *                 example: "LAUNCH20"
 *                 description: "Optional promo code. Only applied if no contract rate exists."
 *     responses:
 *       201:
 *         description: Quote generated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     quoteId:         { type: string, format: uuid }
 *                     status:          { type: string, enum: [GENERATED] }
 *                     expiresAt:       { type: string, format: date-time, description: "createdAt + 15 min" }
 *                     expiresInSeconds: { type: integer, example: 900 }
 *                     billableWeightKg: { type: number, example: 15 }
 *                     serviceType:     { type: string, enum: [EXPRESS, STANDARD, ECONOMY] }
 *                     pricing:
 *                       type: object
 *                       properties:
 *                         basePriceNaira:        { type: number, example: 4500 }
 *                         fuelSurchargeNaira:    { type: number, example: 247.5 }
 *                         remoteAreaFeeNaira:    { type: number, example: 0 }
 *                         vatNaira:              { type: number, example: 356.06 }
 *                         insurancePremiumNaira: { type: number, nullable: true, example: 12500 }
 *                         totalNaira:            { type: number, example: 5103.56 }
 *                         basePriceKobo:         { type: integer, example: 450000 }
 *                         totalPriceKobo:        { type: integer, example: 510356 }
 *                     currency: { type: string, example: NGN }
 *       400:
 *         description: City not found, no pricing for route, or missing weight
 *       404:
 *         description: Rate not found for this weight band
 */
router.post('/', optionalAuth, ctrl.generateQuote);

/**
 * @swagger
 * /quotes/{id}:
 *   get:
 *     summary: Get a quote by ID
 *     tags: [Quotes]
 *     security: []
 *     description: >
 *       Returns the full quote record. If the quote status is GENERATED but the
 *       current time is past expiresAt, the status is automatically updated to EXPIRED.
 *       The frontend should redirect users to generate a new quote when status=EXPIRED.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Quote returned
 *       404:
 *         description: Quote not found
 */
router.get('/:id', ctrl.getQuote);

/**
 * @swagger
 * /quotes/{id}/cancel:
 *   patch:
 *     summary: Cancel a quote
 *     tags: [Quotes]
 *     description: Cancels a GENERATED quote. Cannot cancel EXPIRED or BOOKED quotes.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Quote cancelled
 *       400:
 *         description: Quote is not in GENERATED status
 */
router.patch('/:id/cancel', authenticate, ctrl.cancelQuote);

module.exports = router;
