const { prisma } = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { success, created } = require('../utils/helpers');
const { initializePayment } = require('../services/paystack.service');

// ─── Admin: Create price adjustment (weight discrepancy found at hub) ─────────
async function createPriceAdjustment(req, res) {
  const { shipmentId, adjustedPrice, reason, actualWeightKg, proofImageUrl } = req.body;

  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: { customer: { select: { id: true, email: true, firstName: true } } },
  });
  if (!shipment) throw new ApiError(404, 'Shipment not found');

  const difference = adjustedPrice - shipment.quotedPrice;
  if (difference <= 0) throw new ApiError(400, 'Adjusted price must be higher than quoted price');

  const adjustment = await prisma.priceAdjustment.create({
    data: {
      shipmentId,
      originalPrice: shipment.quotedPrice,
      adjustedPrice,
      difference,
      reason,
      actualWeightKg,
      proofImageUrl,
    },
  });

  // Pause the shipment until customer acknowledges
  await prisma.shipment.update({
    where: { id: shipmentId },
    data: { status: 'PENDING_ADMIN_REVIEW' },
  });

  // Notify customer — they must pay the difference
  await prisma.notification.create({
    data: {
      userId: shipment.customerId,
      type: 'PRICE_ADJUSTMENT',
      title: 'Price Adjustment Required',
      body: `Your shipment ${shipment.trackingNumber} requires a price adjustment of ₦${difference.toLocaleString()}. ${reason}`,
      data: {
        shipmentId,
        adjustmentId: adjustment.id,
        difference,
        adjustedPrice,
        proofImageUrl,
      },
    },
  });

  return created(res, { adjustment }, 'Price adjustment created. Customer has been notified.');
}

// ─── Customer: Acknowledge and pay the price difference ──────────────────────
async function acknowledgePriceAdjustment(req, res) {
  const { id } = req.params;

  const adjustment = await prisma.priceAdjustment.findUnique({
    where: { id },
    include: {
      shipment: {
        include: { customer: { select: { id: true, email: true } } },
      },
    },
  });

  if (!adjustment) throw new ApiError(404, 'Price adjustment not found');
  if (adjustment.shipment.customerId !== req.user.id) throw new ApiError(403, 'Access denied');
  if (adjustment.isAcknowledged) throw new ApiError(400, 'Already acknowledged');

  // Initialize Paystack payment for the difference
  const paymentResult = await initializePayment({
    userId: req.user.id,
    shipmentId: adjustment.shipmentId,
    amountNaira: adjustment.difference,
    email: req.user.email,
    metadata: {
      type: 'PRICE_ADJUSTMENT',
      adjustmentId: adjustment.id,
      trackingNumber: adjustment.shipment.trackingNumber,
    },
  });

  await prisma.priceAdjustment.update({
    where: { id },
    data: { isAcknowledged: true, acknowledgedAt: new Date() },
  });

  return success(res, {
    adjustment,
    payment: paymentResult,
    message: 'Acknowledged. Complete payment to resume your shipment.',
  });
}

// ─── Get adjustments for a shipment ──────────────────────────────────────────
async function getShipmentAdjustments(req, res) {
  const { shipmentId } = req.params;

  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new ApiError(404, 'Shipment not found');

  // Customers can only view their own
  if (req.user.role === 'CUSTOMER' && shipment.customerId !== req.user.id) {
    throw new ApiError(403, 'Access denied');
  }

  const adjustments = await prisma.priceAdjustment.findMany({
    where: { shipmentId },
    orderBy: { createdAt: 'desc' },
  });

  return success(res, { adjustments });
}

module.exports = {
  createPriceAdjustment,
  acknowledgePriceAdjustment,
  getShipmentAdjustments,
};
