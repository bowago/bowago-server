const router = require('express').Router();
const paymentController = require('../controllers/payment.controller');
const { authenticate, requireLogisticsOrAbove, requireSuperAdmin, requireAdmin, requireInvoiceAccess } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Payments
 *   description: Paystack payment initialization, verification, webhooks, and refunds
 */

/**
 * @swagger
 * /payments/webhook:
 *   post:
 *     summary: Paystack webhook listener
 *     tags: [Payments]
 *     security: []
 *     description: >
 *       This endpoint is called automatically by Paystack after every transaction event.
 *       Do NOT call this manually. Configure this URL in your Paystack dashboard under
 *       Settings → API Keys & Webhooks.
 *       URL to set: https://your-domain.vercel.app/api/v1/payments/webhook
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               event:
 *                 type: string
 *                 example: charge.success
 *               data:
 *                 type: object
 *                 properties:
 *                   reference: { type: string }
 *                   amount: { type: integer, description: "Amount in Kobo" }
 *                   status: { type: string, example: success }
 *     responses:
 *       200:
 *         description: Webhook received (always returns 200 to prevent Paystack retries)
 */
router.post('/webhook', paymentController.webhook);

/**
 * @swagger
 * /payments/callback:
 *   get:
 *     summary: Paystack payment callback (browser redirect)
 *     tags: [Payments]
 *     security: []
 *     description: >
 *       Paystack redirects the user's browser to this URL after completing payment.
 *       It verifies the payment and redirects to the frontend success or failure page.
 *       Set callback_url in Paystack dashboard to this endpoint.
 *     parameters:
 *       - in: query
 *         name: reference
 *         required: true
 *         schema: { type: string }
 *         description: Payment reference from Paystack
 *     responses:
 *       302:
 *         description: Redirects to CLIENT_URL/payment/success or /payment/failed
 */
router.get('/callback', paymentController.paystackCallback);

// ─── Protected routes ─────────────────────────────────────────────────────────
router.use(authenticate);

/**
 * @swagger
 * /payments/initialize:
 *   post:
 *     summary: Initialize a Paystack payment for a shipment
 *     tags: [Payments]
 *     description: >
 *       Creates a payment record and returns a Paystack authorization URL.
 *       Redirect the user to authorizationUrl to complete payment on Paystack's hosted page.
 *       The amount is automatically taken from the shipment's quotedPrice.
 *       Idempotent — calling this twice for the same shipment reuses the reference.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [shipmentId]
 *             properties:
 *               shipmentId:
 *                 type: string
 *                 format: uuid
 *                 description: ID of the shipment to pay for
 *     responses:
 *       200:
 *         description: Payment initialized. Redirect user to authorizationUrl.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     reference:
 *                       type: string
 *                       example: BWG-A1B2C3D4E5F6G7H8
 *                       description: Your internal payment reference — save this
 *                     authorizationUrl:
 *                       type: string
 *                       example: https://checkout.paystack.com/abc123
 *                       description: Redirect user here to complete payment
 *                     accessCode:
 *                       type: string
 *                       description: Use with Paystack Inline JS instead of redirect
 *       400:
 *         description: Shipment already paid
 *       404:
 *         description: Shipment not found
 *       401:
 *         description: Unauthorized
 */
router.post('/initialize', paymentController.initPayment);

/**
 * @swagger
 * /payments/init-pending:
 *   post:
 *     summary: Create or reuse a PENDING payment record for invoice generation only
 *     tags: [Payments]
 *     description: >
 *       Creates a Payment row without calling Paystack — no authorization
 *       URL is returned. Used by "Generate Invoice Only" so a customer can
 *       download a proforma invoice before paying. If a payment record
 *       already exists for this shipment, it is reused.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [shipmentId]
 *             properties:
 *               shipmentId: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Payment record ready — use payment.id with /invoices/:paymentId/download
 *       404:
 *         description: Shipment not found
 */
router.post('/init-pending', paymentController.initPendingPayment);

/**
 * @swagger
 * /payments/verify/{reference}:
 *   get:
 *     summary: Verify a payment by reference
 *     tags: [Payments]
 *     description: >
 *       Call this after the user returns from the Paystack payment page to confirm the payment status.
 *       If successful, automatically marks the shipment as PAID and CONFIRMED.
 *       Safe to call multiple times — already-verified payments return cached result.
 *     parameters:
 *       - in: path
 *         name: reference
 *         required: true
 *         schema: { type: string }
 *         example: BWG-A1B2C3D4E5F6G7H8
 *         description: Payment reference returned from /payments/initialize
 *     responses:
 *       200:
 *         description: Payment verified
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     payment:
 *                       $ref: '#/components/schemas/Payment'
 *       404:
 *         description: Payment reference not found
 *       401:
 *         description: Unauthorized
 */
router.get('/verify/:reference', paymentController.verifyPaymentHandler);

/**
 * @swagger
 * /payments/my:
 *   get:
 *     summary: Get my payment history
 *     tags: [Payments]
 *     description: Returns paginated payment records for the authenticated user, with amounts converted from Kobo to Naira.
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Payment list returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     payments:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Payment'
 *                 meta:
 *                   $ref: '#/components/schemas/PaginationMeta'
 *       401:
 *         description: Unauthorized
 */
router.get('/my', paymentController.myPayments);

/**
 * @swagger
 * /payments/{reference}/refund:
 *   post:
 *     summary: Refund a payment
 *     tags: [Payments]
 *     description: >
 *       Initiates a refund via Paystack. Only PAID payments can be refunded.
 *       Admins can refund any payment. Customers can only refund their own.
 *       If amountNaira is not provided, the full amount is refunded.
 *       Refunds typically take 3-5 business days to reflect.
 *     parameters:
 *       - in: path
 *         name: reference
 *         required: true
 *         schema: { type: string }
 *         description: Payment reference to refund
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               amountNaira:
 *                 type: number
 *                 example: 5000
 *                 description: Amount to refund in Naira. If omitted, full amount is refunded.
 *     responses:
 *       200:
 *         description: Refund initiated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     payment:
 *                       $ref: '#/components/schemas/Payment'
 *       400:
 *         description: Payment is not in PAID status
 *       404:
 *         description: Payment not found
 *       403:
 *         description: Not authorized to refund this payment
 */
// Internal finance staff only. Customer/Enterprise refunds go through the
// shipment cancellation flow, which enforces the PRD refund-rules table.
router.post('/:reference/refund', requireInvoiceAccess, paymentController.refundHandler);

/**
 * @swagger
 * /payments:
 *   get:
 *     summary: List all payments (Admin)
 *     tags: [Payments]
 *     description: Paginated list of all payments across all users. Supports filtering by status and date range.
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [PENDING, PAID, FAILED, REFUNDED] }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search by payment reference or user email
 *       - in: query
 *         name: fromDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: toDate
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: All payments returned
 *       403:
 *         description: Admin access required
 */
router.get('/', requireInvoiceAccess, paymentController.adminListPayments); // PRD: ROLE_FINANCE / canManageInvoices

/**
 * @swagger
 * /payments/stats:
 *   get:
 *     summary: Payment statistics (Admin)
 *     tags: [Payments]
 *     description: Returns counts by payment status and total revenue in both Kobo and Naira.
 *     responses:
 *       200:
 *         description: Payment stats returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     stats:
 *                       type: object
 *                       properties:
 *                         totalPaid: { type: integer, example: 340 }
 *                         totalPending: { type: integer, example: 12 }
 *                         totalRefunded: { type: integer, example: 8 }
 *                     revenue:
 *                       type: object
 *                       properties:
 *                         kobo: { type: integer, example: 1250000000 }
 *                         naira: { type: number, example: 12500000 }
 *                         currency: { type: string, example: NGN }
 *       403:
 *         description: Admin access required
 */
router.get('/stats', requireInvoiceAccess, paymentController.paymentStats); // PRD: ROLE_FINANCE / canManageInvoices

/**
 * @swagger
 * /payments/webhooks/failed:
 *   get:
 *     summary: List failed webhook events (Dead Letter Queue) — Super Admin
 *     tags: [Payments]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [FAILED, RESOLVED, IGNORED] }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: List of failed webhook events
 */

/**
 * @swagger
 * /payments/{shipmentId}/mark-paid:
 *   post:
 *     summary: Manually mark a shipment as paid (Admin — for cash/bank transfer)
 *     tags: [Payments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shipmentId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               method: { type: string, enum: [cash, bank_transfer, pos, cheque], default: cash }
 *               reference: { type: string, description: Bank reference or receipt number }
 *               notes: { type: string }
 */
router.post('/:shipmentId/mark-paid', requireInvoiceAccess, paymentController.markAsPaid); // PRD: ROLE_FINANCE

/**
 * @swagger
 * /payments/{shipmentId}/waive:
 *   post:
 *     summary: Waive payment for a shipment (Super Admin only)
 *     tags: [Payments]
 *     security:
 *       - bearerAuth: []
 */
router.post('/:shipmentId/waive', requireSuperAdmin, paymentController.waivePayment);

router.get('/webhooks/failed', requireSuperAdmin, paymentController.listFailedWebhooks);

/**
 * @swagger
 * /payments/webhooks/failed/{id}/retry:
 *   post:
 *     summary: Re-process a failed webhook event — Super Admin
 *     tags: [Payments]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Webhook re-processed successfully
 *       400:
 *         description: Retry failed — see error message
 */
router.post('/webhooks/failed/:id/retry', requireSuperAdmin, paymentController.retryFailedWebhook);

/**
 * @swagger
 * /payments/webhooks/failed/{id}/dismiss:
 *   post:
 *     summary: Dismiss a failed webhook event without retrying — Super Admin
 *     tags: [Payments]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Webhook entry dismissed
 */
router.post('/webhooks/failed/:id/dismiss', requireSuperAdmin, paymentController.dismissFailedWebhook);


module.exports = router;
