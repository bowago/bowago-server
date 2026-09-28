// ─── adhocSuggestion.controller.js ───────────────────────────────────────────
// V1 Feature 6 — the admin queue of SUGGEST-behaviour rule matches, and the
// approve/edit/dismiss decision on each.
//
// Two very different situations land in this same queue:
//   1. Pre-booking (charge.quoteId set): the customer hasn't paid anything
//      yet. Approving simply marks the charge APPROVED so it's included as a
//      billable line when the quote's shipment draft is confirmed.
//   2. Post-booking (charge.shipmentId set, from a warehouse re-weigh): the
//      customer has already been charged the original total. Per PRD Sprint
//      8 ("there are no silent increases"), approving here does NOT bill the
//      customer directly — it raises a PriceAdjustment, pauses the shipment
//      (PENDING_ADMIN_REVIEW) and starts the same 24h customer-approval
//      window the weight-discrepancy flow already uses.
const { prisma } = require("../config/db");
const { ApiError } = require("../utils/ApiError");
const { success, getPagination, buildMeta } = require("../utils/helpers");
const { getNumberSetting } = require("../services/settings.service");
const { notify } = require("../services/notify.service");

// ─── Admin: list the suggestion queue ─────────────────────────────────────────
async function listSuggestions(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { scope } = req.query; // "quote" | "shipment" | undefined (both)

  const where = {
    status: "SUGGESTED",
    ...(scope === "quote" && { quoteId: { not: null } }),
    ...(scope === "shipment" && { shipmentId: { not: null } }),
  };

  const [suggestions, total] = await Promise.all([
    prisma.shipmentAdhocCharge.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        chargeType: { select: { id: true, name: true, calcMethod: true } },
        rule: { select: { id: true, name: true } },
        quote: { select: { id: true, originCity: true, destinationCity: true, userId: true } },
        shipment: {
          select: { id: true, trackingNumber: true, customerId: true, status: true, quotedPrice: true },
        },
      },
    }),
    prisma.shipmentAdhocCharge.count({ where }),
  ]);

  return res.json({ success: true, data: { suggestions }, meta: buildMeta(total, page, limit) });
}

// ─── Admin: approve / edit / dismiss a suggestion ────────────────────────────
async function decideSuggestion(req, res) {
  const { id } = req.params;
  const { decision, amountKobo, reason } = req.body;

  if (!["APPROVE", "EDIT", "DISMISS"].includes(decision)) {
    throw new ApiError(400, "decision must be one of APPROVE, EDIT, DISMISS");
  }
  if (decision === "EDIT" && (!amountKobo || amountKobo <= 0)) {
    throw new ApiError(400, "amountKobo is required and must be greater than 0 for decision EDIT");
  }

  const charge = await prisma.shipmentAdhocCharge.findUnique({
    where: { id },
    include: { chargeType: true, shipment: true, quote: true },
  });
  if (!charge) throw new ApiError(404, "Adhoc suggestion not found");
  if (charge.status !== "SUGGESTED") {
    throw new ApiError(400, `This suggestion has already been decided (status: ${charge.status})`);
  }

  // ─── Dismiss — reversed, nothing charged, shipment/quote untouched ────────
  if (decision === "DISMISS") {
    if (!reason) throw new ApiError(400, "reason is required to dismiss a suggestion");
    const updated = await prisma.shipmentAdhocCharge.update({
      where: { id },
      data: {
        status: "DISMISSED",
        decidedByUserId: req.user.id,
        decisionReason: reason,
      },
    });
    await logDecision(req.user.id, id, "DISMISS", reason);
    return success(res, { charge: updated }, "Adhoc suggestion dismissed");
  }

  const finalAmountKobo = decision === "EDIT" ? parseInt(amountKobo, 10) : charge.amountKobo;
  const finalVatKobo = charge.chargeType.vatApplicable
    ? Math.round(finalAmountKobo * 0.075)
    : 0;

  // ─── Pre-booking (still just a quote) — approve straight onto the quote ──
  if (charge.quoteId && !charge.shipmentId) {
    const updated = await prisma.shipmentAdhocCharge.update({
      where: { id },
      data: {
        status: "APPROVED",
        amountKobo: finalAmountKobo,
        vatKobo: finalVatKobo,
        decidedByUserId: req.user.id,
        decisionReason: reason || null,
      },
    });
    await logDecision(req.user.id, id, decision, reason);
    return success(res, { charge: updated }, "Adhoc suggestion approved onto the quote");
  }

  // ─── Post-booking — route through the price-shock / pause flow ──────────
  if (!charge.shipmentId) throw new ApiError(400, "Suggestion is not linked to a quote or shipment");

  const shipment = charge.shipment;
  if (["DELIVERED", "CANCELLED", "RETURNED"].includes(shipment.status)) {
    throw new ApiError(400, `Cannot add a charge to a shipment with status ${shipment.status}`);
  }

  const windowHours = await getNumberSetting("price_adjustment.response_window_hours");
  const responseDeadline = new Date(Date.now() + windowHours * 60 * 60 * 1000);
  const newTotal = shipment.quotedPrice + finalAmountKobo / 100;

  const adjustment = await prisma.priceAdjustment.create({
    data: {
      shipmentId: shipment.id,
      originalPrice: shipment.quotedPrice,
      adjustedPrice: newTotal,
      difference: finalAmountKobo / 100,
      reason: reason || charge.reason || `Adhoc charge: ${charge.chargeType.name}`,
      status: "PENDING",
      previousStatus: shipment.status,
      responseDeadline,
      adhocChargeIds: [charge.id],
    },
  });

  await prisma.shipmentAdhocCharge.update({
    where: { id },
    data: {
      status: "PENDING_CUSTOMER_APPROVAL",
      amountKobo: finalAmountKobo,
      vatKobo: finalVatKobo,
      decidedByUserId: req.user.id,
      decisionReason: reason || null,
    },
  });

  await prisma.shipment.update({
    where: { id: shipment.id },
    data: { status: "PENDING_ADMIN_REVIEW" },
  });

  await prisma.trackingEvent.create({
    data: {
      shipmentId: shipment.id,
      status: "PENDING_ADMIN_REVIEW",
      description: `Shipment paused — additional charge "${charge.chargeType.name}" needs your approval.`,
      updatedBy: req.user.id,
    },
  });

  const notification = await prisma.notification.create({
    data: {
      userId: shipment.customerId,
      type: "PRICE_ADJUSTMENT",
      title: "Action Required: Additional Charge",
      body: `Your shipment ${shipment.trackingNumber} has an additional charge of ₦${(finalAmountKobo / 100).toLocaleString()} (${charge.chargeType.name}). You have ${windowHours} hours to respond.`,
      data: { shipmentId: shipment.id, adjustmentId: adjustment.id, chargeId: charge.id },
    },
  });
  notify(shipment.customerId, notification);

  await logDecision(req.user.id, id, decision, reason);

  return success(
    res,
    { charge: { ...charge, status: "PENDING_CUSTOMER_APPROVAL", amountKobo: finalAmountKobo }, adjustment },
    "Adhoc suggestion approved — shipment paused pending customer approval",
  );
}

async function logDecision(userId, chargeId, decision, reason) {
  await prisma.priceAuditLog
    .create({
      data: {
        entityType: "AdhocSuggestionDecision",
        entityId: chargeId,
        action: decision,
        changedBy: userId,
        reason: reason || null,
      },
    })
    .catch((err) => console.error("[AdhocSuggestion] Failed to log decision:", err.message));
}

module.exports = { listSuggestions, decideSuggestion };
