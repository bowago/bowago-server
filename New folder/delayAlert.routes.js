const router = require('express').Router();
const delayAlertController = require('../controllers/delayAlert.controller');
const { authenticate, requireLogisticsOrAbove } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Delay Alerts
 *   description: "Sprint 5 - Proactive batch delay notifications sent to multiple customers at once"
 */

router.use(authenticate, requireLogisticsOrAbove);

/**
 * @swagger
 * /delay-alerts/send:
 *   post:
 *     summary: Send proactive delay alert to multiple customers (Admin)
 *     tags: [Delay Alerts]
 *     description: >
 *       Admin selects a batch of shipments and sends a delay notification to all affected customers
 *       simultaneously. Includes a reason and updated ETA. Sends both in-app notification and email.
 *       Can be used for mass events like "Customs Hold in Lagos" or "Road closure in Abuja".
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [shipmentIds, reason]
 *             properties:
 *               shipmentIds:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *                 description: List of shipment IDs affected by the delay
 *               reason:
 *                 type: string
 *                 example: "Customs Hold at Apapa Port — documentation review required"
 *               newEstimatedDelivery:
 *                 type: string
 *                 format: date-time
 *                 example: "2026-03-18T17:00:00Z"
 *                 description: Updated delivery estimate (optional)
 *               message:
 *                 type: string
 *                 description: Optional custom message to override the auto-generated text
 *     responses:
 *       200:
 *         description: Delay alerts sent
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     results:
 *                       type: object
 *                       properties:
 *                         notified: { type: integer, example: 47 }
 *                         errors: { type: array, items: { type: object } }
 *       400:
 *         description: No shipment IDs provided
 *       403:
 *         description: Admin access required
 */
router.post('/send', delayAlertController.sendDelayAlert);

/**
 * @swagger
 * /delay-alerts/overdue:
 *   get:
 *     summary: Get shipments past their estimated delivery date (Admin)
 *     tags: [Delay Alerts]
 *     description: Returns all in-transit shipments where the estimated delivery date has passed and they are not yet delivered. Use to identify candidates for delay alerts.
 *     responses:
 *       200:
 *         description: Overdue shipments returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     shipments:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Shipment'
 *                     count: { type: integer, example: 12 }
 */
router.get('/overdue', delayAlertController.getDelayedShipments);

module.exports = router;
