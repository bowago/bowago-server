const router = require('express').Router();
const claimsController = require('../controllers/claims.controller');
const { authenticate, requireLogisticsOrAbove } = require('../middleware/auth');
const { uploadDocument } = require('../config/cloudinary');

/**
 * @swagger
 * tags:
 *   name: Claims
 *   description: Sprint 7 — Insurance claims for damaged, lost, or delayed shipments
 */

router.use(authenticate);

/**
 * @swagger
 * /claims:
 *   post:
 *     summary: File an insurance claim
 *     tags: [Claims]
 *     description: >
 *       File a claim for a delivered, failed, or returned shipment.
 *       Accepts image uploads as evidence (field name: images, max 5 files).
 *       Each claim is programmatically linked to a Shipment ID to prevent duplicates.
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [shipmentId, type, description, declaredValue, claimAmount]
 *             properties:
 *               shipmentId: { type: string, format: uuid }
 *               type: { type: string, enum: [DAMAGE, LOSS, DELAY], example: DAMAGE }
 *               description: { type: string, example: "Electronics found cracked upon delivery" }
 *               declaredValue: { type: number, example: 250000 }
 *               claimAmount: { type: number, example: 200000 }
 *               bankName: { type: string, example: "GTBank" }
 *               accountNumber: { type: string, example: "0123456789" }
 *               accountName: { type: string, example: "Chidi Okafor" }
 *               images:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *                 description: Photos of damage (max 5 files, max 20MB each)
 *     responses:
 *       201:
 *         description: Claim submitted successfully
 *       400:
 *         description: Cannot file claim for shipments not yet delivered
 *       409:
 *         description: A claim already exists for this shipment
 */
router.post('/', uploadDocument.array('images', 5), claimsController.fileClaim);

/**
 * @swagger
 * /claims/my:
 *   get:
 *     summary: My claims
 *     tags: [Claims]
 *     responses:
 *       200:
 *         description: Customer's claims returned with images and shipment info
 */
router.get('/my', claimsController.myClaims);

/**
 * @swagger
 * /claims/{id}:
 *   get:
 *     summary: Get claim details
 *     tags: [Claims]
 *     description: Customers can view their own claims. Admins can view all.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Claim details returned
 *       403:
 *         description: Access denied
 *       404:
 *         description: Claim not found
 */
router.get('/:id', claimsController.getClaim);

/**
 * @swagger
 * /claims:
 *   get:
 *     summary: List all claims (Admin)
 *     tags: [Claims]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [SUBMITTED, UNDER_REVIEW, APPROVED, REJECTED, PAID] }
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [DAMAGE, LOSS, DELAY] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *     responses:
 *       200:
 *         description: Claims list returned
 *       403:
 *         description: Admin access required
 */
router.get('/', requireLogisticsOrAbove, claimsController.listClaims);

/**
 * @swagger
 * /claims/{id}/review:
 *   patch:
 *     summary: Review a claim (Admin)
 *     tags: [Claims]
 *     description: Update claim status through the review pipeline. Customer is notified at each stage.
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
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [UNDER_REVIEW, APPROVED, REJECTED, PAID]
 *               reviewNote: { type: string, example: "Damage verified from submitted images" }
 *               approvedAmount: { type: number, example: 180000 }
 *     responses:
 *       200:
 *         description: Claim updated. Customer notified.
 *       404:
 *         description: Claim not found
 */
router.patch('/:id/review', requireLogisticsOrAbove, claimsController.reviewClaim);

module.exports = router;
