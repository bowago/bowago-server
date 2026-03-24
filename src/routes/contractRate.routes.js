const router = require('express').Router();
const c = require('../controllers/contractRate.controller');
const { authenticate, requireLogisticsOrAbove, requireSuperAdmin } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Contract Rates
 *   description: "Sprint 2 - B2B enterprise rate cards. Logic priority: Contract Rate > Promo > Standard"
 */

/**
 * @swagger
 * /contract-rates/my:
 *   get:
 *     summary: Get my contract rate (Customer)
 *     tags: [Contract Rates]
 *     description: >
 *       Returns the authenticated user's enterprise rate card if one exists.
 *       Enterprise clients see lower prices than guests for identical shipments.
 *       Returns { hasContract: false } for regular customers.
 *       Viewing your own rate card is logged in the security audit trail.
 *     responses:
 *       200:
 *         description: Contract rate returned (or hasContract false)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     hasContract: { type: boolean }
 *                     discountType: { type: string, enum: [PERCENT, FIXED_PER_ZONE], nullable: true }
 *                     contractRate:
 *                       $ref: '#/components/schemas/ContractRate'
 */
router.get('/my', authenticate, c.getMyContractRate);

// ─── Admin routes ─────────────────────────────────────────────────────────────
router.use(authenticate, requireLogisticsOrAbove);

/**
 * @swagger
 * /contract-rates:
 *   post:
 *     summary: Assign/update enterprise rate card (Admin)
 *     tags: [Contract Rates]
 *     description: >
 *       Assigns a B2B rate card to a specific user. Each user can only have ONE active rate card.
 *       Calling this again for the same userId updates the existing card.
 *       Two discount modes — use ONE:
 *       - discountPercent: flat % off the standard price (e.g. 15 = 15% cheaper)
 *       - fixedPricePerKgByZone: fixed NGN/kg per zone e.g. {"1": 150, "2": 120, "3": 100, "4": 90}
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId: { type: string, format: uuid, description: "The enterprise client's user ID" }
 *               label: { type: string, example: "Dangote Group — Annual Contract" }
 *               serviceType: { type: string, enum: [EXPRESS, STANDARD, ECONOMY], nullable: true, description: "null = applies to all" }
 *               discountPercent: { type: number, example: 15, description: "15% off standard rate. Provide this OR fixedPricePerKgByZone" }
 *               fixedPricePerKgByZone:
 *                 type: object
 *                 example: { "1": 150, "2": 120, "3": 100, "4": 90 }
 *                 description: "Fixed NGN price per kg for each zone. Provide this OR discountPercent"
 *               isActive: { type: boolean, default: true }
 *               validFrom: { type: string, format: date-time }
 *               validUntil: { type: string, format: date-time, description: "null = no expiry" }
 *               notes: { type: string }
 *     responses:
 *       201:
 *         description: Contract rate assigned
 *       400:
 *         description: Provide either discountPercent or fixedPricePerKgByZone, not both
 *       404:
 *         description: User not found
 */
router.post('/', c.createContractRate);

/**
 * @swagger
 * /contract-rates:
 *   get:
 *     summary: List all contract rates (Admin)
 *     tags: [Contract Rates]
 *     parameters:
 *       - in: query
 *         name: isActive
 *         schema: { type: boolean }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search by label, user email, or user name
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *     responses:
 *       200:
 *         description: Contract rates list returned
 */
router.get('/', c.listContractRates);

/**
 * @swagger
 * /contract-rates/{id}:
 *   get:
 *     summary: Get contract rate by ID (Admin)
 *     tags: [Contract Rates]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Contract rate returned
 *       404:
 *         description: Not found
 */
router.get('/:id', c.getContractRate);

/**
 * @swagger
 * /contract-rates/{id}:
 *   patch:
 *     summary: Update contract rate (Admin)
 *     tags: [Contract Rates]
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
 *               discountPercent: { type: number }
 *               fixedPricePerKgByZone: { type: object }
 *               isActive: { type: boolean }
 *               validUntil: { type: string, format: date-time }
 *               notes: { type: string }
 *     responses:
 *       200:
 *         description: Updated
 */
router.patch('/:id', c.updateContractRate);

/**
 * @swagger
 * /contract-rates/{id}:
 *   delete:
 *     summary: Deactivate contract rate (Admin)
 *     tags: [Contract Rates]
 *     description: Soft-deactivates the rate card (isActive = false). History is preserved.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Deactivated
 */
router.delete('/:id', requireSuperAdmin, c.deleteContractRate);

module.exports = router;
