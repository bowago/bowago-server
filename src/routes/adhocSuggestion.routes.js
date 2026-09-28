const router = require("express").Router();
const ctrl = require("../controllers/adhocSuggestion.controller");
const { authenticate, requireAdhocChargeManagement } = require("../middleware/auth");

/**
 * @swagger
 * tags:
 *   name: AdhocSuggestions
 *   description: "[V1 Feature 6] Admin queue of SUGGEST-behaviour adhoc charge matches awaiting approve/edit/dismiss."
 */

router.use(authenticate, requireAdhocChargeManagement);

router.get("/", ctrl.listSuggestions);
router.post("/:id/decision", ctrl.decideSuggestion);

module.exports = router;
