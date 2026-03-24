const router = require('express').Router();
const paymentController = require('../controllers/payment.controller');
const { authenticate, requireLogisticsOrAbove } = require('../middleware/auth');

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
router.post('/:reference/refund', paymentController.refundHandler);

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
router.get('/', requireLogisticsOrAbove, paymentController.adminListPayments);

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
router.get('/stats', requireLogisticsOrAbove, paymentController.paymentStats);

module.exports = router;
