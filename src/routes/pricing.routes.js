const router = require('express').Router();
const pricingController = require('../controllers/pricing.controller');
const deliverySLAController = require('../controllers/deliverySLA.controller');
const { authenticate, requireAdmin, requireLogisticsOrAbove, requireSuperAdmin, requireRateManagement } = require('../middleware/auth');
const { uploadImport } = require('../config/cloudinary');

/**
 * @swagger
 * tags:
 *   name: Pricing
 *   description: Shipping quotes, cities, box dimensions, price bands, zone matrix, and bulk Excel import
 */

/**
 * @swagger
 * /pricing/quote:
 *   post:
 *     summary: Calculate a shipping cost quote
 *     tags: [Pricing]
 *     security: []
 *     description: Calculates the shipping cost between two cities based on weight and the zone matrix. Provide one of weightKg, tons, or cartons.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fromCity, toCity]
 *             properties:
 *               fromCity:
 *                 type: string
 *                 example: "Lagos Cit"
 *                 description: Must match a city name from GET /pricing/cities
 *               toCity:
 *                 type: string
 *                 example: Aba
 *                 description: Must match a city name from GET /pricing/cities
 *               weightKg:
 *                 type: number
 *                 example: 150
 *                 description: Weight in kilograms
 *               tons:
 *                 type: number
 *                 example: 0.15
 *                 description: Weight in metric tons
 *               cartons:
 *                 type: integer
 *                 example: 5
 *                 description: Number of cartons
 *               boxDimensionId:
 *                 type: string
 *                 format: uuid
 *                 description: Optional — uses the box weightKgLimit as the weight
 *     responses:
 *       200:
 *         description: Quote calculated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     quote:
 *                       $ref: '#/components/schemas/ShippingQuote'
 *       400:
 *         description: City not found or no pricing data for route
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/quote', pricingController.getQuote);

/**
 * @swagger
 * /pricing/cities:
 *   get:
 *     summary: List all cities
 *     tags: [Pricing]
 *     security: []
 *     description: Returns all 39 supported Nigerian cities. Use to populate origin and destination dropdowns in the booking form.
 *     parameters:
 *       - in: query
 *         name: region
 *         schema: { type: string }
 *         example: "South West"
 *         description: Filter by geopolitical region
 *       - in: query
 *         name: state
 *         schema: { type: string }
 *         example: Lagos
 *         description: Filter by state
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search by city name
 *     responses:
 *       200:
 *         description: Cities list returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     cities:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/City'
 */
router.get('/cities', pricingController.listCities);

/**
 * @swagger
 * /pricing/dimensions:
 *   get:
 *     summary: List box dimension types
 *     tags: [Pricing]
 *     security: []
 *     description: Returns all standard box types with dimensions and weight limits. Use to populate the package type selector.
 *     responses:
 *       200:
 *         description: Box dimensions returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     dimensions:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/BoxDimension'
 */
router.get('/dimensions', pricingController.listDimensions);

/**
 * @swagger
 * /pricing/price-bands:
 *   get:
 *     summary: List price bands
 *     tags: [Pricing]
 *     security: []
 *     description: Returns the pricing tiers organized by zone and weight range.
 *     parameters:
 *       - in: query
 *         name: zone
 *         schema: { type: integer, enum: [1, 2, 3, 4] }
 *         description: Filter by zone number
 *     responses:
 *       200:
 *         description: Price bands returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     bands:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/PriceBand'
 */
router.get('/price-bands', pricingController.listPriceBands);

// ─── Admin routes below ───────────────────────────────────────────────────────
// PRD: only roles with canManageRates capability can write pricing data.
// SUPER_ADMIN and LOGISTICS_MANAGER bypass capability checks automatically.
router.use(authenticate);
router.use(requireRateManagement);

/**
 * @swagger
 * /pricing/cities:
 *   post:
 *     summary: Add or update a city (Admin)
 *     tags: [Pricing]
 *     description: Creates a new city or updates an existing one by name (upsert).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, region, state]
 *             properties:
 *               name: { type: string, example: "Onitsha" }
 *               region: { type: string, example: "South East" }
 *               state: { type: string, example: Anambra }
 *     responses:
 *       201:
 *         description: City saved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     city:
 *                       $ref: '#/components/schemas/City'
 *       403:
 *         description: Admin access required
 */
router.post('/cities', pricingController.upsertCity);

/**
 * @swagger
 * /pricing/cities/{id}:
 *   delete:
 *     summary: Delete a city (Super Admin)
 *     tags: [Pricing]
 *     description: Permanently deletes a city. This will also remove all related zone matrix and KM entries.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: City deleted
 *       403:
 *         description: Super admin access required
 */
router.patch('/cities/:id', requireSuperAdmin, pricingController.updateCity);
router.delete('/cities/:id', requireSuperAdmin, pricingController.deleteCity);

/**
 * @swagger
 * /pricing/dimensions:
 *   post:
 *     summary: Add or update a box dimension (Admin)
 *     tags: [Pricing]
 *     description: Creates or updates a box dimension type by categoryId (upsert).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [categoryId, displayName, lengthCm, widthCm, heightCm, weightKgLimit]
 *             properties:
 *               categoryId: { type: string, example: "XXL-11" }
 *               displayName: { type: string, example: "Extra Extra Large Box" }
 *               lengthCm: { type: number, example: 80 }
 *               widthCm: { type: number, example: 80 }
 *               heightCm: { type: number, example: 80 }
 *               bestFor: { type: string, example: "Large Appliances" }
 *               weightKgLimit: { type: number, example: 50 }
 *     responses:
 *       201:
 *         description: Box dimension saved
 *       403:
 *         description: Admin access required
 */
router.post('/dimensions', pricingController.upsertDimension);

/**
 * @swagger
 * /pricing/dimensions/{id}:
 *   delete:
 *     summary: Delete a box dimension (Admin)
 *     tags: [Pricing]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Dimension deleted
 *       403:
 *         description: Admin access required
 */
/**
 * @swagger
 * /pricing/dimensions/{id}:
 *   patch:
 *     summary: Update a box dimension (Super Admin)
 *     tags: [Pricing]
 *     security:
 *       - bearerAuth: []
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
 *               categoryId:    { type: string }
 *               displayName:   { type: string }
 *               lengthCm:      { type: number }
 *               widthCm:       { type: number }
 *               heightCm:      { type: number }
 *               bestFor:       { type: string }
 *               weightKgLimit: { type: number }
 *     responses:
 *       200:
 *         description: Box dimension updated
 *       403:
 *         description: Super Admin access required
 *       404:
 *         description: Box dimension not found
 *       409:
 *         description: Category ID already in use
 */
router.patch('/dimensions/:id', requireSuperAdmin, pricingController.updateDimension);

router.delete('/dimensions/:id', requireSuperAdmin, pricingController.deleteDimension);

/**
 * @swagger
 * /pricing/price-bands:
 *   post:
 *     summary: Create a price band (Admin)
 *     tags: [Pricing]
 *     description: Creates a new price band for a specific zone and weight range.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [zone, minKg, minTons, minCartons]
 *             properties:
 *               zone: { type: integer, enum: [1, 2, 3, 4], example: 2 }
 *               minKg: { type: number, example: 50 }
 *               maxKg: { type: number, example: 200, nullable: true, description: "null means no upper limit" }
 *               minTons: { type: number, example: 0.05 }
 *               maxTons: { type: number, example: 0.2, nullable: true }
 *               minCartons: { type: integer, example: 2 }
 *               maxCartons: { type: integer, example: 6, nullable: true }
 *               pricePerKg: { type: number, example: 180, description: "Used for per-KG pricing" }
 *               basePrice: { type: number, example: 9000, nullable: true, description: "Used for flat-rate pricing" }
 *     responses:
 *       201:
 *         description: Price band created
 *       403:
 *         description: Admin access required
 */
router.post('/price-bands', pricingController.createPriceBand);

/**
 * @swagger
 * /pricing/price-bands/{id}:
 *   put:
 *     summary: Update a price band (Admin)
 *     tags: [Pricing]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PriceBand'
 *     responses:
 *       200:
 *         description: Price band updated
 *       403:
 *         description: Admin access required
 */
router.put('/price-bands/:id', pricingController.updatePriceBand);

/**
 * @swagger
 * /pricing/price-bands/{id}:
 *   delete:
 *     summary: Delete a price band (Admin)
 *     tags: [Pricing]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Price band deleted
 *       403:
 *         description: Admin access required
 */
router.delete('/price-bands/:id', pricingController.deletePriceBand);

/**
 * @swagger
 * /pricing/zone-matrix:
 *   get:
 *     summary: Browse city-to-city zone matrix (Admin)
 *     tags: [Pricing]
 *     description: Paginated view of all city-pair zone assignments.
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: fromCity
 *         schema: { type: string }
 *         description: Filter by origin city name
 *       - in: query
 *         name: toCity
 *         schema: { type: string }
 *         description: Filter by destination city name
 *     responses:
 *       200:
 *         description: Zone matrix data returned
 *       403:
 *         description: Admin access required
 */
router.get('/zone-matrix', pricingController.getZoneMatrix);

/**
 * @swagger
 * /pricing/zone-matrix:
 *   post:
 *     summary: Manually update a zone pair (Admin)
 *     tags: [Pricing]
 *     description: Creates or updates the zone number for a specific city pair (upsert).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fromCityId, toCityId, zone]
 *             properties:
 *               fromCityId: { type: string, format: uuid }
 *               toCityId: { type: string, format: uuid }
 *               zone: { type: integer, enum: [1, 2, 3, 4], example: 2 }
 *     responses:
 *       201:
 *         description: Zone matrix entry saved
 *       403:
 *         description: Admin access required
 */
router.post('/zone-matrix', pricingController.upsertZoneMatrix);

/**
 * @swagger
 * /pricing/import:
 *   post:
 *     summary: Bulk import pricing data from Excel (Admin)
 *     tags: [Pricing]
 *     description: >
 *       Uploads and processes the BowaGO pricing Excel file. Imports data from all sheets:
 *       Dimensions, Zone Matrix, Matrix by KM, and Zone Matrix by Region.
 *       All operations are upserts — existing data is updated, not duplicated.
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Excel file (.xlsx) — e.g. Rating_For_BowaGO.xlsx
 *     responses:
 *       200:
 *         description: Import completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     results:
 *                       type: object
 *                       properties:
 *                         cities: { type: integer, example: 39 }
 *                         zones: { type: integer, example: 1521 }
 *                         km: { type: integer, example: 1521 }
 *                         dimensions: { type: integer, example: 10 }
 *                         errors:
 *                           type: array
 *                           items: { type: string }
 *       400:
 *         description: No file uploaded or invalid file format
 *       403:
 *         description: Admin access required
 */
router.post('/import', authenticate, requireAdmin, uploadImport.single('file'), pricingController.importPricingSheet);

/**
 * @swagger
 * /pricing/export:
 *   get:
 *     summary: Export current pricing data as an .xlsx file (Super Admin)
 *     description: >
 *       Produces an Excel workbook in the same layout the importer expects
 *       (Dimensions, Zone Matrix, Matrix by KM, Price Bands, Cities),
 *       populated with the platform's current data. Edit and re-import to
 *       update pricing/zones/distances/box types.
 *     tags: [Pricing]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Excel file download
 *         content:
 *           application/vnd.openxmlformats-officedocument.spreadsheetml.sheet:
 *             schema:
 *               type: string
 *               format: binary
 *       403:
 *         description: Super Admin access required
 */

// ─── Delivery SLA (zone-based delivery days) ──────────────────────────────────
router.get('/delivery-sla', deliverySLAController.listSLAs);
router.patch('/delivery-sla/:id', authenticate, requireSuperAdmin, deliverySLAController.updateSLA);
router.patch('/delivery-sla/zone/:zone/service/:serviceType', authenticate, requireSuperAdmin, deliverySLAController.updateSLAByZoneService);

router.get('/export', authenticate, requireSuperAdmin, pricingController.exportPricingSheet);


/**
 * @swagger
 * /pricing/zone-matrix/{id}/pause:
 *   patch:
 *     summary: Pause a zone matrix route (Admin)
 *     tags: [Pricing]
 *     description: >
 *       Temporarily disables a city-pair route by setting isActive = false.
 *       Paused routes are excluded from pricing lookups and the quote engine.
 *       Use reinstate to re-enable without deleting the record.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Zone matrix entry ID
 *     responses:
 *       200:
 *         description: Route paused successfully
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: "Zone route Lagos → Aba paused"
 *       400:
 *         description: Zone matrix entry is already paused
 *       404:
 *         description: Zone matrix entry not found
 */
router.patch('/zone-matrix/:id/pause', pricingController.pauseZoneMatrix);

/**
 * @swagger
 * /pricing/zone-matrix/{id}/reinstate:
 *   patch:
 *     summary: Reinstate a paused zone matrix route (Admin)
 *     tags: [Pricing]
 *     description: >
 *       Re-enables a previously paused city-pair route by setting isActive = true.
 *       The route becomes available again in pricing lookups and the quote engine.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Zone matrix entry ID
 *     responses:
 *       200:
 *         description: Route reinstated successfully
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: "Zone route Lagos → Aba reinstated"
 *       400:
 *         description: Zone matrix entry is already active
 *       404:
 *         description: Zone matrix entry not found
 */
router.patch('/zone-matrix/:id/reinstate', pricingController.reinstateZoneMatrix);

/**
 * @swagger
 * /pricing/zone-matrix/{id}:
 *   delete:
 *     summary: Permanently delete a zone matrix entry (Super Admin)
 *     tags: [Pricing]
 *     description: >
 *       Hard-deletes a city-pair zone entry. This cannot be undone.
 *       Prefer pause/reinstate for temporary management.
 *       Requires Super Admin role.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Zone matrix entry ID
 *     responses:
 *       200:
 *         description: Zone matrix entry deleted
 *       404:
 *         description: Zone matrix entry not found
 *       403:
 *         description: Super Admin access required
 */
router.patch('/zone-matrix/:id', requireSuperAdmin, pricingController.updateZoneMatrix);
router.delete('/zone-matrix/:id', requireSuperAdmin, pricingController.deleteZoneMatrix);

/**
 * @swagger
 * /pricing/stats:
 *   get:
 *     summary: Pricing system summary stats
 *     tags: [Pricing]
 *     description: >
 *       Returns a quick count of all major pricing entities.
 *       Useful for the admin dashboard overview card.
 *       No authentication required.
 *     responses:
 *       200:
 *         description: Stats returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     totalZone:
 *                       type: integer
 *                       description: Active city-pair routes in the zone matrix
 *                       example: 39
 *                     totalRegisteredCity:
 *                       type: integer
 *                       description: Total cities registered in the system
 *                       example: 42
 *                     totalContractRate:
 *                       type: integer
 *                       description: Active B2B contract rates
 *                       example: 5
 *                     totalStandardRate:
 *                       type: integer
 *                       description: Active price bands
 *                       example: 16
 *                     totalPromoRate:
 *                       type: integer
 *                       description: Active admin promo rates
 *                       example: 3
 *                     totalBoxDimension:
 *                       type: integer
 *                       description: Box dimension types configured
 *                       example: 10
 */
router.get('/stats', pricingController.getPricingStats);

/**
 * @swagger
 * /pricing/rollback/{auditLogId}:
 *   post:
 *     summary: Rollback a price band to a previous version (Admin)
 *     tags: [Pricing]
 *     description: >
 *       Reverts a price band to its state captured in a specific audit log entry.
 *       Useful for undoing accidental or erroneous price changes.
 *       The rollback itself is recorded as a new audit log entry.
 *     parameters:
 *       - in: path
 *         name: auditLogId
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: The audit log entry ID to roll back to
 *     responses:
 *       200:
 *         description: Price band rolled back successfully
 *       400:
 *         description: No previous value to roll back to, or entity type is not PriceBand
 *       404:
 *         description: Audit log entry not found
 */
router.post('/rollback/:auditLogId', pricingController.rollbackPriceBand);

module.exports = router;
