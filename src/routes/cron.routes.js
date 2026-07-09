// cron.routes.js — Upstash QStash scheduled job endpoints
//
// These endpoints are no longer triggered by Vercel Cron Jobs (Hobby plan
// only allows once-per-day schedules, which was too slow for these jobs).
// Instead, Upstash QStash calls these URLs on a schedule you configure in
// the Upstash Console (see setup notes at the bottom of this file).
//
// QStash signs every request with a JWT in the `Upstash-Signature` header.
// We verify that signature instead of a static secret, so only genuine
// QStash deliveries can trigger these jobs. Verification needs the RAW
// request body — see the `/api/v1/cron` raw-body middleware in app.js,
// which must run BEFORE express.json() for this to work.

const router = require("express").Router();
const { Receiver } = require("@upstash/qstash");
const {
  runExpiredAdjustmentSweep,
} = require("../services/priceAdjustmentScheduler.service");
const { runEscalationJob } = require("../controllers/support.controller");
const { runSLABreachSweep } = require("../services/slaBreachScheduler.service");
const { expireStaleQuotes } = require("../controllers/quote.controller");

const receiver =
  process.env.QSTASH_CURRENT_SIGNING_KEY && process.env.QSTASH_NEXT_SIGNING_KEY
    ? new Receiver({
        currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
        nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
      })
    : null;

async function verifyQStashSignature(req, res, next) {
  if (!receiver) {
    // No signing keys configured yet — block in production, allow in dev
    // so you can still hit these routes manually with curl/Postman locally.
    if (process.env.NODE_ENV === "production") {
      return res
        .status(403)
        .json({ error: "QStash signing keys not configured" });
    }
    return next();
  }

  const signature = req.headers["upstash-signature"];
  if (!signature) {
    return res.status(401).json({ error: "Missing Upstash-Signature header" });
  }

  try {
    const isValid = await receiver.verify({
      signature,
      body: req.rawBody ?? "",
    });
    if (!isValid) {
      return res.status(401).json({ error: "Invalid QStash signature" });
    }
    return next();
  } catch (err) {
    console.error("[Cron] QStash signature verification failed:", err.message);
    return res.status(401).json({ error: "Invalid QStash signature" });
  }
}

/**
 * POST /api/v1/cron/expire-quotes
 * Marks GENERATED quotes past their 15-minute expiry as EXPIRED and creates
 * the PRD "Quote Expired" in-app notification for logged-in owners.
 * Suggested QStash schedule: every 5 minutes → "*\/5 * * * *"
 */
router.post("/expire-quotes", verifyQStashSignature, async (req, res) => {
  try {
    const count = await expireStaleQuotes();
    return res.json({ ok: true, expired: count });
  } catch (err) {
    console.error("[Cron] expire-quotes failed:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/v1/cron/sweep-price-adjustments
 * Auto-cancels price adjustments whose response deadline has passed.
 * Suggested QStash schedule: every hour → "0 * * * *"
 */
router.post(
  "/sweep-price-adjustments",
  verifyQStashSignature,
  async (req, res) => {
    try {
      const result = await runExpiredAdjustmentSweep();
      return res.json({ ok: true, processed: result.processed });
    } catch (err) {
      console.error("[Cron] sweep-price-adjustments failed:", err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  },
);

/**
 * POST /api/v1/cron/escalate-tickets
 * Escalates stale support tickets that have been IN_PROGRESS for > 4 hours.
 * Suggested QStash schedule: every 4 hours ("0 0,4,8,12,16,20 * * *")
 */
router.post("/escalate-tickets", verifyQStashSignature, async (req, res) => {
  try {
    const result = await runEscalationJob();
    return res.json({ ok: true, escalated: result.escalated });
  } catch (err) {
    console.error("[Cron] escalate-tickets failed:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/v1/cron/sla-breach-sweep
 * Sends delay alerts for overdue shipments past their estimated delivery date.
 * Suggested QStash schedule: every 6 hours ("0 0,6,12,18 * * *")
 */
router.post("/sla-breach-sweep", verifyQStashSignature, async (req, res) => {
  try {
    const result = await runSLABreachSweep();
    return res.json({ ok: true, alerted: result.alerted });
  } catch (err) {
    console.error("[Cron] sla-breach-sweep failed:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
