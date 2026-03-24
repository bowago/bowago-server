const router = require('express').Router();
const policyController = require('../controllers/policy.controller');
const { authenticate, requireLogisticsOrAbove } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Policies & Guides
 *   description: "Sprint 2 Story 9.4 - T&C, refund and pricing policies at payment and quote. Sprint 5 Story 11.5 - Packaging guide from booking confirmation."
 */

// ─── POLICIES ─────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /policies:
 *   get:
 *     summary: List all active policy keys and titles
 *     tags: [Policies & Guides]
 *     security: []
 *     description: Returns all policy metadata (key + title only, not body). Use to build a policies menu.
 *     responses:
 *       200:
 *         description: Policy list returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     policies:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           key: { type: string, example: terms_of_service }
 *                           title: { type: string, example: "Terms of Service" }
 *                           updatedAt: { type: string, format: date-time }
 */
router.get('/', policyController.listPolicies);

/**
 * @swagger
 * /policies/{key}:
 *   get:
 *     summary: Get full policy content by key
 *     tags: [Policies & Guides]
 *     security: []
 *     description: >
 *       Fetches full policy body (Markdown or HTML) by key.
 *       Standard keys: terms_of_service | refund_policy | pricing_policy | liability | privacy_policy
 *       Show this at the point of quote generation and at the payment checkout screen (Story 9.4).
 *     parameters:
 *       - in: path
 *         name: key
 *         required: true
 *         schema: { type: string }
 *         examples:
 *           terms: { value: terms_of_service, summary: Terms of Service }
 *           refund: { value: refund_policy, summary: Refund Policy }
 *           pricing: { value: pricing_policy, summary: Pricing Policy }
 *           liability: { value: liability, summary: Liability Statement }
 *     responses:
 *       200:
 *         description: Policy content returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     policy:
 *                       type: object
 *                       properties:
 *                         key: { type: string }
 *                         title: { type: string }
 *                         body: { type: string, description: "Markdown or HTML content" }
 *                         updatedAt: { type: string, format: date-time }
 *       404:
 *         description: Policy not found
 */
router.get('/:key', policyController.getPolicy);

// ─── Admin policy management ──────────────────────────────────────────────────
router.use(authenticate, requireLogisticsOrAbove);

/**
 * @swagger
 * /policies:
 *   post:
 *     summary: Create or update a policy (Admin)
 *     tags: [Policies & Guides]
 *     description: >
 *       Upserts a policy by key. Use the same key to update existing content.
 *       Recommended keys: terms_of_service, refund_policy, pricing_policy, liability, privacy_policy
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [key, title, body]
 *             properties:
 *               key: { type: string, example: terms_of_service }
 *               title: { type: string, example: "Terms of Service" }
 *               body: { type: string, description: "Markdown or HTML. Rendered on frontend." }
 *               isActive: { type: boolean, default: true }
 *     responses:
 *       201:
 *         description: Policy saved
 */
router.post('/', policyController.upsertPolicy);

/**
 * @swagger
 * /policies/{key}:
 *   delete:
 *     summary: Deactivate a policy (Admin)
 *     tags: [Policies & Guides]
 *     parameters:
 *       - in: path
 *         name: key
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Policy deactivated
 */
router.delete('/:key', policyController.deletePolicy);

// ─── PACKAGING GUIDES ─────────────────────────────────────────────────────────

/**
 * @swagger
 * /packaging-guides:
 *   get:
 *     summary: List packaging guides
 *     tags: [Policies & Guides]
 *     security: []
 *     description: >
 *       Returns all active packaging guides grouped by category.
 *       Story 11.5: Accessible within two clicks from booking confirmation page.
 *       Categories: GENERAL | FRAGILE | DANGEROUS_GOODS | ELECTRONICS | CLOTHING
 *       Dangerous goods rules are also returned separately in the dangerousGoods array.
 *     parameters:
 *       - in: query
 *         name: category
 *         schema: { type: string, enum: [GENERAL, FRAGILE, DANGEROUS_GOODS, ELECTRONICS, CLOTHING] }
 *     responses:
 *       200:
 *         description: Packaging guides returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     guides: { type: array }
 *                     grouped:
 *                       type: object
 *                       description: "{ GENERAL: [...], FRAGILE: [...], DANGEROUS_GOODS: [...] }"
 *                     dangerousGoods:
 *                       type: array
 *                       description: Items where isDangerous = true (warehouse rejection rules)
 */
router.get('/packaging-guides', policyController.listPackagingGuides);

/**
 * @swagger
 * /packaging-guides/{id}:
 *   get:
 *     summary: Get a single packaging guide
 *     tags: [Policies & Guides]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Guide returned
 *       404:
 *         description: Not found
 */
router.get('/packaging-guides/:id', policyController.getPackagingGuide);

/**
 * @swagger
 * /packaging-guides:
 *   post:
 *     summary: Create packaging guide (Admin)
 *     tags: [Policies & Guides]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, body, category]
 *             properties:
 *               title: { type: string, example: "How to Pack Fragile Items" }
 *               body: { type: string, description: "Markdown content with packaging instructions" }
 *               category: { type: string, enum: [GENERAL, FRAGILE, DANGEROUS_GOODS, ELECTRONICS, CLOTHING] }
 *               imageUrl: { type: string, description: "Cloudinary URL for illustration image" }
 *               sortOrder: { type: integer, default: 0 }
 *               isDangerous: { type: boolean, default: false, description: "Tag as dangerous goods rule" }
 *     responses:
 *       201:
 *         description: Guide created
 */
router.post('/packaging-guides', policyController.createPackagingGuide);

/**
 * @swagger
 * /packaging-guides/{id}:
 *   patch:
 *     summary: Update packaging guide (Admin)
 *     tags: [Policies & Guides]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Updated
 */
router.patch('/packaging-guides/:id', policyController.updatePackagingGuide);

/**
 * @swagger
 * /packaging-guides/{id}:
 *   delete:
 *     summary: Delete packaging guide (Admin)
 *     tags: [Policies & Guides]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Deleted
 */
router.delete('/packaging-guides/:id', policyController.deletePackagingGuide);

module.exports = router;
