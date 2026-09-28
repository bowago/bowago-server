const router = require("express").Router();
const modeCtrl = require("../controllers/shipmentMode.controller");
const disclaimerCtrl = require("../controllers/insuranceDisclaimer.controller");

/**
 * Read-only endpoints that customers and guests need to render the quote and
 * booking forms. They deliberately live OUTSIDE /api/v1/admin: the admin
 * router applies authenticate + requireAdmin to everything under that prefix,
 * so anything mounted there is unreachable by non-admins no matter what the
 * individual route says.
 *
 *   GET /api/v1/shipment-modes       -> which modes exist / are switched on
 *   GET /api/v1/insurance-disclaimer -> the currently effective disclaimer
 *
 * Writes stay under /api/v1/admin/... behind the admin capability guards.
 */
router.get("/shipment-modes", modeCtrl.listModes);
router.get("/insurance-disclaimer", disclaimerCtrl.getCurrentDisclaimer);

module.exports = router;
