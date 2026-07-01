// priceAdjustmentScheduler.service.js — periodic sweep that auto-cancels
// (with refund) any price adjustment whose response deadline has passed
// with no customer action. Runs in-process via setInterval; no extra
// infra/dependency required. Interval is configurable via AppSettings
// (price_adjustment.sweep_interval_minutes) but requires a server restart
// to pick up a change since it's only read at startup.
const { prisma } = require('../config/db');
const { getNumberSetting } = require('./settings.service');
const { cancelAndRefund } = require('../controllers/priceAdjustment.controller');

let timer = null;

async function runExpiredAdjustmentSweep() {
  const now = new Date();

  const expired = await prisma.priceAdjustment.findMany({
    where: { status: 'PENDING', responseDeadline: { lt: now } },
    include: {
      shipment: {
        include: {
          customer: { select: { id: true, email: true } },
          payments: { where: { status: 'PAID' }, orderBy: { createdAt: 'desc' }, take: 1 },
        },
      },
    },
  });

  if (expired.length === 0) return { processed: 0 };

  const refundPercent = await getNumberSetting('price_adjustment.auto_cancel_refund_percent');

  let processed = 0;
  for (const adjustment of expired) {
    try {
      // Re-check status right before acting in case the customer responded
      // in the moment between the query above and now (race condition guard).
      const fresh = await prisma.priceAdjustment.findUnique({ where: { id: adjustment.id } });
      if (!fresh || fresh.status !== 'PENDING') continue;

      await cancelAndRefund({
        shipment: adjustment.shipment,
        adjustment,
        refundPercent,
        resolutionType: 'AUTO_CANCEL',
        actorId: 'system',
        actorLabel: 'system (timeout)',
      });
      processed++;
    } catch (err) {
      console.error(`[priceAdjustmentScheduler] Failed to auto-cancel adjustment ${adjustment.id}:`, err.message);
    }
  }

  if (processed > 0) {
    console.log(`[priceAdjustmentScheduler] Auto-cancelled ${processed} expired price adjustment(s).`);
  }

  return { processed };
}

async function startPriceAdjustmentScheduler() {
  if (timer) return; // already running

  const intervalMinutes = await getNumberSetting('price_adjustment.sweep_interval_minutes');
  const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;

  // Run once shortly after boot, then on the configured interval.
  setTimeout(() => runExpiredAdjustmentSweep().catch((e) => console.error('[priceAdjustmentScheduler] sweep error:', e.message)), 10_000);
  timer = setInterval(() => {
    runExpiredAdjustmentSweep().catch((e) => console.error('[priceAdjustmentScheduler] sweep error:', e.message));
  }, intervalMs);

  console.log(`[priceAdjustmentScheduler] Started — sweeping every ${intervalMinutes} minute(s).`);
}

function stopPriceAdjustmentScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { runExpiredAdjustmentSweep, startPriceAdjustmentScheduler, stopPriceAdjustmentScheduler };
