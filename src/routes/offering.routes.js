const router = require("express").Router();
const ctrl = require("../controllers/offering.controller");
const { authenticate, requireRateManagement } = require("../middleware/auth");

/**
 * @swagger
 * tags:
 *   name: Offerings
 *   description: >
 *     Shipping offerings — the purchasable products (shipment mode + service
 *     type) with eligibility limits and lane availability. Combinations that
 *     are not defined here do not exist and can never be quoted.
 */

router.use(authenticate, requireRateManagement);

/**
 * @swagger
 * /admin/offerings:
 *   get:
 *     summary: List offerings with per-zone coverage summary
 *     tags: [Offerings]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Offerings + coverage (zones sellable / missing SLA / missing rate) }
 *   post:
 *     summary: Define an offering (created inactive; activation requires coverage)
 *     tags: [Offerings]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Created }
 */
router.get("/", ctrl.listOfferings);
router.post("/", ctrl.createOffering);
router.get("/warnings", ctrl.getRateWarnings); // advisory rate-relationship warnings
router.get("/:id/coverage", ctrl.getCoverage);
router.patch("/:id", ctrl.updateOffering);
router.post("/:id/lanes", ctrl.addLane);
router.delete("/:id/lanes/:laneId", ctrl.removeLane);

module.exports = router;
