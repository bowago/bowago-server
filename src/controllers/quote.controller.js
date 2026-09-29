const crypto = require("crypto");
const { prisma } = require("../config/db");
const { calculateShippingCost, getOfferings } = require("../services/pricing.service");
const { buildAdhocRows } = require("../services/adhocCharge.service");
const { quoteColumns, pricingBlock } = require("../services/quoteSnapshot");
const { ApiError } = require("../utils/ApiError");
const { success, created } = require("../utils/helpers");

const QUOTE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const SHIPMENT_MODES = ["AIR", "LAND", "SEA"];
// Air/Sea show the dangerous-goods (batteries) notice from the Knowledge Base
// before the user continues — Land does not require it.
const DANGEROUS_GOODS_MODES = ["AIR", "SEA"];

// ─── Convert Naira to Kobo (avoid float errors per PRD) ──────────────────────
function toKobo(naira) {
  return Math.round(parseFloat(naira) * 100);
}

// ─── Sprint 7: Record user consent at quote time ─────────────────────────────
async function recordConsent(userId, sessionId, consentType, req, extra = {}) {
  try {
    await prisma.consentLog.create({
      data: {
        userId: userId || null,
        sessionId: sessionId || null,
        consentType,
        tcVersion: process.env.TC_VERSION || "v1.0",
        ipAddress: req.ip || req.headers["x-forwarded-for"] || null,
        userAgent: req.headers["user-agent"] || null,
        ...extra,
      },
    });
  } catch (err) {
    // Non-blocking — consent logging failure must not break the flow
    console.error("[Consent] Failed to record consent:", err.message);
  }
}

// declaredValue is always required, whether or not insurance is selected.
function assertDeclaredValue(declaredValue) {
  const value = parseFloat(declaredValue);
  if (!declaredValue || isNaN(value) || value <= 0) {
    throw new ApiError(
      400,
      "Value of items being sent (declaredValue) is required and must be greater than 0",
    );
  }
  return value;
}

// Map the HTTP body onto the pricing engine's request.
function toEngineRequest(body, userId, { mode, service } = {}) {
  return {
    fromCity: body.originCity,
    toCity: body.destinationCity,
    weightKg: body.weightKg,
    tons: body.tons,
    cartons: body.cartons,
    boxDimensionId: body.boxDimensionId || null,
    customLength: body.lengthCm,
    customWidth: body.widthCm,
    customHeight: body.heightCm,
    shipmentMode: mode,
    serviceType: service,
    isFragile: false,
    requiresInsurance: !!body.insuranceSelected,
    insuranceValue: body.declaredValue ? parseFloat(body.declaredValue) : null,
    promoCode: body.promoCode || null,
    userId,
  };
}

// A quote is for ONE product: mode + service (or an offeringId that names both).
// Nothing is defaulted — a request that does not say what it is buying is rejected.
async function resolveProduct(body) {
  const { shipmentMode, serviceType, offeringId } = body;
  if (Array.isArray(shipmentMode)) {
    throw new ApiError(
      400,
      "Provide a single shipping option. To compare options call POST /quotes/offerings.",
      null,
      "OFFERING_REQUIRED",
    );
  }
  if (offeringId) {
    const o = await prisma.serviceOffering.findUnique({ where: { id: offeringId } });
    if (!o) throw new ApiError(404, "Shipping option not found", null, "NOT_OFFERED");
    if ((shipmentMode && shipmentMode !== o.shipmentMode) || (serviceType && serviceType !== o.serviceType)) {
      throw new ApiError(400, "offeringId does not match the given shipmentMode/serviceType", null, "OFFERING_MISMATCH");
    }
    return { mode: o.shipmentMode, service: o.serviceType };
  }
  if (!shipmentMode || !serviceType) {
    throw new ApiError(
      400,
      `shipmentMode (${SHIPMENT_MODES.join(", ")}) and serviceType (EXPRESS, STANDARD, ECONOMY) are both required — or provide an offeringId`,
      null,
      "OFFERING_REQUIRED",
    );
  }
  return { mode: shipmentMode, service: serviceType };
}

// ─── POST /quotes/offerings (public) ─────────────────────────────────────────
// Every shipping product that is ACTUALLY available for this route + parcel,
// each with its own SLA, rate and full breakdown. Clients must render these —
// never generate a mode × service grid of their own.
async function getQuoteOfferings(req, res) {
  const body = req.body || {};
  if (!body.originCity || !body.destinationCity) {
    throw new ApiError(400, "originCity and destinationCity are required");
  }
  const userId = req.user?.id || null;
  const out = await getOfferings({
    ...toEngineRequest(body, userId, {}),
    shipmentMode: body.shipmentMode || undefined,
    serviceType: body.serviceType || undefined,
  });
  return success(
    res,
    {
      ...out,
      offerings: out.offerings.map((o) => ({
        ...o,
        requiresDangerousGoodsNotice: DANGEROUS_GOODS_MODES.includes(o.shipmentMode),
      })),
    },
    "Shipping options calculated",
  );
}

// ─── POST /quotes — generate & persist the official 15-minute quote ──────────
async function generateQuote(req, res) {
  const { originCity, destinationCity, declaredValue, termsAccepted, insuranceSelected } = req.body;

  if (!termsAccepted) {
    throw new ApiError(400, "You must accept the Terms of Service to generate a quote.");
  }
  const { mode, service } = await resolveProduct(req.body);
  const declaredValueNumber = assertDeclaredValue(declaredValue);
  const userId = req.user?.id || null;

  const engineReq = toEngineRequest(req.body, userId, { mode, service });
  const result = await calculateShippingCost(engineReq);

  const expiresAt = new Date(Date.now() + QUOTE_TTL_MS);
  const quoteId = crypto.randomUUID();
  const declaredValueKobo = toKobo(declaredValueNumber);

  // The quote and its ad-hoc lines are written atomically, from the SAME
  // engine evaluation that produced the total — no second evaluation, no
  // chance of a total that includes a charge with no line behind it.
  const adhocRows = buildAdhocRows({
    quoteId,
    autoApply: result.adhocEvaluation.autoApply,
    suggested: result.adhocEvaluation.suggested,
    vatRatePercent: result.taxRatePercent,
  });
  const ops = [
    prisma.quote.create({
      data: {
        id: quoteId,
        ...quoteColumns(result, engineReq, {
          userId, originCity, destinationCity, expiresAt, declaredValueKobo, insuranceSelected,
        }),
      },
    }),
  ];
  if (adhocRows.length > 0) ops.push(prisma.shipmentAdhocCharge.createMany({ data: adhocRows }));
  const [record] = await prisma.$transaction(ops);

  // Sprint 7: log TERMS_OF_SERVICE consent (fire-and-forget).
  recordConsent(userId, req.headers["x-session-id"] || null, "TERMS_OF_SERVICE", req);

  return created(
    res,
    {
      quoteId: record.id,
      status: record.status,
      expiresAt: record.expiresAt,
      expiresInSeconds: Math.floor(QUOTE_TTL_MS / 1000),
      origin: { city: originCity, id: result.fromCity.id },
      destination: { city: destinationCity, id: result.toCity.id },
      zone: result.zone,
      distanceKm: result.distanceKm,
      // The purchased product, unambiguously.
      offeringId: record.offeringId,
      shipmentMode: record.shipmentMode,
      serviceType: record.serviceType,
      displayName: result.displayName,
      deliveryEstimate: result.deliveryEstimate,
      billableWeightKg: result.billableWeightKg,
      measurements: result.measurements,
      requiresDangerousGoodsNotice: DANGEROUS_GOODS_MODES.includes(record.shipmentMode),
      declaredValueNaira: declaredValueNumber,
      // Explicit components — render these, never rebuild a subtotal from `total`.
      pricing: pricingBlock(record),
      surcharges: result.surcharges,
      adhocCharges: result.adhocCharges.map((a) => ({
        chargeTypeId: a.chargeTypeId,
        name: a.label,
        reason: a.description,
        amountKobo: a.amountKobo,
        amountNaira: a.amount,
        vatApplicable: a.vatApplicable,
      })),
      adhocSuggestionsPending: result.adhocSuggestions.length,
      surchargeBreakdown: record.surchargeBreakdown,
      pricingMode: result.pricingMode,
      appliedDiscount: result.appliedDiscount,
      promoStatus: result.promoStatus,
      currency: "NGN",
    },
    "Quote generated",
  );
}

// ─── Get Quote by ID ──────────────────────────────────────────────────────────
async function getQuote(req, res) {
  const { id } = req.params;
  const record = await prisma.quote.findUnique({
    where: { id },
    include: { adhocCharges: true },
  });
  if (!record) throw new ApiError(404, "Quote not found");

  // Expire if past TTL
  if (record.status === "GENERATED" && new Date() > record.expiresAt) {
    await prisma.quote.update({ where: { id }, data: { status: "EXPIRED" } });
    record.status = "EXPIRED";
  }

  return success(res, { quote: record, pricing: pricingBlock(record) });
}

// ─── Refresh an expired quote ────────────────────────────────────────────────
// Returns a fresh 15-minute quote for the same inputs and the SAME product, at
// current rates. The old quote stays EXPIRED; a shipment draft pointing at it
// should be re-pointed at the new quoteId (see shipmentDraft.controller.js).
async function refreshQuote(req, res) {
  const { id } = req.params;
  const old = await prisma.quote.findUnique({ where: { id } });
  if (!old) throw new ApiError(404, "Quote not found");

  if (
    old.userId &&
    req.user &&
    old.userId !== req.user.id &&
    req.user.role !== "ADMIN"
  ) {
    throw new ApiError(403, "This quote does not belong to your account");
  }
  if (old.status === "BOOKED") {
    throw new ApiError(400, "This quote has already been booked");
  }
  // A legacy quote never recorded which product it priced. Guessing one would
  // silently change what the customer is buying.
  if (!old.shipmentMode) {
    throw new ApiError(
      400,
      "This quote predates shipping options and cannot be refreshed. Please generate a new quote.",
      null,
      "LEGACY_QUOTE",
    );
  }

  if (old.status === "GENERATED" && new Date() > old.expiresAt) {
    await prisma.quote.update({ where: { id }, data: { status: "EXPIRED" } });
  }

  // Replay the ORIGINAL inputs (box selection, carton count, ...) when we have
  // them; legacy rows fall back to their stored columns.
  const r = old.pricingSnapshot?.request;
  req.body = {
    originCity: old.originCity,
    destinationCity: old.destinationCity,
    weightKg: r ? r.weightKg : old.weightKg ?? old.billableWeightKg,
    tons: r?.tons ?? null,
    cartons: r?.cartons ?? null,
    boxDimensionId: r?.boxDimensionId ?? null,
    lengthCm: r ? r.customLength : old.lengthCm,
    widthCm: r ? r.customWidth : old.widthCm,
    heightCm: r ? r.customHeight : old.heightCm,
    offeringId: old.offeringId || undefined,
    serviceType: old.serviceType,
    shipmentMode: old.shipmentMode,
    insuranceSelected: old.insuranceSelected,
    declaredValue: old.declaredValueKobo ? old.declaredValueKobo / 100 : null,
    promoCode: old.promoCode,
    termsAccepted: true, // already accepted when the original quote was made
  };
  return generateQuote(req, res);
}

// ─── Expire stale quotes (called internally / by cron) ───────────────────────
// PRD Master Notification Matrix: "Quote Expired → User → In-App → Auto
// (15 min) → Generate new quote for current rates". Guest quotes (no userId)
// are expired silently — there is no account to notify.
async function expireStaleQuotes() {
  const stale = await prisma.quote.findMany({
    where: { status: "GENERATED", expiresAt: { lt: new Date() } },
    select: { id: true, userId: true, originCity: true, destinationCity: true },
  });
  if (stale.length === 0) return 0;

  const result = await prisma.quote.updateMany({
    where: { id: { in: stale.map((q) => q.id) } },
    data: { status: "EXPIRED" },
  });

  // In-app notifications for logged-in owners (non-blocking best-effort)
  const notifiable = stale.filter((q) => q.userId);
  if (notifiable.length > 0) {
    await prisma.notification
      .createMany({
        data: notifiable.map((q) => ({
          userId: q.userId,
          type: "SYSTEM",
          title: "Quote Expired",
          body: `Your quote for ${q.originCity} → ${q.destinationCity} has expired (15-minute limit). Generate a new quote for current rates.`,
          data: { quoteId: q.id },
        })),
      })
      .catch((err) =>
        console.error(
          "[Quotes] Failed to create expiry notifications:",
          err.message,
        ),
      );
  }

  return result.count;
}

// ─── Cancel a quote ───────────────────────────────────────────────────────────
async function cancelQuote(req, res) {
  const { id } = req.params;
  const record = await prisma.quote.findUnique({ where: { id } });
  if (!record) throw new ApiError(404, "Quote not found");

  // Ownership: a quote tied to an account can only be cancelled by that
  // account (or internal admin staff). Guest quotes (no userId) are
  // capability-URL access — whoever holds the UUID may cancel.
  if (
    record.userId &&
    record.userId !== req.user.id &&
    req.user.role !== "ADMIN"
  ) {
    throw new ApiError(403, "This quote does not belong to your account");
  }

  if (record.status !== "GENERATED") {
    throw new ApiError(
      400,
      `Cannot cancel a quote with status "${record.status}"`,
    );
  }
  await prisma.quote.update({
    where: { id },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
  return success(res, {}, "Quote cancelled");
}

module.exports = {
  generateQuote,
  getQuoteOfferings,
  getQuote,
  refreshQuote,
  cancelQuote,
  expireStaleQuotes,
  recordConsent,
  SHIPMENT_MODES,
  DANGEROUS_GOODS_MODES,
};
