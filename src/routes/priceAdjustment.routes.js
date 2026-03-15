// ─── price-adjustment.routes.js ──────────────────────────────────────────────
const paRouter = require('express').Router();
const paController = require('../controllers/priceAdjustment.controller');
const { authenticate, requireLogisticsOrAbove } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Price Adjustments
 *   description: Sprint 5 & 8 — Weight discrepancy adjustments found at the warehouse hub
 */

paRouter.use(authenticate);

/**
 * @swagger
 * /price-adjustments:
 *   post:
 *     summary: Create a price adjustment for a shipment (Admin)
 *     tags: [Price Adjustments]
 *     description: >
 *       Used when the warehouse weighs a package and finds it heavier than quoted.
 *       The shipment is paused (PENDING_ADMIN_REVIEW) and the customer is notified
 *       with the proof image and must pay the difference before the shipment proceeds.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [shipmentId, adjustedPrice, reason]
 *             properties:
 *               shipmentId: { type: string, format: uuid }
 *               adjustedPrice: { type: number, example: 35000 }
 *               reason: { type: string, example: "Weight discrepancy: quoted 50kg, actual 65kg" }
 *               actualWeightKg: { type: number, example: 65 }
 *               proofImageUrl: { type: string, description: "Cloudinary URL of scale photo" }
 *     responses:
 *       201:
 *         description: Adjustment created. Customer notified.
 *       403:
 *         description: Admin access required
 */
paRouter.post('/', requireLogisticsOrAbove, paController.createPriceAdjustment);

/**
 * @swagger
 * /price-adjustments/{id}/acknowledge:
 *   post:
 *     summary: Customer acknowledges price adjustment and initiates payment
 *     tags: [Price Adjustments]
 *     description: >
 *       Customer reviews the adjustment and agrees to pay the difference.
 *       Returns a Paystack authorization URL to complete the top-up payment.
 *       The shipment resumes once payment is verified.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Acknowledged. Returns Paystack payment URL for the difference.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     adjustment: { type: object }
 *                     payment:
 *                       type: object
 *                       properties:
 *                         reference: { type: string }
 *                         authorizationUrl: { type: string }
 *       400:
 *         description: Already acknowledged
 */
paRouter.post('/:id/acknowledge', paController.acknowledgePriceAdjustment);

/**
 * @swagger
 * /price-adjustments/shipment/{shipmentId}:
 *   get:
 *     summary: Get price adjustments for a shipment
 *     tags: [Price Adjustments]
 *     parameters:
 *       - in: path
 *         name: shipmentId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Adjustments returned
 *       403:
 *         description: Access denied
 */
paRouter.get('/shipment/:shipmentId', paController.getShipmentAdjustments);

module.exports = paRouter;
