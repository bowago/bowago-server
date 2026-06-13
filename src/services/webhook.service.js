const { prisma } = require('../config/db');

// ============================================================================
// Webhook retry + Dead Letter Queue
// ============================================================================
// Paystack webhooks are ACK'd with 200 immediately (so Paystack doesn't retry
// on its own schedule), then processed here with our own retry logic:
//
//   Attempt 1 → immediate
//   Attempt 2 → after 1s
//   Attempt 3 → after 2s
//   Attempt 4 → after 4s
//   Attempt 5 → after 8s
//   Attempt 6 → after 16s
//
// If all 6 attempts fail, the event is written to the FailedWebhook table
// (the "Dead Letter Queue") for manual review/replay by an admin instead of
// being silently dropped via console.error.
//
// NOTE: this is an in-process retry (setTimeout-based). It's adequate for an
// MVP — if the server restarts mid-retry-cycle, the in-flight retries are
// lost, but any event that exhausts its retries (or was mid-retry at
// shutdown and never gets a chance to finish) should be picked up by running
// `requeueStuckWebhooks()` on boot, which retries anything still PENDING.
// ============================================================================

const MAX_ATTEMPTS = 6;
const BACKOFF_MS = [0, 1000, 2000, 4000, 8000, 16000]; // index = attempt - 1

/**
 * Process a webhook event with retry + DLQ fallback.
 *
 * @param {string} event - e.g. "charge.success"
 * @param {object} payload - the full webhook body (for DLQ replay)
 * @param {() => Promise<void>} handler - the actual processing function
 */
async function processWebhookWithRetry(event, payload, handler) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await sleep(BACKOFF_MS[attempt - 1]);
    }

    try {
      await handler();
      console.log(`✅ Webhook "${event}" processed successfully (attempt ${attempt}/${MAX_ATTEMPTS})`);
      return; // success — done
    } catch (err) {
      console.error(`⚠️  Webhook "${event}" attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);

      if (attempt === MAX_ATTEMPTS) {
        // All retries exhausted — move to Dead Letter Queue
        await sendToDeadLetterQueue(event, payload, err.message);
        return;
      }
    }
  }
}

async function sendToDeadLetterQueue(event, payload, errorMessage) {
  try {
    await prisma.failedWebhook.create({
      data: {
        event,
        payload,
        errorMessage,
        attempts: MAX_ATTEMPTS,
        status: 'FAILED',
      },
    });
    console.error(`💀 Webhook "${event}" moved to Dead Letter Queue after ${MAX_ATTEMPTS} attempts`);
  } catch (dlqErr) {
    // Last-resort log if even the DLQ write fails (e.g. table missing)
    console.error('Failed to write to webhook DLQ:', dlqErr.message);
    console.error('Original webhook payload:', JSON.stringify(payload));
  }
}

/**
 * Replay a single DLQ entry (called from the admin "Retry" button).
 * Returns { success, error? }.
 */
async function replayDeadLetter(id, handlerMap) {
  const entry = await prisma.failedWebhook.findUnique({ where: { id } });
  if (!entry) throw new Error('DLQ entry not found');

  const handler = handlerMap[entry.event];
  if (!handler) throw new Error(`No handler registered for event "${entry.event}"`);

  try {
    await handler(entry.payload);
    await prisma.failedWebhook.update({
      where: { id },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    });
    return { success: true };
  } catch (err) {
    await prisma.failedWebhook.update({
      where: { id },
      data: {
        attempts: { increment: 1 },
        errorMessage: err.message,
        lastRetriedAt: new Date(),
      },
    });
    return { success: false, error: err.message };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  processWebhookWithRetry,
  sendToDeadLetterQueue,
  replayDeadLetter,
  MAX_ATTEMPTS,
};
