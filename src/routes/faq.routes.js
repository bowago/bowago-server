// ─── faq.routes.js ───────────────────────────────────────────────────────────
const faqRouter = require('express').Router();
const faqController = require('../controllers/faq.controller');
const { authenticate, requireLogisticsOrAbove } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: FAQ
 *   description: Sprint 5 — Searchable knowledge base and packaging guidelines
 */

/**
 * @swagger
 * /faq:
 *   get:
 *     summary: List FAQ items
 *     tags: [FAQ]
 *     security: []
 *     description: Returns all active FAQ items, grouped by category. Supports free-text search.
 *     parameters:
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *           enum: [PRICING, SHIPPING_RULES, TRACKING, PAYMENTS, ACCOUNT, PACKAGING, CLAIMS]
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Full-text search across question and answer content
 *         example: "customs clearance"
 *     responses:
 *       200:
 *         description: FAQ items returned, grouped by category
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     faqs:
 *                       type: array
 *                     grouped:
 *                       type: object
 *                       description: Same items grouped by category key
 */
faqRouter.get('/', faqController.listFaqs);

faqRouter.use(authenticate, requireLogisticsOrAbove);

/**
 * @swagger
 * /faq:
 *   post:
 *     summary: Create FAQ item (Admin)
 *     tags: [FAQ]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [question, answer]
 *             properties:
 *               question: { type: string, example: "How is my shipping cost calculated?" }
 *               answer: { type: string, example: "Your shipping cost is determined by the zone between origin and destination cities, and the weight of your package..." }
 *               category: { type: string, enum: [PRICING, SHIPPING_RULES, TRACKING, PAYMENTS, ACCOUNT, PACKAGING, CLAIMS] }
 *               sortOrder: { type: integer, default: 0, description: "Controls display order within category" }
 *     responses:
 *       201:
 *         description: FAQ item created
 */
faqRouter.post('/', faqController.createFaq);

/**
 * @swagger
 * /faq/{id}:
 *   patch:
 *     summary: Update FAQ item (Admin)
 *     tags: [FAQ]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: FAQ updated
 */
faqRouter.patch('/:id', faqController.updateFaq);

/**
 * @swagger
 * /faq/{id}:
 *   delete:
 *     summary: Delete FAQ item (Admin)
 *     tags: [FAQ]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: FAQ deleted
 */
faqRouter.delete('/:id', faqController.deleteFaq);

module.exports = faqRouter;
