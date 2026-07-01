// slaBreachScheduler.service.js
// Scans IN_TRANSIT / OUT_FOR_DELIVERY shipments whose estimatedDelivery
// has passed, sends a delay alert to the customer and flags for admin,
// then writes a DelayAlert row so the same shipment isn't alerted again.
const { prisma } = require('../config/db');
const { sendShipmentStatusEmail } = require('../config/email');

async function runSLABreachSweep() {
  const now = new Date();

  // Find shipments that are overdue: in transit, estimated delivery in the past,
  // and not yet alerted.
  const overdue = await prisma.shipment.findMany({
    where: {
      status:            { in: ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'AWAITING_PICKUP', 'CONFIRMED', 'PICKED_UP'] },
      estimatedDelivery: { lt: now },
      delayAlert:        null,          // no alert yet for this shipment
      paymentStatus:     'PAID',
    },
    include: {
      customer: { select: { id: true, email: true, firstName: true } },
    },
    take: 100,  // batch cap — run again next cycle if more exist
  });

  if (overdue.length === 0) return { alerted: 0 };

  let alerted = 0;

  for (const shipment of overdue) {
    try {
      const daysLate = Math.ceil(
        (now.getTime() - new Date(shipment.estimatedDelivery).getTime()) / (1000 * 60 * 60 * 24),
      );
      const reason = `Shipment is ${daysLate} day${daysLate === 1 ? '' : 's'} past its estimated delivery date.`;

      // Write DelayAlert row first — if anything below fails we've still recorded
      // the breach and won't double-alert on the next sweep.
      await prisma.delayAlert.create({
        data: { shipmentId: shipment.id, reason },
      });

      // Add tracking event so the customer sees it in the timeline
      await prisma.trackingEvent.create({
        data: {
          shipmentId:  shipment.id,
          status:      shipment.status,
          description: `Delivery Delay Notice: ${reason} Our team has been notified.`,
          updatedBy:   'system',
        },
      });

      // In-app notification
      await prisma.notification.create({
        data: {
          userId: shipment.customerId,
          type:   'DELAY_ALERT',
          title:  `Shipment Delay — ${shipment.trackingNumber}`,
          body:   `${reason} We apologise for the inconvenience. Your shipment is still on its way.`,
          data:   {
            shipmentId:        shipment.id,
            trackingNumber:    shipment.trackingNumber,
            estimatedDelivery: shipment.estimatedDelivery,
            daysLate,
          },
        },
      });

      // Email the customer
      await sendShipmentStatusEmail(
        shipment.customer.email,
        shipment.customer.firstName,
        { ...shipment, status: 'DELAY_ALERT' },
      ).catch(() => {});

      alerted++;
    } catch (err) {
      console.error(`[SLABreach] Failed to alert shipment ${shipment.trackingNumber}:`, err.message);
    }
  }

  if (alerted > 0) {
    console.log(`[SLABreach] Sent delay alerts for ${alerted} overdue shipment(s).`);
  }

  return { alerted };
}

let timer = null;

async function startSLABreachScheduler() {
  if (timer) return;

  // Run 20 seconds after boot, then every 2 hours.
  setTimeout(() => runSLABreachSweep().catch((e) => console.error('[SLABreach] sweep error:', e.message)), 20_000);
  timer = setInterval(() => {
    runSLABreachSweep().catch((e) => console.error('[SLABreach] sweep error:', e.message));
  }, 2 * 60 * 60 * 1000); // every 2 hours

  console.log('[SLABreach] Scheduler started — sweeping every 2 hours.');
}

function stopSLABreachScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { runSLABreachSweep, startSLABreachScheduler, stopSLABreachScheduler };
