// ─── shipmentDraft.controller.js ─────────────────────────────────────────────
// V1 Feature 8 — "Review shipment before it is created." Clicking Book no
// longer creates a Shipment directly: it opens the booking-details step
// (this draft), then the review screen, and the Shipment is created only on
// POST /shipment-drafts/{draftId}/confirm. Nothing — no shipment, tracking
// ID, or payment intent — exists before that call succeeds.
//
// A draft's `details` JSON carries everything gathered on the booking-details
// step: sender/recipient info, V1 Feature 3 (sender type + principal), V1
// Feature 4 (alternative phone numbers), pickup date, notes, promo code, and
// the V1 Feature 7 uninsured-risk acknowledgment tick.
const { prisma } = require("../config/db");
const { assertOfferingSellable } = require("../services/pricing.service");
const {
  pricingBlock,
  shipmentSnapshotFields,
  estimatedDeliveryFor,
} = require("../services/quoteSnapshot");
const { recordUninsuredAck } = require("../services/insuranceDisclaimer.service");
const { recordPromoRedemption } = require("./promoCode.controller");
const { notify } = require("../services/notify.service");
const { ApiError } = require("../utils/ApiError");
const { assertOwnedResourceAccess } = require("../utils/access");
const {
  success,
  created,
  generateTrackingNumber,
} = require("../utils/helpers");

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RELATIONSHIPS = ["CUSTOMER", "MERCHANT", "EMPLOYER", "OTHER"];

function isValidNgPhone(phone) {
  if (!phone) return false;
  const p = String(phone).trim();
  return /^\+234\d{10}$/.test(p) || /^0\d{10}$/.test(p);
}

// ─── Validate the booking-details payload (shared by create + confirm) ──────
function validateDetails(details, { forConfirm = false } = {}) {
  const errors = [];
  const senderType = details.senderType || "MYSELF";
  if (!["MYSELF", "ON_BEHALF_OF"].includes(senderType)) {
    errors.push("senderType must be MYSELF or ON_BEHALF_OF");
  }

  if (senderType === "ON_BEHALF_OF") {
    if (!details.principalName) errors.push("principalName is required for ON_BEHALF_OF");
    if (!details.principalPhone) errors.push("principalPhone is required for ON_BEHALF_OF");
    if (!details.principalRelationship || !RELATIONSHIPS.includes(details.principalRelationship)) {
      errors.push(`principalRelationship must be one of ${RELATIONSHIPS.join(", ")}`);
    }
    if (!details.authorityConfirmed) {
      errors.push('You must tick "I am authorised to send these items on their behalf"');
    }
  }

  // Recipient alt phone is always required; sender alt phone is optional.
  if (!details.recipientAltPhone) {
    errors.push("recipientAltPhone is required");
  } else if (!isValidNgPhone(details.recipientAltPhone)) {
    errors.push("recipientAltPhone must be a valid Nigerian number (+234XXXXXXXXXX or 0XXXXXXXXXX)");
  } else if (details.recipientAltPhone === details.recipientPhone) {
    errors.push("Alternative number must be different from the main number (recipient)");
  }

  if (details.senderAltPhone) {
    if (!isValidNgPhone(details.senderAltPhone)) {
      errors.push("senderAltPhone must be a valid Nigerian number (+234XXXXXXXXXX or 0XXXXXXXXXX)");
    }
    const mainSenderNumber = senderType === "ON_BEHALF_OF" ? details.principalPhone : details.senderPhone;
    if (details.senderAltPhone === mainSenderNumber) {
      errors.push("Alternative number must be different from the main number (sender)");
    }
  }

  if (forConfirm && !details.insuranceOn && !details.uninsuredAck) {
    errors.push('You must tick "I understand the risk of shipping without insurance"');
  }

  if (errors.length > 0) throw new ApiError(forConfirm ? 422 : 400, errors.join("; "), errors);
}

// ─── Build the full review payload for a draft ───────────────────────────────
async function buildReviewPayload(draft) {
  const quote = await prisma.quote.findUnique({
    where: { id: draft.quoteId },
    include: { adhocCharges: { where: { status: { in: ["APPLIED", "APPROVED"] } } } },
  });
  if (!quote) throw new ApiError(404, "Linked quote no longer exists");

  const now = new Date();
  const quoteExpired = quote.status === "EXPIRED" || (quote.status === "GENERATED" && now > quote.expiresAt);
  const draftExpired = draft.status === "EXPIRED" || now - draft.createdAt > DRAFT_TTL_MS;

  return {
    draftId: draft.id,
    status: draftExpired ? "EXPIRED" : draft.status,
    createdAt: draft.createdAt,
    details: draft.details,
    quote: {
      id: quote.id,
      status: quoteExpired ? "EXPIRED" : quote.status,
      expiresAt: quote.expiresAt,
      expiresInSeconds: quoteExpired ? 0 : Math.max(0, Math.floor((quote.expiresAt - now) / 1000)),
      offeringId: quote.offeringId,
      shipmentMode: quote.shipmentMode,
      deliveryEstimate:
        quote.slaMinDays !== null && quote.slaMinDays !== undefined
          ? { minDays: quote.slaMinDays, maxDays: quote.slaMaxDays, label: quote.slaLabel, source: "SNAPSHOT" }
          : null,
      pricingMode: quote.pricingMode,
      originCity: quote.originCity,
      destinationCity: quote.destinationCity,
      billableWeightKg: quote.billableWeightKg,
      lengthCm: quote.lengthCm,
      widthCm: quote.widthCm,
      heightCm: quote.heightCm,
      serviceType: quote.serviceType,
      declaredValueNaira: quote.declaredValueKobo ? quote.declaredValueKobo / 100 : null,
      insuranceSelected: quote.insuranceSelected,
      // Explicit components straight from the persisted quote.
      pricing: pricingBlock(quote),
      surchargeBreakdown: quote.surchargeBreakdown,
      adhocCharges: quote.adhocCharges.map((c) => ({
        name: c.nameSnapshot,
        reason: c.reason,
        amountNaira: c.amountKobo / 100,
      })),
    },
    quoteExpired,
    draftExpired,
  };
}

// ─── Create a draft (Sprint 3D / booking-details step) ───────────────────────
async function createDraft(req, res) {
  const { quoteId, ...details } = req.body;
  if (!quoteId) throw new ApiError(400, "quoteId is required");

  const quote = await prisma.quote.findUnique({ where: { id: quoteId } });
  if (!quote) throw new ApiError(404, "Quote not found");
  if (quote.userId && quote.userId !== req.user.id) {
    throw new ApiError(403, "This quote does not belong to your account");
  }
  if (quote.status !== "GENERATED") {
    throw new ApiError(400, `Quote is not bookable (status: ${quote.status})`);
  }
  if (new Date() > quote.expiresAt) {
    await prisma.quote.update({ where: { id: quoteId }, data: { status: "EXPIRED" } });
    throw new ApiError(400, "This quote has expired (15-minute limit). Please generate a new quote.");
  }

  const normalizedDetails = {
    senderType: "MYSELF",
    ...details,
    insuranceOn: !!quote.insuranceSelected,
  };
  validateDetails(normalizedDetails, { forConfirm: false });

  const draft = await prisma.shipmentDraft.create({
    data: {
      userId: req.user.id,
      quoteId,
      details: normalizedDetails,
      status: "DRAFT",
    },
  });

  // [V1 Feature 3] Log the "I am authorised to send on their behalf" tick.
  if (normalizedDetails.senderType === "ON_BEHALF_OF" && normalizedDetails.authorityConfirmed) {
    prisma.consentLog
      .create({
        data: {
          userId: req.user.id,
          consentType: "ON_BEHALF_AUTHORITY",
          tcVersion: process.env.TC_VERSION || "v1.0",
          referenceId: draft.id,
          metadata: {
            principalName: normalizedDetails.principalName,
            principalRelationship: normalizedDetails.principalRelationship,
          },
          ipAddress: req.ip || req.headers["x-forwarded-for"] || null,
          userAgent: req.headers["user-agent"] || null,
        },
      })
      .catch((err) => console.error("[ShipmentDraft] Failed to log ON_BEHALF_AUTHORITY:", err.message));
  }

  const payload = await buildReviewPayload(draft);
  return created(res, payload, "Shipment draft created");
}

// ─── Get the full review payload ─────────────────────────────────────────────
async function getDraft(req, res) {
  const { id } = req.params;
  const draft = await prisma.shipmentDraft.findUnique({ where: { id } });
  if (!draft) throw new ApiError(404, "Shipment draft not found");
  await assertOwnedResourceAccess(req.user, draft.userId, { resource: "ShipmentDraft", resourceId: id, req });

  const payload = await buildReviewPayload(draft);
  return success(res, payload);
}

// ─── Edit one section from the review screen (data kept, per PRD) ──────────
async function patchDraft(req, res) {
  const { id } = req.params;
  const draft = await prisma.shipmentDraft.findUnique({ where: { id } });
  if (!draft) throw new ApiError(404, "Shipment draft not found");
  if (draft.userId !== req.user.id) throw new ApiError(403, "This draft does not belong to your account");
  if (draft.status !== "DRAFT") throw new ApiError(400, `Cannot edit a draft with status ${draft.status}`);

  const { quoteId, ...detailPatch } = req.body;

  const data = {};
  if (quoteId && quoteId !== draft.quoteId) {
    // e.g. after POST /quotes/{id}/refresh, or the user changed mode/weight
    // and generated a brand new quote — repoint the draft, keep every other
    // detail entered.
    const newQuote = await prisma.quote.findUnique({ where: { id: quoteId } });
    if (!newQuote) throw new ApiError(404, "Replacement quote not found");
    // A draft may only be re-pointed at a quote the same customer owns that is
    // still bookable (this used to accept any quote id).
    if (newQuote.userId && newQuote.userId !== req.user.id) {
      throw new ApiError(403, "This quote does not belong to your account");
    }
    if (newQuote.status !== "GENERATED" || new Date() > newQuote.expiresAt) {
      throw new ApiError(400, "The replacement quote is not bookable (expired or already used)");
    }
    data.quoteId = quoteId;
  }

  const mergedDetails = { ...draft.details, ...detailPatch };
  data.details = mergedDetails;

  const updated = await prisma.shipmentDraft.update({ where: { id }, data });
  const payload = await buildReviewPayload(updated);
  return success(res, payload, "Draft updated");
}

// ─── Confirm — the only place a real Shipment gets created (V1 Feature 8) ──
async function confirmDraft(req, res) {
  const { id } = req.params;
  const idempotencyKey = req.headers["idempotency-key"];

  const draft = await prisma.shipmentDraft.findUnique({ where: { id } });
  if (!draft) throw new ApiError(404, "Shipment draft not found");
  if (draft.userId !== req.user.id) throw new ApiError(403, "This draft does not belong to your account");

  // ─── Idempotent replay: a double tap creates one shipment ─────────────────
  if (draft.status === "CONFIRMED") {
    if (draft.shipmentId) {
      const shipment = await prisma.shipment.findUnique({ where: { id: draft.shipmentId } });
      return success(res, { shipment, replayed: true }, "Shipment already created");
    }
    throw new ApiError(409, "Draft already confirmed but its shipment could not be found");
  }

  if (draft.status === "EXPIRED" || Date.now() - draft.createdAt.getTime() > DRAFT_TTL_MS) {
    if (draft.status !== "EXPIRED") {
      await prisma.shipmentDraft.update({ where: { id }, data: { status: "EXPIRED" } });
    }
    throw new ApiError(400, "This draft has expired (24-hour limit). Please start booking again.");
  }

  const quote = await prisma.quote.findUnique({
    where: { id: draft.quoteId },
    include: { adhocCharges: { where: { status: { in: ["APPLIED", "APPROVED"] } } } },
  });
  if (!quote) throw new ApiError(404, "Linked quote no longer exists");

  if (quote.status === "GENERATED" && new Date() > quote.expiresAt) {
    await prisma.quote.update({ where: { id: quote.id }, data: { status: "EXPIRED" } });
    throw new ApiError(400, "Quote expired, generate new quote");
  }
  if (quote.status !== "GENERATED") {
    throw new ApiError(400, `This quote has already been used (status: ${quote.status}). Please generate a new quote.`);
  }

  // Only AVAILABILITY is re-checked (the product must still be offered). The
  // price, breakdown, SLA and product are the locked quote's — never re-derived
  // from today's rates. A customer who saw ₦X on a live quote is charged ₦X.
  if (!quote.shipmentMode) {
    throw new ApiError(400, "This quote predates shipping options. Please generate a new quote.", null, "LEGACY_QUOTE");
  }
  await assertOfferingSellable({
    offeringId: quote.offeringId,
    shipmentMode: quote.shipmentMode,
    serviceType: quote.serviceType,
  });

  const details = { ...draft.details, insuranceOn: !!quote.insuranceSelected };
  validateDetails(details, { forConfirm: true });

  // ─── Cut-off: after 2PM WAT, earliest pickup is next business day ────────
  let resolvedPickupDate = details.pickupDate ? new Date(details.pickupDate) : new Date();
  let cutoffWarning = false;
  try {
    const nowWAT = new Date(new Date().toLocaleString("en-US", { timeZone: "Africa/Lagos" }));
    if (nowWAT.getHours() >= 14) {
      cutoffWarning = true;
      if (!details.pickupDate) {
        const next = new Date(nowWAT);
        next.setDate(next.getDate() + 1);
        while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
        resolvedPickupDate = next;
      }
    }
  } catch (_) {
    /* non-fatal */
  }

  const estimatedDelivery = await estimatedDeliveryFor(quote, resolvedPickupDate);

  const senderType = details.senderType || "MYSELF";

  const shipment = await prisma.shipment.create({
    data: {
      trackingNumber: generateTrackingNumber(),
      customerId: req.user.id,
      senderName: details.senderName,
      senderPhone: details.senderPhone,
      senderAddress: details.senderAddress,
      senderCity: quote.originCity,
      senderState: details.senderState,
      recipientName: details.recipientName,
      recipientPhone: details.recipientPhone,
      recipientAddress: details.recipientAddress,
      recipientCity: quote.destinationCity,
      recipientState: details.recipientState,
      description: details.description || null,
      weight: quote.billableWeightKg ?? quote.weightKg,
      weightUnit: details.weightUnit || "KG",
      cartons: details.cartons ? parseInt(details.cartons, 10) : null,
      customLength: quote.lengthCm,
      customWidth: quote.widthCm,
      customHeight: quote.heightCm,
      fromCityId: quote.originCityId,
      toCityId: quote.destinationCityId,
      zone: quote.zone,
      distanceKm: quote.distanceKm,
      serviceType: quote.serviceType,
      quotedPrice: quote.totalPriceKobo / 100,
      // Locked commercial snapshot: product, SLA, priced breakdown (used by
      // invoices / booking confirmation / shipment views).
      ...shipmentSnapshotFields(quote),
      isFragile: !!details.isFragile,
      requiresInsurance: !!quote.insuranceSelected,
      insuranceValue: quote.insuranceSelected && quote.declaredValueKobo ? quote.declaredValueKobo / 100 : null,
      notes: details.notes || null,
      pickupDate: resolvedPickupDate,
      estimatedDelivery,
      // ── V1 launch scope fields ─────────────────────────────────────────
      shipmentMode: quote.shipmentMode,
      declaredValueKobo: quote.declaredValueKobo,
      insuranceSelected: !!quote.insuranceSelected,
      uninsuredAckAt: !quote.insuranceSelected ? new Date() : null,
      senderType,
      principalName: senderType === "ON_BEHALF_OF" ? details.principalName : null,
      principalPhone: senderType === "ON_BEHALF_OF" ? details.principalPhone : null,
      principalEmail: senderType === "ON_BEHALF_OF" ? details.principalEmail || null : null,
      principalRelationship: senderType === "ON_BEHALF_OF" ? details.principalRelationship : null,
      authorityConfirmed: senderType === "ON_BEHALF_OF" ? !!details.authorityConfirmed : false,
      senderAltPhone: details.senderAltPhone || null,
      recipientAltPhone: details.recipientAltPhone,
      trackingHistory: {
        create: {
          status: "PENDING",
          description: "Shipment booked and awaiting payment",
          updatedBy: req.user.id,
        },
      },
    },
    include: {
      trackingHistory: true,
      fromCity: { select: { id: true, name: true, region: true, state: true } },
      toCity: { select: { id: true, name: true, region: true, state: true } },
    },
  });

  await prisma.quote.update({
    where: { id: quote.id },
    data: { status: "BOOKED", bookedAt: new Date(), shipmentId: shipment.id },
  });

  // [V1] Move this quote's billable adhoc charge lines onto the new shipment
  // (kept linked to the quote too, for traceability).
  if (quote.adhocCharges.length > 0) {
    await prisma.shipmentAdhocCharge.updateMany({
      where: { id: { in: quote.adhocCharges.map((c) => c.id) } },
      data: { shipmentId: shipment.id },
    });
  }

  await prisma.shipmentDraft.update({
    where: { id },
    data: { status: "CONFIRMED", shipmentId: shipment.id, idempotencyKey: idempotencyKey || null },
  });

  // ─── Consents (fire-and-forget) ────────────────────────────────────────
  const consentBase = {
    ipAddress: req.ip || req.headers["x-forwarded-for"] || null,
    userAgent: req.headers["user-agent"] || null,
    tcVersion: process.env.TC_VERSION || "v1.0",
  };
  prisma.consentLog
    .create({
      data: { userId: req.user.id, consentType: "SHIPPING_RULES", referenceId: shipment.id, ...consentBase },
    })
    .catch(() => {});
  if (quote.insuranceSelected) {
    prisma.consentLog
      .create({
        data: { userId: req.user.id, consentType: "INSURANCE_TERMS", referenceId: shipment.id, ...consentBase },
      })
      .catch(() => {});
  } else {
    // [V1 Feature 7] Uninsured risk acknowledgment — immutable, stored with
    // a snapshot of the disclaimer text/limit in force at booking time.
    recordUninsuredAck({
      userId: req.user.id,
      shipmentId: shipment.id,
      declaredValueKobo: quote.declaredValueKobo,
      req,
    });
  }

  if (quote.pricingMode === "PROMO" && quote.promoCode) {
    recordPromoRedemption(
      quote.promoCode,
      req.user.id,
      shipment.id,
      (quote.promoDiscountKobo || 0) / 100,
    ).catch((err) => console.error("[ShipmentDraft] recordPromoRedemption failed:", err.message));
  }

  // ─── Booking Confirmed notification — [V1] also to the principal when
  // sending ON_BEHALF_OF (the account holder always gets it too) ──────────
  const notification = await prisma.notification.create({
    data: {
      userId: req.user.id,
      type: "SHIPMENT_UPDATE",
      title: "Booking Confirmed",
      body: `Your ${{ AIR: "Air", LAND: "Land", SEA: "Sea" }[shipment.shipmentMode]} freight shipment ${shipment.trackingNumber} has been booked. ${cutoffWarning ? "Booked after 2PM — earliest pickup is next business day." : ""}`,
      data: { shipmentId: shipment.id, trackingNumber: shipment.trackingNumber, shipmentMode: shipment.shipmentMode },
    },
  });
  notify(req.user.id, notification);

  return created(
    res,
    { shipment, quote, cutoffWarning },
    cutoffWarning
      ? "Shipment created. Booking after 2PM — earliest pickup is next business day."
      : "Shipment created successfully",
  );
}

module.exports = { createDraft, getDraft, patchDraft, confirmDraft };
