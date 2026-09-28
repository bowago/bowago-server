const router = require("express").Router();
const ctrl = require("../controllers/shipmentDraft.controller");
const { authenticate, restrictEnterpriseRolesTo } = require("../middleware/auth");

/**
 * @swagger
 * tags:
 *   name: ShipmentDrafts
 *   description: >
 *     [V1 Feature 8] Review-before-create booking flow. Nothing is a real
 *     Shipment until POST /shipment-drafts/{draftId}/confirm succeeds.
 *     Available to ROLE_USER and ROLE_DISPATCHER (an Enterprise dispatcher
 *     booking on behalf of a merchant/customer — V1 also grants dispatchers
 *     shipments:BOOK_ON_BEHALF per Sprint 8).
 */

router.use(authenticate, restrictEnterpriseRolesTo("ROLE_MASTER", "ROLE_DISPATCHER", "ROLE_USER"));

router.post("/", ctrl.createDraft);
router.get("/:id", ctrl.getDraft);
router.patch("/:id", ctrl.patchDraft);
router.post("/:id/confirm", ctrl.confirmDraft);

module.exports = router;
