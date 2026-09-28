const router = require("express").Router();
const ctrl = require("../controllers/adhocChargeRule.controller");
const { authenticate, requireAdhocChargeManagement } = require("../middleware/auth");

/**
 * @swagger
 * tags:
 *   name: AdhocChargeRules
 *   description: "[V1 Feature 6] Weight/volume threshold rules linked to an adhoc charge type — AUTO_APPLY or SUGGEST."
 */

router.use(authenticate, requireAdhocChargeManagement);

router.get("/", ctrl.listRules);
router.post("/", ctrl.createRule);
router.get("/:id", ctrl.getRule);
router.patch("/:id", ctrl.updateRule);
router.post("/:id/deactivate", ctrl.deactivateRule);
router.get("/:id/history", ctrl.getRuleHistory);

module.exports = router;
