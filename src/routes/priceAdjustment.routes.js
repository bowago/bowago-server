// ─── price-adjustment.routes.js ──────────────────────────────────────────────
const paRouter = require('express').Router();
const paController = require('../controllers/priceAdjustment.controller');
const { authenticate, requireShipmentOpsManagement, requireTicketManagement } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Price Adjustments
 *   description: "Sprint 5 & 8 - Weight discrepancy adjustments found at the warehouse hub"
 */

paRouter.use(authenticate);

/**
 * @swagger
 * /price-adjustments:
 *   post:
 *     summary: Create a price adjustment for a shipment (Dispatcher/Admin)
 *     tags: [Price Adjustments]
 *     description: >
 *       Used when the warehouse weighs a package and finds it heavier than quoted.
 *       The shipment is paused (PENDING_ADMIN_REVIEW) and the customer is notified
 *       with the proof image and must respond within the configured response
 *       window (Settings → Business Rules) before it is auto-cancelled.
 *     responses:
 *       201: { description: Adjustment created. Customer notified. }
 *       403: { description: Admin access required }
 */
paRouter.post('/', requireShipmentOpsManagement, paController.createPriceAdjustment);

/**
 * @swagger
 * /price-adjustments/{id}/acknowledge:
 *   post:
 *     summary: "Customer option 1: pay the price difference"
 *     tags: [Price Adjustments]
 *     responses:
 *       200: { description: Returns a Paystack authorization URL to pay the difference. }
 */
paRouter.post('/:id/acknowledge', paController.acknowledgePriceAdjustment);

/**
 * @swagger
 * /price-adjustments/{id}/downgrade:
 *   post:
 *     summary: "Customer option 2: downgrade to a lower service tier"
 *     tags: [Price Adjustments]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [newServiceType]
 *             properties:
 *               newServiceType: { type: string, enum: [ECONOMY, STANDARD] }
 *     responses:
 *       200: { description: Price recalculated at the lower tier and applied. }
 */
paRouter.post('/:id/downgrade', paController.downgradePriceAdjustment);

/**
 * @swagger
 * /price-adjustments/{id}/cancel:
 *   post:
 *     summary: "Customer option 3: cancel the shipment and refund"
 *     tags: [Price Adjustments]
 *     description: >
 *       Refund percentage is configurable by Super Admin under
 *       Settings → Business Rules (price_adjustment.cancel_refund_percent).
 *     responses:
 *       200: { description: Shipment cancelled, refund initiated. }
 */
paRouter.post('/:id/cancel', paController.cancelPriceAdjustment);

/**
 * @swagger
 * /price-adjustments/{id}/contact-support:
 *   post:
 *     summary: "Customer option 4: contact support"
 *     tags: [Price Adjustments]
 *     description: Opens a PRICING_DISPUTE support ticket linked to the shipment, auto-assigned to a Finance agent.
 *     responses:
 *       201: { description: Support ticket created. }
 */
paRouter.post('/:id/contact-support', paController.contactSupportForAdjustment);

/**
 * @swagger
 * /price-adjustments/{id}/extend:
 *   post:
 *     summary: "Admin/Support override: extend the response deadline"
 *     tags: [Price Adjustments]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [hours]
 *             properties:
 *               hours: { type: number, example: 24 }
 *               note:  { type: string }
 *     responses:
 *       200: { description: Deadline extended. }
 */
paRouter.post('/:id/extend', requireTicketManagement, paController.extendAdjustmentDeadline);

/**
 * @swagger
 * /price-adjustments/shipment/{shipmentId}:
 *   get:
 *     summary: Get price adjustments for a shipment
 *     tags: [Price Adjustments]
 *     responses:
 *       200: { description: Adjustments returned }
 *       403: { description: Access denied }
 */
paRouter.get('/shipment/:shipmentId', paController.getShipmentAdjustments);

module.exports = paRouter;
