const router = require('express').Router();
const supportController = require('../controllers/support.controller');
const { authenticate, requireAdmin, requireLogisticsOrAbove } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Support
 *   description: Sprint 6 — Customer support tickets, agent workspace, and canned responses
 */

router.use(authenticate);

/**
 * @swagger
 * /support/tickets:
 *   post:
 *     summary: Create a support ticket
 *     tags: [Support]
 *     description: >
 *       Customer opens a new support ticket. Tickets are auto-assigned to the appropriate
 *       agent based on category (PAYMENT → Finance agent, TRACKING → Ops agent, etc.).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [subject, body]
 *             properties:
 *               subject: { type: string, example: "Package not received after 7 days" }
 *               category:
 *                 type: string
 *                 enum: [TRACKING, PAYMENT, PRICING_DISPUTE, DAMAGED_GOODS, DELIVERY_ISSUE, ACCOUNT, OTHER]
 *                 default: OTHER
 *               shipmentId: { type: string, format: uuid, description: "Link to a specific shipment" }
 *               body: { type: string, example: "My tracking shows delivered but I never received the package." }
 *               priority: { type: string, enum: [LOW, NORMAL, HIGH, URGENT], default: NORMAL }
 *     responses:
 *       201:
 *         description: Ticket created and auto-assigned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     ticket:
 *                       type: object
 *                       properties:
 *                         ticketNumber: { type: string, example: "TKT-20260311-AB12" }
 *                         status: { type: string, example: OPEN }
 */
router.post('/tickets', supportController.createTicket);

/**
 * @swagger
 * /support/tickets/my:
 *   get:
 *     summary: My support tickets
 *     tags: [Support]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [OPEN, IN_PROGRESS, RESOLVED, CLOSED, ESCALATED] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *     responses:
 *       200:
 *         description: Customer's tickets returned
 */
router.get('/tickets/my', supportController.myTickets);

/**
 * @swagger
 * /support/tickets/{id}:
 *   get:
 *     summary: Get ticket with full message thread
 *     tags: [Support]
 *     description: >
 *       Returns the ticket and all messages. For admin users, also returns a customer
 *       context card with the last 5 shipments and payments for that customer.
 *       Internal agent notes (isInternal=true) are hidden from customers.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Ticket and thread returned. Admins also get customerContext.
 *       404:
 *         description: Ticket not found
 *       403:
 *         description: Access denied
 */
router.get('/tickets/:id', supportController.getTicket);

/**
 * @swagger
 * /support/tickets/{id}/reply:
 *   post:
 *     summary: Reply to a support ticket
 *     tags: [Support]
 *     description: >
 *       Both customers and agents can reply. Agents can mark messages as internal
 *       (isInternal: true) — these notes are NOT visible to the customer.
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
 *             required: [body]
 *             properties:
 *               body: { type: string, example: "We have escalated this to our delivery partner and will update you within 24 hours." }
 *               isInternal: { type: boolean, default: false, description: "Agents only — marks as internal note, hidden from customer" }
 *     responses:
 *       201:
 *         description: Reply sent. Other party notified.
 *       400:
 *         description: Cannot reply to a closed ticket
 */
router.post('/tickets/:id/reply', supportController.replyToTicket);

/**
 * @swagger
 * /support/tickets:
 *   get:
 *     summary: List all support tickets (Admin)
 *     tags: [Support]
 *     description: Admin inbox — all tickets with filtering by status, category, agent, and priority.
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [OPEN, IN_PROGRESS, RESOLVED, CLOSED, ESCALATED] }
 *       - in: query
 *         name: category
 *         schema: { type: string, enum: [TRACKING, PAYMENT, PRICING_DISPUTE, DAMAGED_GOODS, DELIVERY_ISSUE, ACCOUNT, OTHER] }
 *       - in: query
 *         name: assignedTo
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: priority
 *         schema: { type: string, enum: [LOW, NORMAL, HIGH, URGENT] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *     responses:
 *       200:
 *         description: All tickets returned
 *       403:
 *         description: Admin access required
 */
router.get('/tickets', requireLogisticsOrAbove, supportController.listTickets);

/**
 * @swagger
 * /support/tickets/{id}:
 *   patch:
 *     summary: Update ticket status, assignment, or priority (Admin)
 *     tags: [Support]
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
 *               status: { type: string, enum: [OPEN, IN_PROGRESS, RESOLVED, CLOSED, ESCALATED] }
 *               assignedToId: { type: string, format: uuid }
 *               priority: { type: string, enum: [LOW, NORMAL, HIGH, URGENT] }
 *     responses:
 *       200:
 *         description: Ticket updated. Customer notified on RESOLVED.
 */
router.patch('/tickets/:id', requireLogisticsOrAbove, supportController.updateTicket);

/**
 * @swagger
 * /support/canned-responses:
 *   get:
 *     summary: List canned responses (Agent template library)
 *     tags: [Support]
 *     description: Sprint 6 — Pre-approved response templates for agents to insert when replying.
 *     parameters:
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *         example: "Customs Delay"
 *     responses:
 *       200:
 *         description: Canned responses returned
 */
router.get('/canned-responses', requireLogisticsOrAbove, supportController.listCannedResponses);

/**
 * @swagger
 * /support/canned-responses:
 *   post:
 *     summary: Create a canned response (Admin)
 *     tags: [Support]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, body]
 *             properties:
 *               title: { type: string, example: "Customs Delay Explanation" }
 *               body: { type: string, example: "Dear Customer, your shipment is currently held at customs..." }
 *               category: { type: string, example: "Customs" }
 *     responses:
 *       201:
 *         description: Canned response created
 */
router.post('/canned-responses', requireLogisticsOrAbove, supportController.createCannedResponse);

/**
 * @swagger
 * /support/canned-responses/{id}:
 *   patch:
 *     summary: Update a canned response (Admin)
 *     tags: [Support]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Updated
 */
router.patch('/canned-responses/:id', requireLogisticsOrAbove, supportController.updateCannedResponse);

/**
 * @swagger
 * /support/canned-responses/{id}:
 *   delete:
 *     summary: Delete a canned response (Admin)
 *     tags: [Support]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Deleted
 */
router.delete('/canned-responses/:id', requireLogisticsOrAbove, supportController.deleteCannedResponse);

module.exports = router;
