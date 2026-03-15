const router = require('express').Router();
const shipmentController = require('../controllers/shipment.controller');
const { authenticate, requireAdmin, requireLogisticsOrAbove } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Shipments
 *   description: Create, track, and manage shipments. Public tracking available without authentication.
 */

/**
 * @swagger
 * /shipments/track/{trackingNumber}:
 *   get:
 *     summary: Track a shipment (public)
 *     tags: [Shipments]
 *     security: []
 *     description: Returns the current status and full tracking history for a shipment. No authentication required — safe for share links and public tracking pages.
 *     parameters:
 *       - in: path
 *         name: trackingNumber
 *         required: true
 *         schema: { type: string }
 *         example: BG-20260311-XYZ12
 *         description: Shipment tracking number
 *     responses:
 *       200:
 *         description: Tracking data returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     shipment:
 *                       type: object
 *                       properties:
 *                         trackingNumber: { type: string, example: BG-20260311-XYZ12 }
 *                         status: { type: string, example: IN_TRANSIT }
 *                         senderCity: { type: string, example: "Lagos Cit" }
 *                         recipientCity: { type: string, example: Aba }
 *                         estimatedDelivery: { type: string, format: date-time }
 *                         trackingHistory:
 *                           type: array
 *                           items:
 *                             $ref: '#/components/schemas/TrackingEvent'
 *       404:
 *         description: Tracking number not found
 */
router.get('/track/:trackingNumber', shipmentController.trackShipment);

router.use(authenticate);

/**
 * @swagger
 * /shipments:
 *   post:
 *     summary: Create a new shipment
 *     tags: [Shipments]
 *     description: Books a new shipment. The shipping cost is automatically calculated using the zone matrix and weight. Provide one of weightKg, tons, or cartons.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [senderName, senderPhone, senderAddress, senderCity, senderState, recipientName, recipientPhone, recipientAddress, recipientCity, recipientState]
 *             properties:
 *               senderName: { type: string, example: "Emeka Obi" }
 *               senderPhone: { type: string, example: "08011111111" }
 *               senderAddress: { type: string, example: "10 Awolowo Road" }
 *               senderCity: { type: string, example: "Lagos Cit", description: "Must match a city from GET /pricing/cities" }
 *               senderState: { type: string, example: Lagos }
 *               recipientName: { type: string, example: "Chidi Nwosu" }
 *               recipientPhone: { type: string, example: "08022222222" }
 *               recipientAddress: { type: string, example: "5 Ekwulobia Road" }
 *               recipientCity: { type: string, example: Aba, description: "Must match a city from GET /pricing/cities" }
 *               recipientState: { type: string, example: Abia }
 *               description: { type: string, example: "Electronics and accessories" }
 *               weightKg: { type: number, example: 150, description: "Weight in KG — provide one of: weightKg, tons, or cartons" }
 *               cartons: { type: integer, example: 5 }
 *               boxDimensionId: { type: string, format: uuid, description: "Optional — ID from GET /pricing/dimensions" }
 *               isFragile: { type: boolean, example: false, description: "Adds 10% surcharge" }
 *               requiresInsurance: { type: boolean, example: false }
 *               insuranceValue: { type: number, example: 500000, description: "Declared value in NGN (adds 2% surcharge)" }
 *               pickupDate: { type: string, format: date-time, example: "2026-03-20T08:00:00Z" }
 *               notes: { type: string, example: "Handle with care" }
 *     responses:
 *       201:
 *         description: Shipment created successfully with tracking number and quoted price
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     shipment:
 *                       $ref: '#/components/schemas/Shipment'
 *                     quote:
 *                       $ref: '#/components/schemas/ShippingQuote'
 *       400:
 *         description: City not found in zone matrix or invalid weight
 *       401:
 *         description: Unauthorized
 */
router.post('/', shipmentController.createShipment);

/**
 * @swagger
 * /shipments/my:
 *   get:
 *     summary: Get my shipment history
 *     tags: [Shipments]
 *     description: Returns a paginated list of the authenticated customer's shipments.
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [PENDING, CONFIRMED, PICKED_UP, IN_TRANSIT, OUT_FOR_DELIVERY, DELIVERED, FAILED, CANCELLED, RETURNED]
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search by tracking number, recipient name, or city
 *     responses:
 *       200:
 *         description: Shipment list returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     shipments:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Shipment'
 *                 meta:
 *                   $ref: '#/components/schemas/PaginationMeta'
 *       401:
 *         description: Unauthorized
 */
router.get('/my', shipmentController.listMyShipments);

/**
 * @swagger
 * /shipments/{id}:
 *   get:
 *     summary: Get a single shipment
 *     tags: [Shipments]
 *     description: Returns full shipment details including tracking history and documents. Customers can only view their own shipments. Admins can view any.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Shipment ID or tracking number
 *     responses:
 *       200:
 *         description: Shipment details returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     shipment:
 *                       allOf:
 *                         - $ref: '#/components/schemas/Shipment'
 *                         - type: object
 *                           properties:
 *                             trackingHistory:
 *                               type: array
 *                               items:
 *                                 $ref: '#/components/schemas/TrackingEvent'
 *                             documents:
 *                               type: array
 *                               items:
 *                                 type: object
 *                                 properties:
 *                                   id: { type: string }
 *                                   type: { type: string, example: WAYBILL }
 *                                   url: { type: string }
 *       404:
 *         description: Shipment not found
 *       403:
 *         description: Access denied — not your shipment
 */
router.get('/:id', shipmentController.getShipment);

/**
 * @swagger
 * /shipments/{id}/cancel:
 *   post:
 *     summary: Cancel a shipment
 *     tags: [Shipments]
 *     description: Customer can cancel a shipment only while it is in PENDING or CONFIRMED status. Once picked up, cancellation is not possible.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Shipment ID
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason: { type: string, example: "Changed delivery address" }
 *     responses:
 *       200:
 *         description: Shipment cancelled
 *       400:
 *         description: Cannot cancel a shipment that is already in transit
 *       404:
 *         description: Shipment not found
 *       401:
 *         description: Unauthorized
 */
router.post('/:id/cancel', shipmentController.cancelShipment);

/**
 * @swagger
 * /shipments:
 *   get:
 *     summary: List all shipments (Admin)
 *     tags: [Shipments]
 *     description: Admin-only. Returns all shipments with filtering, search, and date range options.
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [PENDING, CONFIRMED, PICKED_UP, IN_TRANSIT, OUT_FOR_DELIVERY, DELIVERED, FAILED, CANCELLED, RETURNED]
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search by tracking number, sender/recipient name, or city
 *       - in: query
 *         name: assignedTo
 *         schema: { type: string, format: uuid }
 *         description: Filter by assigned staff user ID
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
 *         description: All shipments returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     shipments:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Shipment'
 *                 meta:
 *                   $ref: '#/components/schemas/PaginationMeta'
 *       403:
 *         description: Admin access required
 */
router.get('/', requireLogisticsOrAbove, shipmentController.adminListShipments);

/**
 * @swagger
 * /shipments/admin/stats:
 *   get:
 *     summary: Shipment statistics overview (Admin)
 *     tags: [Shipments]
 *     description: Returns total counts by status and total revenue from paid shipments.
 *     responses:
 *       200:
 *         description: Stats returned
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
 *                         total: { type: integer, example: 240 }
 *                         pending: { type: integer, example: 18 }
 *                         inTransit: { type: integer, example: 45 }
 *                         delivered: { type: integer, example: 170 }
 *                         cancelled: { type: integer, example: 7 }
 *                     revenue:
 *                       type: object
 *                       properties:
 *                         total: { type: number, example: 4500000 }
 *                         currency: { type: string, example: NGN }
 *       403:
 *         description: Admin access required
 */
router.get('/admin/stats', requireLogisticsOrAbove, shipmentController.getShipmentStats);

/**
 * @swagger
 * /shipments/{id}/status:
 *   patch:
 *     summary: Update shipment tracking status (Admin)
 *     tags: [Shipments]
 *     description: Updates the shipment status and appends a tracking event. Sends an email notification to the customer automatically. Status flow — PENDING → CONFIRMED → PICKED_UP → IN_TRANSIT → OUT_FOR_DELIVERY → DELIVERED.
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
 *                 enum: [CONFIRMED, PICKED_UP, IN_TRANSIT, OUT_FOR_DELIVERY, DELIVERED, FAILED, CANCELLED, RETURNED]
 *                 example: IN_TRANSIT
 *               location:
 *                 type: string
 *                 example: "Sagamu Interchange Hub"
 *               description:
 *                 type: string
 *                 example: "Package arrived at sorting facility"
 *               lat: { type: number, example: 6.8385 }
 *               lng: { type: number, example: 3.6332 }
 *               proofUrl:
 *                 type: string
 *                 description: Cloudinary URL of delivery proof image
 *               estimatedDelivery:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Status updated and tracking event recorded
 *       404:
 *         description: Shipment not found
 *       403:
 *         description: Admin access required
 */
router.patch('/:id/status', requireLogisticsOrAbove, shipmentController.updateShipmentStatus);

/**
 * @swagger
 * /shipments/{id}/assign:
 *   patch:
 *     summary: Assign shipment to a staff member (Admin)
 *     tags: [Shipments]
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
 *             required: [userId]
 *             properties:
 *               userId:
 *                 type: string
 *                 format: uuid
 *                 description: ID of the admin/logistics staff to assign
 *     responses:
 *       200:
 *         description: Shipment assigned
 *       404:
 *         description: Shipment not found
 *       403:
 *         description: Admin access required
 */
router.patch('/:id/assign', requireLogisticsOrAbove, shipmentController.assignShipment);

module.exports = router;
