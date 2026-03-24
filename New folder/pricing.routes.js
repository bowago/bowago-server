const router = require('express').Router();
const pricingController = require('../controllers/pricing.controller');
const { authenticate, requireAdmin, requireLogisticsOrAbove, requireSuperAdmin } = require('../middleware/auth');
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
router.use(authenticate);
router.use(requireLogisticsOrAbove);

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
router.delete('/dimensions/:id', pricingController.deleteDimension);

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
router.post('/import', uploadImport.single('file'), pricingController.importPricingSheet);

module.exports = router;
