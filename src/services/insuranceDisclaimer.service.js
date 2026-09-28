// ─── src/services/insuranceDisclaimer.service.js ─────────────────────────────
// V1 Feature 7 — one place that knows how to read the currently effective
// uninsured-risk disclaimer and how to record a customer's acknowledgment.
//
// The consent record stores a SNAPSHOT (version, full body text, liability
// limit, declared value) rather than only a version pointer, so an admin can
// edit or delete a disclaimer later without destroying the record of exactly
// what a customer agreed to at booking time.
const { prisma } = require("../config/db");

async function getCurrentDisclaimer() {
  return prisma.insuranceDisclaimer.findFirst({
    where: { effectiveFrom: { lte: new Date() } },
    orderBy: { effectiveFrom: "desc" },
  });
}

async function recordUninsuredAck({ userId, shipmentId, declaredValueKobo, req }) {
  try {
    const disclaimer = await getCurrentDisclaimer();
    await prisma.consentLog.create({
      data: {
        userId: userId || null,
        consentType: "UNINSURED_ACK",
        tcVersion: disclaimer?.version || process.env.TC_VERSION || "v1.0",
        referenceId: shipmentId,
        metadata: {
          declaredValueKobo: declaredValueKobo ?? null,
          disclaimerVersion: disclaimer?.version ?? null,
          disclaimerBody: disclaimer?.body ?? null,
          liabilityLimitKobo: disclaimer?.liabilityLimitKobo ?? null,
        },
        ipAddress: req?.ip || req?.headers?.["x-forwarded-for"] || null,
        userAgent: req?.headers?.["user-agent"] || null,
      },
    });
  } catch (err) {
    // Non-blocking — consent logging must never break a booking.
    console.error("[Consent] Failed to record UNINSURED_ACK:", err.message);
  }
}

module.exports = { getCurrentDisclaimer, recordUninsuredAck };
