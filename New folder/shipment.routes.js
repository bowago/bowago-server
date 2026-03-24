const router = require("express").Router();
const shipmentController = require("../controllers/shipment.controller");
const {
  authenticate,
  requireAdmin,
  requireLogisticsOrAbove,
} = require("../middleware/auth");
const {
  downloadShippingLabel,
  downloadBookingConfirmation,
} = require("../controllers/invoice.controller");

/**
 * @swagger
 * tags:
 *   name: Shipments
 *   description: Create, track, and manage shipments. Public tracking available without authentication.
 */

// ─── PUBLIC ───────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /shipments/track/{trackingNumber}:
 *   get:
 *     summary: Track a shipment publicly (no auth)
 *     tags: [Shipments]
 *     security: []
 *     description: >
 *       Returns the current status and full tracking history for a shipment.
 *       No authentication required — safe for share links, public tracking pages,
 *       and WhatsApp share buttons.
 *       Sensitive info (full street addresses) is masked — only city/state is returned
 *       for unauthenticated callers.
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
 *                         trackingNumber: { type: string, example: "BG-20260311-XYZ12" }
 *                         status: { type: string, example: IN_TRANSIT }
 *                         senderCity: { type: string, example: "Lagos Cit" }
 *                         senderState: { type: string, example: Lagos }
 *                         recipientCity: { type: string, example: Aba }
 *                         recipientState: { type: string, example: Abia }
 *                         estimatedDelivery: { type: string, format: date-time, nullable: true }
 *                         deliveredAt: { type: string, format: date-time, nullable: true }
 *                         trackingHistory:
 *                           type: array
 *                           items:
 *                             $ref: '#/components/schemas/TrackingEvent'
 *       404:
 *         description: Tracking number not found
 */
router.get("/track/:trackingNumber", shipmentController.trackShipment);

// ─── All routes below require authentication ──────────────────────────────────
router.use(authenticate);

// ─── CUSTOMER: Create shipment ────────────────────────────────────────────────

/**
 * @swagger
 * /shipments:
 *   post:
 *     summary: Create a new shipment
 *     tags: [Shipments]
 *     description: >
 *       Books a new shipment. Automatically calculates the shipping cost using the zone
 *       matrix and weight. Applies fragile (+10%) and insurance surcharges if requested.
 *       If the booking is placed after 2:00 PM WAT, cutoffWarning is set to true and the
 *       earliest pickup is moved to the next business day automatically.
 *       Provide one of weightKg, tons, or cartons.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - senderName
 *               - senderPhone
 *               - senderAddress
 *               - senderCity
 *               - senderState
 *               - recipientName
 *               - recipientPhone
 *               - recipientAddress
 *               - recipientCity
 *               - recipientState
 *             properties:
 *               senderName: { type: string, example: "Emeka Obi" }
 *               senderPhone: { type: string, example: "08011111111" }
 *               senderAddress: { type: string, example: "10 Awolowo Road, Victoria Island" }
 *               senderCity:
 *                 type: string
 *                 example: "Lagos Cit"
 *                 description: Must exactly match a city name from GET /pricing/cities
 *               senderState: { type: string, example: Lagos }
 *               recipientName: { type: string, example: "Chidi Nwosu" }
 *               recipientPhone: { type: string, example: "08022222222" }
 *               recipientAddress: { type: string, example: "5 Ekwulobia Road" }
 *               recipientCity:
 *                 type: string
 *                 example: Aba
 *                 description: Must exactly match a city name from GET /pricing/cities
 *               recipientState: { type: string, example: Abia }
 *               description: { type: string, example: "Electronics and accessories" }
 *               weightKg:
 *                 type: number
 *                 example: 150
 *                 description: Weight in KG. Provide one of weightKg, tons, or cartons.
 *               tons: { type: number, example: 0.15 }
 *               cartons: { type: integer, example: 5 }
 *               boxDimensionId:
 *                 type: string
 *                 format: uuid
 *                 description: Optional — uses the box weightKgLimit as weight. Get IDs from GET /pricing/dimensions
 *               serviceType:
 *                 type: string
 *                 enum: [EXPRESS, STANDARD, ECONOMY]
 *                 default: STANDARD
 *               isFragile:
 *                 type: boolean
 *                 example: false
 *                 description: Adds 10% surcharge to base price
 *               requiresInsurance: { type: boolean, example: false }
 *               insuranceValue:
 *                 type: number
 *                 example: 500000
 *                 description: Declared value in NGN — adds 2% insurance surcharge
 *               pickupDate:
 *                 type: string
 *                 format: date-time
 *                 example: "2026-03-20T08:00:00Z"
 *                 description: If omitted and booking is after 2PM WAT, auto-set to next business day
 *               notes: { type: string, example: "Handle with care — glass items inside" }
 *     responses:
 *       201:
 *         description: Shipment created. Returns tracking number, quoted price, and full surcharge breakdown.
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
 *                             cutoffWarning:
 *                               type: boolean
 *                               example: false
 *                               description: true if booked after 2PM — show warning to user
 *                     quote:
 *                       $ref: '#/components/schemas/ShippingQuote'
 *       400:
 *         description: City not found, no pricing for route, or missing weight
 *       401:
 *         description: Unauthorized
 */
router.post("/", shipmentController.createShipment);

/**
 * @swagger
 * /shipments/my:
 *   get:
 *     summary: Get my shipment history
 *     tags: [Shipments]
 *     description: >
 *       Paginated list of the authenticated customer's shipments.
 *       The most recent tracking event is included for each shipment.
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
 *           enum: [PENDING, CONFIRMED, PICKED_UP, IN_TRANSIT, OUT_FOR_DELIVERY, DELIVERED, FAILED, CANCELLED, RETURNED, PENDING_ADMIN_REVIEW]
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
router.get("/my", shipmentController.listMyShipments);

// ─── NAMED ROUTES — must all come BEFORE /:id ─────────────────────────────────
// Express matches routes top-to-bottom. /:id would swallow /my, /admin/stats,
// /:id/label, /:id/confirmation etc. if placed earlier.

/**
 * @swagger
 * /shipments/admin/stats:
 *   get:
 *     summary: Shipment statistics overview (Admin)
 *     tags: [Shipments]
 *     description: >
 *       Returns total shipment counts broken down by status, plus total revenue
 *       from paid shipments. Use this to populate the admin dashboard summary cards.
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
router.get(
  "/admin/stats",
  requireLogisticsOrAbove,
  shipmentController.getShipmentStats,
);

// ─── PDF DOCUMENT ROUTES (/:id/label and /:id/confirmation) ──────────────────

/**
 * @swagger
 * /shipments/{id}/label:
 *   get:
 *     summary: Download shipping label PDF
 *     tags: [Shipments]
 *     description: >
 *       Generates and streams a branded 4×6 inch shipping label as a PDF file download.
 *       Contents include: tracking number (large, prominent), sender and recipient full
 *       addresses, zone badge, service type badge (EXPRESS/STANDARD/ECONOMY), weight,
 *       fragile warning strip (orange, shown only if isFragile = true), and special notes.
 *       Customers can only download labels for their own shipments.
 *       Admins can download any label.
 *       Print and attach to the package before the driver arrives for pickup.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Shipment ID
 *     responses:
 *       200:
 *         description: Shipping label PDF streamed as file download
 *         headers:
 *           Content-Disposition:
 *             description: Attachment filename with tracking number
 *             schema: { type: string, example: 'attachment; filename="BowaGO-Label-BG-20260311-XYZ12.pdf"' }
 *           Content-Type:
 *             schema: { type: string, example: application/pdf }
 *         content:
 *           application/pdf:
 *             schema: { type: string, format: binary }
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Access denied — not your shipment
 *       404:
 *         description: Shipment not found
 */
router.get("/:id/label", downloadShippingLabel);

/**
 * @swagger
 * /shipments/{id}/confirmation:
 *   get:
 *     summary: Download booking confirmation PDF
 *     tags: [Shipments]
 *     description: >
 *       Generates and streams the booking confirmation document as a PDF file download.
 *       Contents include: prominently displayed tracking number with shareable URL,
 *       sender and recipient details, full pricing breakdown (base price + each surcharge
 *       as a separate line item), pickup date, estimated delivery date, next steps
 *       (packaging guide link, payment reminder), and a cut-off warning banner if the
 *       booking was placed after 2:00 PM WAT.
 *       This PDF is also automatically emailed with the shipping label immediately after
 *       Paystack confirms the payment. This endpoint is available for manual re-download.
 *       Customers can only access their own shipment confirmations.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Shipment ID
 *     responses:
 *       200:
 *         description: Booking confirmation PDF streamed as file download
 *         headers:
 *           Content-Disposition:
 *             description: Attachment filename with tracking number
 *             schema: { type: string, example: 'attachment; filename="BowaGO-Confirmation-BG-20260311-XYZ12.pdf"' }
 *           Content-Type:
 *             schema: { type: string, example: application/pdf }
 *         content:
 *           application/pdf:
 *             schema: { type: string, format: binary }
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Access denied — not your shipment
 *       404:
 *         description: Shipment not found
 */
router.get("/:id/confirmation", downloadBookingConfirmation);

// ─── DYNAMIC /:id ROUTES — after all specific named routes ───────────────────

/**
 * @swagger
 * /shipments/{id}:
 *   get:
 *     summary: Get a single shipment with full detail
 *     tags: [Shipments]
 *     description: >
 *       Returns complete shipment details including the full tracking history timeline,
 *       attached documents (waybills, invoices, proof of delivery), customer info,
 *       and assigned staff member. Customers can only view their own shipments.
 *       The id parameter accepts either a UUID or a tracking number string.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Shipment UUID or tracking number (e.g. BG-20260311-XYZ12)
 *     responses:
 *       200:
 *         description: Full shipment detail returned
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
 *                                   createdAt: { type: string, format: date-time }
 *                             customer:
 *                               type: object
 *                               properties:
 *                                 id: { type: string }
 *                                 firstName: { type: string }
 *                                 lastName: { type: string }
 *                                 email: { type: string }
 *                                 phone: { type: string }
 *                             assignedTo:
 *                               type: object
 *                               nullable: true
 *                               properties:
 *                                 id: { type: string }
 *                                 firstName: { type: string }
 *                                 lastName: { type: string }
 *       404:
 *         description: Shipment not found
 *       403:
 *         description: Access denied — not your shipment
 *       401:
 *         description: Unauthorized
 */
router.get("/:id", shipmentController.getShipment);

/**
 * @swagger
 * /shipments/{id}/cancel:
 *   post:
 *     summary: Cancel a shipment
 *     tags: [Shipments]
 *     description: >
 *       Cancels a shipment. Only allowed while status is PENDING or CONFIRMED.
 *       Once picked up, cancellation is blocked.
 *       If the shipment has already been paid, a refund is automatically initiated
 *       via Paystack and the customer is notified.
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
 *               reason: { type: string, example: "Changed delivery address" }
 *     responses:
 *       200:
 *         description: Shipment cancelled successfully
 *       400:
 *         description: Cannot cancel — shipment is already in transit or beyond
 *       404:
 *         description: Shipment not found
 *       401:
 *         description: Unauthorized
 */
router.post("/:id/cancel", shipmentController.cancelShipment);

/**
 * @swagger
 * /shipments/{id}/status:
 *   patch:
 *     summary: Update shipment tracking status (Admin)
 *     tags: [Shipments]
 *     description: >
 *       Updates the shipment status and appends a new event to the tracking history
 *       timeline. Automatically sends an email notification and creates an in-app
 *       notification for the customer.
 *       Status flow: PENDING → CONFIRMED → PICKED_UP → IN_TRANSIT → OUT_FOR_DELIVERY → DELIVERED.
 *       Setting status to DELIVERED also marks paymentStatus as PAID and records deliveredAt.
 *       Include lat/lng coordinates for map-based tracking (Sprint 4).
 *       Include proofUrl (Cloudinary URL of a delivery photo) when setting DELIVERED.
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
 *                 description: Current physical location of the package
 *               description:
 *                 type: string
 *                 example: "Package arrived at sorting facility"
 *                 description: Status message shown in the tracking timeline
 *               lat:
 *                 type: number
 *                 example: 6.8385
 *                 description: GPS latitude for map tracking (Sprint 4)
 *               lng:
 *                 type: number
 *                 example: 3.6332
 *                 description: GPS longitude for map tracking (Sprint 4)
 *               proofUrl:
 *                 type: string
 *                 description: Cloudinary URL of proof-of-delivery photo (use with DELIVERED status)
 *               estimatedDelivery:
 *                 type: string
 *                 format: date-time
 *                 description: Updated estimated delivery date
 *     responses:
 *       200:
 *         description: Status updated, tracking event appended, customer notified
 *       404:
 *         description: Shipment not found
 *       403:
 *         description: Admin access required
 *       401:
 *         description: Unauthorized
 */
router.patch(
  "/:id/status",
  requireLogisticsOrAbove,
  shipmentController.updateShipmentStatus,
);

/**
 * @swagger
 * /shipments/{id}/assign:
 *   patch:
 *     summary: Assign a shipment to a staff member (Admin)
 *     tags: [Shipments]
 *     description: >
 *       Assigns the shipment to a logistics staff member or admin user who will be
 *       responsible for updating the tracking status.
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
 *                 description: ID of the admin or logistics staff member to assign
 *     responses:
 *       200:
 *         description: Shipment assigned successfully
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
 *                         id: { type: string }
 *                         trackingNumber: { type: string }
 *                         assignedTo:
 *                           type: object
 *                           properties:
 *                             id: { type: string }
 *                             firstName: { type: string }
 *                             lastName: { type: string }
 *       404:
 *         description: Shipment not found
 *       403:
 *         description: Admin access required
 */
router.patch(
  "/:id/assign",
  requireLogisticsOrAbove,
  shipmentController.assignShipment,
);

// ─── ADMIN: List all shipments ────────────────────────────────────────────────

/**
 * @swagger
 * /shipments:
 *   get:
 *     summary: List all shipments (Admin)
 *     tags: [Shipments]
 *     description: >
 *       Admin-only paginated list of all shipments across all customers.
 *       Supports filtering by status, assigned staff, date range, and free-text search.
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
 *           enum: [PENDING, CONFIRMED, PICKED_UP, IN_TRANSIT, OUT_FOR_DELIVERY, DELIVERED, FAILED, CANCELLED, RETURNED, PENDING_ADMIN_REVIEW]
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
 *         description: All shipments returned with pagination
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
 *       401:
 *         description: Unauthorized
 */
router.get("/", requireLogisticsOrAbove, shipmentController.adminListShipments);

module.exports = router;
