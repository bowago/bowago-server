const { prisma } = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { assertOwnedResourceAccess } = require('../utils/access');
const { success, created } = require('../utils/helpers');
const { initializePayment, refundPayment } = require('../services/paystack.service');
const { calculateShippingCost } = require('../services/pricing.service');
const { getNumberSetting, getBoolSetting } = require('../services/settings.service');

const TIER_ORDER = ['ECONOMY', 'STANDARD', 'EXPRESS'];

function isResolved(adjustment) {
  return adjustment.status !== 'PENDING';
}

// ─── Admin/Dispatcher: Create price adjustment (weight discrepancy found at hub) ─
async function createPriceAdjustment(req, res) {
  const { shipmentId, adjustedPrice, reason, actualWeightKg, proofImageUrl, proofImageUrls } = req.body;

  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: { customer: { select: { id: true, email: true, firstName: true } } },
  });
  if (!shipment) throw new ApiError(404, 'Shipment not found');

  const difference = adjustedPrice - shipment.quotedPrice;
  if (difference <= 0) throw new ApiError(400, 'Adjusted price must be higher than quoted price');

  let imageUrls = null;
  if (proofImageUrls && Array.isArray(proofImageUrls) && proofImageUrls.length > 0) {
    if (proofImageUrls.length > 5) throw new ApiError(400, 'Maximum 5 proof images allowed');
    imageUrls = proofImageUrls;
  } else if (proofImageUrl) {
    imageUrls = [proofImageUrl];
  }

  const windowHours = await getNumberSetting('price_adjustment.response_window_hours');
  const responseDeadline = new Date(Date.now() + windowHours * 60 * 60 * 1000);

  const adjustment = await prisma.priceAdjustment.create({
    data: {
      shipmentId,
      originalPrice: shipment.quotedPrice,
      adjustedPrice,
      difference,
      reason,
      actualWeightKg,
      proofImageUrl: imageUrls?.[0] || null,
      proofImageUrls: imageUrls || null,
      status: 'PENDING',
      previousStatus: shipment.status,
      responseDeadline,
    },
  });

  await prisma.shipment.update({
    where: { id: shipmentId },
    data: { status: 'PENDING_ADMIN_REVIEW' },
  });

  await prisma.trackingEvent.create({
    data: {
      shipmentId,
      status: 'PENDING_ADMIN_REVIEW',
      description: `Shipment paused — weight discrepancy found at hub. ${reason}`,
      updatedBy: req.user.id,
    },
  });

  await prisma.notification.create({
    data: {
      userId: shipment.customerId,
      type: 'PRICE_ADJUSTMENT',
      title: 'Action Required: Price Adjustment',
      body: `Your shipment ${shipment.trackingNumber} requires a price adjustment of ₦${difference.toLocaleString()}. ${reason} You have ${windowHours} hours to respond.`,
      data: {
        shipmentId,
        adjustmentId: adjustment.id,
        difference,
        adjustedPrice,
        responseDeadline,
        proofImageUrl: imageUrls?.[0] || null,
        proofImageUrls: imageUrls,
      },
    },
  });

  return created(res, { adjustment }, 'Price adjustment created. Customer has been notified.');
}

// ─── Customer: Option 1 — Pay the difference ──────────────────────────────────
async function acknowledgePriceAdjustment(req, res) {
  const { id } = req.params;

  const adjustment = await prisma.priceAdjustment.findUnique({
    where: { id },
    include: { shipment: { include: { customer: { select: { id: true, email: true } } } } },
  });

  if (!adjustment) throw new ApiError(404, 'Price adjustment not found');
  if (adjustment.shipment.customerId !== req.user.id) throw new ApiError(403, 'Access denied');
  if (isResolved(adjustment)) throw new ApiError(400, `This adjustment is already ${adjustment.status.toLowerCase()}`);

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

// ─── Customer: Option 2 — Downgrade to a lower service tier ──────────────────
async function downgradePriceAdjustment(req, res) {
  const { id } = req.params;
  const { newServiceType } = req.body;

  const downgradeEnabled = await getBoolSetting('price_adjustment.downgrade_enabled');
  if (!downgradeEnabled) throw new ApiError(400, 'Downgrade option is currently disabled');

  if (!TIER_ORDER.includes(newServiceType)) {
    throw new ApiError(400, `newServiceType must be one of: ${TIER_ORDER.join(', ')}`);
  }

  const adjustment = await prisma.priceAdjustment.findUnique({
    where: { id },
    include: {
      shipment: {
        include: {
          customer: { select: { id: true, email: true } },
          payments: { where: { status: 'PAID' }, orderBy: { createdAt: 'desc' }, take: 1 },
        },
      },
    },
  });
  if (!adjustment) throw new ApiError(404, 'Price adjustment not found');
  if (adjustment.shipment.customerId !== req.user.id) throw new ApiError(403, 'Access denied');
  if (isResolved(adjustment)) throw new ApiError(400, `This adjustment is already ${adjustment.status.toLowerCase()}`);

  const shipment = adjustment.shipment;
  const currentTierIdx = TIER_ORDER.indexOf(shipment.serviceType);
  const newTierIdx = TIER_ORDER.indexOf(newServiceType);
  if (newTierIdx >= currentTierIdx) {
    throw new ApiError(400, 'Downgrade must select a lower service tier than the current one');
  }

  const quote = await calculateShippingCost({
    fromCity: shipment.senderCity,
    toCity: shipment.recipientCity,
    weightKg: adjustment.actualWeightKg || shipment.weight,
    serviceType: newServiceType,
    isFragile: shipment.isFragile,
    requiresInsurance: shipment.requiresInsurance,
    insuranceValue: shipment.insuranceValue || 0,
    userId: shipment.customerId,
  });

  const newPrice = quote.total;
  const alreadyPaid = (shipment.payments?.[0]?.amountKobo || 0) / 100;
  const delta = newPrice - alreadyPaid;

  let paymentResult = null;
  let refundResult = null;

  if (delta > 0) {
    paymentResult = await initializePayment({
      userId: req.user.id,
      shipmentId: shipment.id,
      amountNaira: delta,
      email: req.user.email,
      metadata: { type: 'PRICE_ADJUSTMENT_DOWNGRADE', adjustmentId: adjustment.id, trackingNumber: shipment.trackingNumber },
    });
  } else if (delta < 0 && shipment.payments?.[0]) {
    refundResult = await refundPayment(shipment.payments[0].reference, Math.abs(delta));
  }

  const resumeStatus = adjustment.previousStatus || 'CONFIRMED';

  await prisma.$transaction([
    prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        serviceType: newServiceType,
        quotedPrice: newPrice,
        finalPrice: newPrice,
        ...(delta > 0 ? {} : { status: resumeStatus }),
      },
    }),
    prisma.priceAdjustment.update({
      where: { id },
      data: {
        status: delta > 0 ? 'PENDING' : 'DOWNGRADED',
        resolutionType: 'DOWNGRADE',
        resolvedAt: delta > 0 ? null : new Date(),
        ...(delta <= 0 ? { refundAmount: delta < 0 ? Math.abs(delta) : 0, refundPercent: 100 } : {}),
      },
    }),
    prisma.trackingEvent.create({
      data: {
        shipmentId: shipment.id,
        status: delta > 0 ? 'PENDING_ADMIN_REVIEW' : resumeStatus,
        description: `Customer downgraded to ${newServiceType}. New price ₦${newPrice.toLocaleString()}.`,
        updatedBy: req.user.id,
      },
    }),
  ]);

  await prisma.notification.create({
    data: {
      userId: shipment.customerId,
      type: 'PRICE_ADJUSTMENT',
      title: 'Shipment Downgraded',
      body:
        delta > 0
          ? `Your shipment was downgraded to ${newServiceType}. Please pay the remaining ₦${delta.toLocaleString()} to resume.`
          : `Your shipment was downgraded to ${newServiceType}. ${delta < 0 ? `₦${Math.abs(delta).toLocaleString()} was refunded.` : ''} Your shipment has resumed.`,
      data: { shipmentId: shipment.id, adjustmentId: adjustment.id },
    },
  });

  return success(res, { newPrice, delta, paymentResult, refundResult }, 'Downgrade processed');
}

// ─── Customer: Option 3 — Cancel and refund ───────────────────────────────────
async function cancelPriceAdjustment(req, res) {
  const { id } = req.params;

  const adjustment = await prisma.priceAdjustment.findUnique({
    where: { id },
    include: {
      shipment: {
        include: {
          customer: { select: { id: true, email: true } },
          payments: { where: { status: 'PAID' }, orderBy: { createdAt: 'desc' }, take: 1 },
        },
      },
    },
  });
  if (!adjustment) throw new ApiError(404, 'Price adjustment not found');
  if (adjustment.shipment.customerId !== req.user.id) throw new ApiError(403, 'Access denied');
  if (isResolved(adjustment)) throw new ApiError(400, `This adjustment is already ${adjustment.status.toLowerCase()}`);

  const refundPercent = await getNumberSetting('price_adjustment.cancel_refund_percent');
  const result = await cancelAndRefund({
    shipment: adjustment.shipment,
    adjustment,
    refundPercent,
    resolutionType: 'CANCEL',
    actorId: req.user.id,
    actorLabel: 'customer',
  });

  return success(res, result, 'Shipment cancelled and refund initiated');
}

// Shared cancellation + refund logic used by both customer-initiated cancel
// and the auto-cancel timeout sweep.
async function cancelAndRefund({ shipment, adjustment, refundPercent, resolutionType, actorId, actorLabel }) {
  const payment = shipment.payments?.[0] || null;
  const paidAmount = payment ? payment.amountKobo / 100 : 0;
  const refundAmount = Math.floor(paidAmount * (refundPercent / 100));

  await prisma.$transaction([
    prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        status: 'CANCELLED',
        ...(refundAmount > 0 && payment ? { paymentStatus: 'REFUNDED' } : {}),
      },
    }),
    prisma.priceAdjustment.update({
      where: { id: adjustment.id },
      data: {
        status: resolutionType === 'AUTO_CANCEL' ? 'EXPIRED' : 'CANCELLED',
        resolutionType,
        resolvedAt: new Date(),
        refundPercent,
        refundAmount,
      },
    }),
    prisma.trackingEvent.create({
      data: {
        shipmentId: shipment.id,
        status: 'CANCELLED',
        description:
          resolutionType === 'AUTO_CANCEL'
            ? `Auto-cancelled — no response to price adjustment within the response window.`
            : `Cancelled by ${actorLabel} in response to price adjustment.`,
        updatedBy: actorId,
      },
    }),
  ]);

  let refundResult = null;
  if (payment && refundAmount > 0) {
    refundResult = await refundPayment(payment.reference, refundAmount);
  }

  await prisma.notification.create({
    data: {
      userId: shipment.customerId,
      type: 'SHIPMENT_UPDATE',
      title: `Shipment ${shipment.trackingNumber} Cancelled`,
      body:
        refundAmount > 0
          ? `Your shipment was cancelled${resolutionType === 'AUTO_CANCEL' ? ' automatically after no response to the price adjustment' : ''}. A refund of ₦${refundAmount.toLocaleString()} (${refundPercent}%) has been initiated.`
          : `Your shipment was cancelled. No refund is applicable.`,
      data: { shipmentId: shipment.id, adjustmentId: adjustment.id },
    },
  }).catch(() => {});

  return { cancelled: true, refundAmount, refundPercent, refundInitiated: !!refundResult };
}

// ─── Customer: Option 4 — Contact support ─────────────────────────────────────
async function contactSupportForAdjustment(req, res) {
  const { id } = req.params;
  const { message } = req.body;

  const adjustment = await prisma.priceAdjustment.findUnique({
    where: { id },
    include: { shipment: true },
  });
  if (!adjustment) throw new ApiError(404, 'Price adjustment not found');
  if (adjustment.shipment.customerId !== req.user.id) throw new ApiError(403, 'Access denied');

  const { createTicket } = require('./support.controller');
  req.body = {
    subject: `Price adjustment dispute — ${adjustment.shipment.trackingNumber}`,
    category: 'PRICING_DISPUTE',
    shipmentId: adjustment.shipmentId,
    body: message || `Customer requested support regarding a price adjustment of ₦${adjustment.difference.toLocaleString()} on shipment ${adjustment.shipment.trackingNumber}.`,
    priority: 'HIGH',
  };
  return createTicket(req, res);
}

// ─── Admin/Support: Extend the response deadline ──────────────────────────────
async function extendAdjustmentDeadline(req, res) {
  const { id } = req.params;
  const { hours, note } = req.body;

  if (!hours || Number(hours) <= 0) throw new ApiError(400, 'hours must be a positive number');

  const adjustment = await prisma.priceAdjustment.findUnique({ where: { id } });
  if (!adjustment) throw new ApiError(404, 'Price adjustment not found');
  if (isResolved(adjustment)) throw new ApiError(400, `This adjustment is already ${adjustment.status.toLowerCase()}`);

  const base = adjustment.responseDeadline && adjustment.responseDeadline > new Date()
    ? adjustment.responseDeadline
    : new Date();
  const newDeadline = new Date(base.getTime() + Number(hours) * 60 * 60 * 1000);

  const updated = await prisma.priceAdjustment.update({
    where: { id },
    data: { responseDeadline: newDeadline, extendedBy: req.user.id, extensionNote: note || null },
  });

  return success(res, { adjustment: updated }, 'Response deadline extended');
}

// ─── Get adjustments for a shipment ───────────────────────────────────────────
async function getShipmentAdjustments(req, res) {
  const { shipmentId } = req.params;

  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new ApiError(404, 'Shipment not found');

  await assertOwnedResourceAccess(req.user, shipment.customerId, {
    resource: 'PriceAdjustment',
    resourceId: shipmentId,
    req,
  });

  const adjustments = await prisma.priceAdjustment.findMany({
    where: { shipmentId },
    orderBy: { createdAt: 'desc' },
  });

  return success(res, { adjustments });
}

module.exports = {
  createPriceAdjustment,
  acknowledgePriceAdjustment,
  downgradePriceAdjustment,
  cancelPriceAdjustment,
  cancelAndRefund,
  contactSupportForAdjustment,
  extendAdjustmentDeadline,
  getShipmentAdjustments,
};
