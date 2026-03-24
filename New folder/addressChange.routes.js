// ─── address-change.routes.js ─────────────────────────────────────────────────
const acRouter = require('express').Router();
const acController = require('../controllers/addressChange.controller');
const { authenticate, requireLogisticsOrAbove } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Address Changes
 *   description: "Sprint 5 - Post-booking delivery address change workflow requiring admin approval"
 */

acRouter.use(authenticate);

/**
 * @swagger
 * /address-changes:
 *   post:
 *     summary: Request a delivery address change
 *     tags: [Address Changes]
 *     description: >
 *       Customer requests a change to the recipient's delivery address after booking.
 *       This triggers an "Approval Required" notification in the admin portal and pauses
 *       the shipment with status PENDING_ADMIN_REVIEW until reviewed.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [shipmentId, newRecipientAddress, newRecipientCity, newRecipientState]
 *             properties:
 *               shipmentId: { type: string, format: uuid }
 *               newRecipientAddress: { type: string, example: "12 New Layout Road" }
 *               newRecipientCity: { type: string, example: Aba }
 *               newRecipientState: { type: string, example: Abia }
 *               reason: { type: string, example: "Recipient moved to new address" }
 *     responses:
 *       201:
 *         description: Address change request submitted, awaiting admin approval
 *       400:
 *         description: Cannot request change for delivered/cancelled shipments
 *       409:
 *         description: A pending request already exists for this shipment
 */
acRouter.post('/', acController.requestAddressChange);

/**
 * @swagger
 * /address-changes/my:
 *   get:
 *     summary: My address change requests
 *     tags: [Address Changes]
 *     responses:
 *       200:
 *         description: List of the customer's address change requests
 */
acRouter.get('/my', acController.myAddressChangeRequests);

/**
 * @swagger
 * /address-changes:
 *   get:
 *     summary: All address change requests (Admin)
 *     tags: [Address Changes]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [PENDING, APPROVED, REJECTED] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *     responses:
 *       200:
 *         description: All requests returned
 *       403:
 *         description: Admin access required
 */
acRouter.get('/', requireLogisticsOrAbove, acController.listAddressChangeRequests);

/**
 * @swagger
 * /address-changes/{id}/review:
 *   patch:
 *     summary: Approve or reject an address change request (Admin)
 *     tags: [Address Changes]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [action]
 *             properties:
 *               action: { type: string, enum: [APPROVE, REJECT] }
 *               reviewNote: { type: string, example: "Address verified and confirmed" }
 *     responses:
 *       200:
 *         description: Request reviewed. Customer notified.
 *       400:
 *         description: Request already reviewed
 */
acRouter.patch('/:id/review', requireLogisticsOrAbove, acController.reviewAddressChange);

module.exports = acRouter;
