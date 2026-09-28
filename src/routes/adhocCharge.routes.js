const router = require("express").Router();
const ctrl = require("../controllers/adhocCharge.controller");
const { authenticate, requireAdhocChargeManagement } = require("../middleware/auth");

/**
 * @swagger
 * tags:
 *   name: AdhocCharges
 *   description: >
 *     [V1 Feature 5] Admin-defined adhoc charge types (oversize handling,
 *     extra packaging, storage, re-delivery, weekend pickup, etc). Never
 *     hard-deleted — deactivate instead. Every change is written to
 *     PriceAuditLog (entityType "AdhocChargeType"), the same immutable audit
 *     pattern used for rates.
 */

router.use(authenticate, requireAdhocChargeManagement);

router.get("/", ctrl.listChargeTypes);
router.post("/", ctrl.createChargeType);
router.get("/:id", ctrl.getChargeType);
router.patch("/:id", ctrl.updateChargeType);
router.post("/:id/deactivate", ctrl.deactivateChargeType);
router.get("/:id/history", ctrl.getChargeTypeHistory);

module.exports = router;
