const router = require("express").Router();
const ctrl = require("../controllers/shipmentMode.controller");
const { authenticate, requireRateManagement } = require("../middleware/auth");

/**
 * @swagger
 * tags:
 *   name: ShipmentModes
 *   description: "[V1] Per-mode (AIR/LAND/SEA) settings — volumetric divisor, transit hours, active/inactive."
 */

// GET is open to anyone building a quote form (guest or authenticated).
router.get("/", ctrl.listModes);

// PATCH requires the rate-management capability, same guard PriceBand uses.
router.patch("/:mode", authenticate, requireRateManagement, ctrl.updateMode);

module.exports = router;
