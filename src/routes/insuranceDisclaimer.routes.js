const router = require("express").Router();
const ctrl = require("../controllers/insuranceDisclaimer.controller");
const { authenticate, requireAdhocChargeManagement } = require("../middleware/auth");

/**
 * @swagger
 * tags:
 *   name: InsuranceDisclaimer
 *   description: "[V1 Feature 7] Versioned uninsured-risk disclaimer wording + liability limit."
 */

// Public — the quote page and review screen need this for guests too.
router.get("/", ctrl.getCurrentDisclaimer);

// Publishing a new version/limit needs Legal sign-off in practice, but at the
// API layer this rides the same adhoc-charge admin capability (it's the
// same "pricing/legal configuration" surface as adhoc charges).
router.post("/", authenticate, requireAdhocChargeManagement, ctrl.publishDisclaimer);
router.get("/history", authenticate, requireAdhocChargeManagement, ctrl.listDisclaimerHistory);

module.exports = router;
