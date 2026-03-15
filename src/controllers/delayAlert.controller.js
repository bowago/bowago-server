const { prisma } = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { success } = require('../utils/helpers');
const { sendShipmentStatusEmail } = require('../config/email');

// ─── Admin: Send proactive delay alert to multiple customers ─────────────────
async function sendDelayAlert(req, res) {
  const { shipmentIds, reason, newEstimatedDelivery, message } = req.body;

  if (!shipmentIds || shipmentIds.length === 0) {
    throw new ApiError(400, 'Provide at least one shipmentId');
  }
  if (!reason) throw new ApiError(400, 'reason is required');

  const shipments = await prisma.shipment.findMany({
    where: { id: { in: shipmentIds } },
    include: {
      customer: { select: { id: true, email: true, firstName: true } },
    },
  });

  if (shipments.length === 0) throw new ApiError(404, 'No shipments found');

  const alertBody = message ||
    `Your shipment has been delayed. Reason: ${reason}.${newEstimatedDelivery ? ` New estimated delivery: ${new Date(newEstimatedDelivery).toLocaleDateString('en-NG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.` : ''}`;

  const results = { notified: 0, errors: [] };

  for (const shipment of shipments) {
    try {
      // Update ETA if provided
      if (newEstimatedDelivery) {
        await prisma.shipment.update({
          where: { id: shipment.id },
          data: { estimatedDelivery: new Date(newEstimatedDelivery) },
        });
      }

      // Add tracking event
      await prisma.trackingEvent.create({
        data: {
          shipmentId: shipment.id,
          status: shipment.status,
          description: `Delay Notice: ${reason}`,
          updatedBy: req.user.id,
        },
      });

      // In-app notification
      await prisma.notification.create({
        data: {
          userId: shipment.customerId,
          type: 'DELAY_ALERT',
          title: `Shipment Delay — ${shipment.trackingNumber}`,
          body: alertBody,
          data: {
            shipmentId: shipment.id,
            trackingNumber: shipment.trackingNumber,
            reason,
            newEstimatedDelivery,
          },
        },
      });

      // Email notification
      await sendShipmentStatusEmail(
        shipment.customer.email,
        shipment.customer.firstName,
        { ...shipment, status: shipment.status }
      ).catch(() => {}); // non-blocking

      results.notified++;
    } catch (err) {
      results.errors.push({ shipmentId: shipment.id, error: err.message });
    }
  }

  return success(res, { results }, `Delay alert sent to ${results.notified} customers`);
}

// ─── Admin: Get all delay-alerted shipments ───────────────────────────────────
async function getDelayedShipments(req, res) {
  const shipments = await prisma.shipment.findMany({
    where: {
      status: { in: ['CONFIRMED', 'PICKED_UP', 'IN_TRANSIT'] },
      estimatedDelivery: { lt: new Date() }, // Past their ETA and not delivered
    },
    include: {
      customer: { select: { firstName: true, lastName: true, email: true } },
    },
    orderBy: { estimatedDelivery: 'asc' },
  });

  return success(res, { shipments, count: shipments.length });
}

module.exports = { sendDelayAlert, getDelayedShipments };
