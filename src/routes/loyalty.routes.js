const router = require('express').Router();
const { prisma } = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { success } = require('../utils/helpers');
const { ApiError } = require('../utils/ApiError');
const {
  getAccountSummary,
  previewRedemption,
  redeemPoints,
} = require('../services/loyalty.service');

router.use(authenticate);

// GET /loyalty/me — Customer's loyalty account summary + recent transactions
router.get('/me', async (req, res) => {
  const summary = await getAccountSummary(req.user.id);
  return success(res, { loyalty: summary });
});

// POST /loyalty/preview-redemption — Show discount if N points redeemed
// Body: { pointsToRedeem, shipmentPriceNaira }
router.post('/preview-redemption', async (req, res) => {
  const { pointsToRedeem, shipmentPriceNaira } = req.body;
  if (!pointsToRedeem || !shipmentPriceNaira) {
    throw new ApiError(400, 'pointsToRedeem and shipmentPriceNaira are required');
  }
  const preview = await previewRedemption({
    userId:             req.user.id,
    pointsToRedeem:     Number(pointsToRedeem),
    shipmentPriceNaira: Number(shipmentPriceNaira),
  });
  return success(res, { preview });
});

// POST /loyalty/redeem — Apply points discount to a shipment
// Body: { shipmentId, pointsToRedeem }
router.post('/redeem', async (req, res) => {
  const { shipmentId, pointsToRedeem } = req.body;
  if (!shipmentId || !pointsToRedeem) {
    throw new ApiError(400, 'shipmentId and pointsToRedeem are required');
  }

  // Verify the shipment belongs to the customer and is still payable
  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new ApiError(404, 'Shipment not found');
  if (shipment.customerId !== req.user.id) throw new ApiError(403, 'Access denied');
  if (!['PENDING', 'BOOKED'].includes(shipment.status)) {
    throw new ApiError(400, 'Points can only be redeemed before payment is processed');
  }

  const result = await redeemPoints({
    userId:         req.user.id,
    shipmentId,
    pointsToRedeem: Number(pointsToRedeem),
  });

  // Apply discount to the shipment's quoted price
  const newPrice = Math.max(0, shipment.quotedPrice - result.discountNaira);
  await prisma.shipment.update({
    where: { id: shipmentId },
    data:  { quotedPrice: newPrice },
  });

  return success(res, { ...result, newQuotedPrice: newPrice }, `₦${result.discountNaira.toLocaleString()} discount applied`);
});

module.exports = router;
