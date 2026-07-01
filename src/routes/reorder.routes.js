// reorder.routes.js — Customer Portal: re-book from a previous shipment
const router = require('express').Router();
const { prisma } = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { success } = require('../utils/helpers');
const { ApiError } = require('../utils/ApiError');

router.use(authenticate);

/**
 * GET /reorder/:shipmentId/prefill
 * Returns the fields needed to pre-fill the booking modal from a past shipment.
 * The customer still goes through the full quote + pay flow — this just saves them
 * re-typing the addresses, weight, and service type.
 */
router.get('/:shipmentId/prefill', async (req, res) => {
  const { shipmentId } = req.params;

  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    select: {
      customerId:      true,
      senderName:      true,
      senderPhone:     true,
      senderAddress:   true,
      senderCity:      true,
      senderState:     true,
      recipientName:   true,
      recipientPhone:  true,
      recipientAddress:true,
      recipientCity:   true,
      recipientState:  true,
      description:     true,
      weight:          true,
      weightUnit:      true,
      cartons:         true,
      serviceType:     true,
      isFragile:       true,
      requiresInsurance:true,
      notes:           true,
    },
  });

  if (!shipment) throw new ApiError(404, 'Shipment not found');
  if (shipment.customerId !== req.user.id) throw new ApiError(403, 'Access denied');

  // Strip the id from the response — the frontend uses this to pre-fill a NEW booking
  const { customerId, ...prefill } = shipment;
  return success(res, { prefill });
});

module.exports = router;
