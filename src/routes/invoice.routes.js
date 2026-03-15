const router = require('express').Router();
const invoiceController = require('../controllers/invoice.controller');
const { authenticate, requireLogisticsOrAbove } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Invoices
 *   description: Sprint 3 — Invoice management, PDF downloads, shipping labels, and financial overview
 */

router.use(authenticate);

/**
 * @swagger
 * /invoices/my:
 *   get:
 *     summary: My invoice history
 *     tags: [Invoices]
 *     description: >
 *       Returns all payment/invoice records for the authenticated customer, with linked
 *       shipment details. Each invoice has a direct link to the related shipment tracking page.
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
 *         description: Filter by payment status
 *     responses:
 *       200:
 *         description: Invoice list returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     invoices:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           invoiceNumber: { type: string, example: "INV-2603-00123" }
 *                           paymentId: { type: string, format: uuid }
 *                           reference: { type: string, example: "BWG-A1B2C3D4E5F6G7H8" }
 *                           amount: { type: number, example: 27000 }
 *                           currency: { type: string, example: NGN }
 *                           status: { type: string, enum: [PENDING, PAID, FAILED, REFUNDED] }
 *                           paidAt: { type: string, format: date-time }
 *                           shipment:
 *                             type: object
 *                             properties:
 *                               trackingNumber: { type: string }
 *                               senderCity: { type: string }
 *                               recipientCity: { type: string }
 *                               status: { type: string }
 *                 meta:
 *                   $ref: '#/components/schemas/PaginationMeta'
 *       401:
 *         description: Unauthorized
 */
router.get('/my', invoiceController.myInvoices);

/**
 * @swagger
 * /invoices/financial-overview:
 *   get:
 *     summary: Financial overview (Admin)
 *     tags: [Invoices]
 *     description: >
 *       High-level financial summary: total revenue collected, pending invoices,
 *       refunded amounts, and the 10 most recent paid transactions.
 *       Supports date range filtering for period reports.
 *     parameters:
 *       - in: query
 *         name: fromDate
 *         schema: { type: string, format: date }
 *         example: "2026-03-01"
 *       - in: query
 *         name: toDate
 *         schema: { type: string, format: date }
 *         example: "2026-03-31"
 *     responses:
 *       200:
 *         description: Financial overview returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     summary:
 *                       type: object
 *                       properties:
 *                         totalRevenueNaira: { type: number, example: 4500000 }
 *                         paidInvoices: { type: integer, example: 340 }
 *                         pendingRevenueNaira: { type: number, example: 280000 }
 *                         pendingInvoices: { type: integer, example: 21 }
 *                         refundedNaira: { type: number, example: 50000 }
 *                         refundedCount: { type: integer, example: 4 }
 *                         currency: { type: string, example: NGN }
 *                     recentPayments:
 *                       type: array
 *                       items:
 *                         type: object
 *       403:
 *         description: Admin access required
 */
router.get('/financial-overview', requireLogisticsOrAbove, invoiceController.financialOverview);

/**
 * @swagger
 * /invoices/{paymentId}:
 *   get:
 *     summary: Get invoice detail
 *     tags: [Invoices]
 *     description: Returns full invoice data including surcharge breakdown. Customers can only view their own invoices.
 *     parameters:
 *       - in: path
 *         name: paymentId
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Payment ID (used as invoice ID)
 *     responses:
 *       200:
 *         description: Invoice returned
 *       403:
 *         description: Access denied
 *       404:
 *         description: Invoice not found
 */
router.get('/:paymentId', invoiceController.getInvoice);

/**
 * @swagger
 * /invoices/{paymentId}/download:
 *   get:
 *     summary: Download invoice as PDF
 *     tags: [Invoices]
 *     description: >
 *       Streams a branded PDF invoice directly to the browser as a file download.
 *       Includes full surcharge line items, payment status, and a reference to the tracking page.
 *       Use this for the "Download PDF" button in the My Invoices view.
 *     parameters:
 *       - in: path
 *         name: paymentId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: PDF streamed to browser
 *         content:
 *           application/pdf:
 *             schema:
 *               type: string
 *               format: binary
 *       403:
 *         description: Access denied
 *       404:
 *         description: Invoice not found
 */
router.get('/:paymentId/download', invoiceController.downloadInvoicePDF);

/**
 * @swagger
 * /invoices/{paymentId}/email:
 *   post:
 *     summary: Send invoice to customer's email
 *     tags: [Invoices]
 *     description: >
 *       Generates the invoice PDF and sends it to the customer's registered email address
 *       as an attachment, with a branded HTML email body.
 *     parameters:
 *       - in: path
 *         name: paymentId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Invoice emailed successfully
 *       403:
 *         description: Access denied
 *       404:
 *         description: Invoice not found
 */
router.post('/:paymentId/email', invoiceController.emailInvoice);

/**
 * @swagger
 * /shipments/{id}/label:
 *   get:
 *     summary: Download shipping label PDF
 *     tags: [Invoices]
 *     description: >
 *       Generates and streams a 4×6 inch branded shipping label for the specified shipment.
 *       Includes: tracking number, sender/recipient addresses, zone badge, service type,
 *       weight, and fragile warning if applicable.
 *       Print this and attach to the package before pickup.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Shipment ID
 *     responses:
 *       200:
 *         description: Shipping label PDF streamed
 *         content:
 *           application/pdf:
 *             schema:
 *               type: string
 *               format: binary
 *       403:
 *         description: Access denied
 *       404:
 *         description: Shipment not found
 */

/**
 * @swagger
 * /shipments/{id}/confirmation:
 *   get:
 *     summary: Download booking confirmation PDF
 *     tags: [Invoices]
 *     description: >
 *       Generates a branded booking confirmation PDF for the shipment.
 *       Includes: tracking number, full pricing breakdown, pickup/delivery dates,
 *       next steps, and a cut-off warning if the booking was placed after 2:00 PM.
 *       Sent automatically by email after payment — also available for manual download.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Shipment ID
 *     responses:
 *       200:
 *         description: Booking confirmation PDF streamed
 *         content:
 *           application/pdf:
 *             schema:
 *               type: string
 *               format: binary
 *       403:
 *         description: Access denied
 *       404:
 *         description: Shipment not found
 */

module.exports = router;
