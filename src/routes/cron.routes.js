// cron.routes.js — Vercel Cron Job endpoints
// Vercel calls these on a schedule defined in vercel.json.
// Each route is protected by a shared CRON_SECRET so random internet
// traffic can't trigger them. Vercel automatically sets the
// x-vercel-cron header but we double-check with our own secret.
//
// Cheaper alternative: Upstash QStash (free tier: 500 msgs/month)
// Just point QStash at the same URL with the Authorization header.

const router = require('express').Router();
const { runExpiredAdjustmentSweep } = require('../services/priceAdjustmentScheduler.service');
const { runEscalationJob } = require('../controllers/support.controller');

function verifyCronSecret(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // If CRON_SECRET is not set, block all cron calls in production
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'CRON_SECRET not configured' });
    }
    return next(); // allow in dev without the env var
  }
  const auth = req.headers['authorization'] ?? '';
  if (auth !== `Bearer ${secret}`) {
    return res.status(403).json({ error: 'Invalid cron secret' });
  }
  return next();
}

/**
 * POST /api/v1/cron/sweep-price-adjustments
 *
 * Auto-cancels price adjustments whose response deadline has passed.
 * Add to vercel.json:
 *
 *   {
 *     "crons": [
 *       {
 *         "path": "/api/v1/cron/sweep-price-adjustments",
 *         "schedule": "* /15 * * * *"   (every 15 min — remove the space)
 *       }
 *     ]
 *   }
 *
 * And set CRON_SECRET in your Vercel environment variables.
 * Vercel sends the Authorization: Bearer <CRON_SECRET> header automatically.
 */
router.post('/sweep-price-adjustments', verifyCronSecret, async (req, res) => {
  try {
    const result = await runExpiredAdjustmentSweep();
    return res.json({ ok: true, processed: result.processed });
  } catch (err) {
    console.error('[Cron] sweep-price-adjustments failed:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/v1/cron/escalate-tickets
 *
 * Escalates stale support tickets that have been IN_PROGRESS for > 4 hours.
 * Add to vercel.json:
 *
 *   { "path": "/api/v1/cron/escalate-tickets", "schedule": "0 * /1 * * *" }
 *   (every hour — remove the space in * /1)
 */
router.post('/escalate-tickets', verifyCronSecret, async (req, res) => {
  try {
    const result = await runEscalationJob();
    return res.json({ ok: true, escalated: result.escalated });
  } catch (err) {
    console.error('[Cron] escalate-tickets failed:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/v1/cron/sla-breach-sweep
 * Sends delay alerts for overdue shipments past their estimated delivery date.
 * Add to vercel.json: { "path": "/api/v1/cron/sla-breach-sweep", "schedule": "0 * /2 * * *" }
 * (every 2 hours — remove space in * /2)
 */
const { runSLABreachSweep } = require('../services/slaBreachScheduler.service');
router.post('/sla-breach-sweep', verifyCronSecret, async (req, res) => {
  try {
    const result = await runSLABreachSweep();
    return res.json({ ok: true, alerted: result.alerted });
  } catch (err) {
    console.error('[Cron] sla-breach-sweep failed:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
