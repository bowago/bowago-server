const { prisma } = require("../config/db");
const { calculateShippingCost, assertModeActive } = require("../services/pricing.service");
const { applyAdhocChargesAtQuote } = require("../services/adhocCharge.service");
const { ApiError } = require("../utils/ApiError");
const { success, created } = require("../utils/helpers");
const { getNumberSetting } = require("../services/settings.service");

const QUOTE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const SHIPMENT_MODES = ["AIR", "LAND", "SEA"];
// [V1 Feature 1] Air/Sea show the dangerous-goods (batteries) notice from the
// Knowledge Base before the user continues — Land does not require it.
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

// [V1 Feature 2] declaredValue is now always required, whether or not
// insurance is selected — the v2.0 "defaults to booking price" behaviour is
// gone because pre-filling from price understates a terminal's real value.
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

// ─── Build one mode's quote preview (used both for a single quote and for
// side-by-side mode comparison) — does NOT persist anything. ───────────────
async function buildQuotePreview(body, shipmentMode, userId) {
  const {
    originCity,
    destinationCity,
    weightKg,
    tons,
    cartons,
    lengthCm,
    widthCm,
    heightCm,
    boxDimensionId,
    serviceType,
    insuranceSelected,
    declaredValue,
    promoCode,
  } = body;

  return calculateShippingCost({
    fromCity: originCity,
    toCity: destinationCity,
    weightKg,
    tons,
    cartons,
    customLength: lengthCm,
    customWidth: widthCm,
    customHeight: heightCm,
    boxDimensionId,
    serviceType: serviceType || "STANDARD",
    shipmentMode,
    isFragile: false,
    requiresInsurance: !!insuranceSelected,
    insuranceValue: declaredValue || null,
    promoCode: promoCode || null,
    userId,
  });
}

// ─── Generate Quote (Public — no auth required) ───────────────────────────────
// [V1] shipmentMode is now required — either a single mode (AIR/LAND/SEA) to
// generate & persist the official 15-minute quote, or an array of modes to
// get a side-by-side comparison preview (no Quote row is created for a
// comparison request; the client re-calls with one chosen mode to book).
async function generateQuote(req, res) {
  const {
    originCity,
    destinationCity,
    shipmentMode,
    declaredValue,
    termsAccepted, // Sprint 7: user must tick "I agree to Terms of Service"
  } = req.body;

  // ─── Sprint 7: Terms consent check ──────────────────────────────────────
  if (!termsAccepted) {
    throw new ApiError(
      400,
      "You must accept the Terms of Service to generate a quote.",
    );
  }

  if (!shipmentMode) {
    throw new ApiError(
      400,
      `shipmentMode is required — choose one of ${SHIPMENT_MODES.join(", ")}, or provide a list to compare modes`,
    );
  }

  const userId = req.user?.id || null;

  // ─── [V1] Compare mode: array of modes → side-by-side preview, no persist ──
  if (Array.isArray(shipmentMode)) {
    const modes = shipmentMode.filter((m) => SHIPMENT_MODES.includes(m));
    if (modes.length === 0) {
      throw new ApiError(400, `Provide at least one valid mode: ${SHIPMENT_MODES.join(", ")}`);
    }
    assertDeclaredValue(declaredValue);

    const results = await Promise.allSettled(
      modes.map(async (mode) => {
        await assertModeActive(mode);
        return buildQuotePreview(req.body, mode, userId);
      }),
    );

    const modeOptions = modes.map((mode, i) => {
      const r = results[i];
      if (r.status === "rejected") {
        return { mode, available: false, reason: r.reason?.message || "Not available" };
      }
      const q = r.value;
      return {
        mode,
        available: true,
        totalNaira: q.total,
        transitHours: q.transitHours,
        deliveryEstimate: q.deliveryEstimate,
        requiresDangerousGoodsNotice: DANGEROUS_GOODS_MODES.includes(mode),
        adhocCharges: q.adhocCharges,
      };
    });

    return success(res, { modeOptions, comparisonOnly: true }, "Mode comparison calculated");
  }

  // ─── Single mode → generate & persist the official quote ──────────────────
  if (!SHIPMENT_MODES.includes(shipmentMode)) {
    throw new ApiError(400, `shipmentMode must be one of ${SHIPMENT_MODES.join(", ")}`);
  }
  await assertModeActive(shipmentMode);
  const declaredValueNumber = assertDeclaredValue(declaredValue);

  const quote = await buildQuotePreview(req.body, shipmentMode, userId);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + QUOTE_TTL_MS);
  const { insuranceSelected, serviceType } = req.body;

  // Insurance premium — rate is configurable by Super Admin in
  // Settings → Business Rules (insurance.rate_percent, default 2.5%).
  // Minimum premium is also configurable (insurance.min_premium_naira, default ₦100).
  // [V1] declaredValueKobo is now ALWAYS captured, regardless of the toggle —
  // only the premium itself is conditional on insuranceSelected.
  const declaredValueKobo = toKobo(declaredValueNumber);
  let insurancePremiumKobo = null;
  if (insuranceSelected) {
    const [ratePercent, minPremiumNaira] = await Promise.all([
      getNumberSetting("insurance.rate_percent"),
      getNumberSetting("insurance.min_premium_naira"),
    ]);
    const minPremiumKobo = toKobo(minPremiumNaira);
    insurancePremiumKobo = Math.max(
      minPremiumKobo,
      Math.round(declaredValueKobo * (ratePercent / 100)),
    );
  }

  // Store all prices in kobo
  const basePriceKobo = toKobo(quote.breakdown.finalBasePrice);
  const fuelKobo = toKobo(
    quote.surchargeBreakdown.find((s) => s.type === "FUEL")?.amount || 0,
  );
  const remoteKobo = toKobo(
    quote.surchargeBreakdown.find((s) => s.type === "REMOTE_AREA")?.amount || 0,
  );
  const vatKobo = toKobo(
    quote.surchargeBreakdown.find((s) => s.type === "VAT")?.amount || 0,
  );
  // [V1] Recompute the true insurance-adjusted total: `quote.total` already
  // bakes in the auto-apply adhoc charges (see pricing.service.js), so we
  // only need to add the insurance premium on top, exactly as before.
  const totalPriceKobo = toKobo(quote.total) + (insurancePremiumKobo || 0);
  const adhocChargesKobo = toKobo(quote.adhocTotalNaira || 0);

  const record = await prisma.quote.create({
    data: {
      userId,
      status: "GENERATED",
      originCity,
      originCityId: quote.fromCity.id,
      destinationCity,
      destinationCityId: quote.toCity.id,
      zone: quote.zone,
      distanceKm: quote.distanceKm,
      weightKg: quote.weightKg,
      volumetricWeightKg: quote.measurements?.volumetricWeightKg ?? quote.weightKg,
      billableWeightKg: quote.weightKg,
      lengthCm: req.body.lengthCm || null,
      widthCm: req.body.widthCm || null,
      heightCm: req.body.heightCm || null,
      serviceType: serviceType || "STANDARD",
      shipmentMode,
      basePriceKobo,
      fuelSurchargeKobo: fuelKobo,
      remoteAreaFeeKobo: remoteKobo,
      adhocChargesKobo,
      vatKobo,
      totalPriceKobo,
      // Full breakdown as-computed, so any custom/ad-hoc surcharge type
      // (beyond fuel/remote-area/VAT) is preserved exactly as the customer
      // saw it at quote time — the three *Kobo columns above only cover the
      // three built-in types.
      surchargeBreakdown: quote.surchargeBreakdown ?? [],
      insuranceSelected: !!insuranceSelected,
      declaredValueKobo,
      insurancePremiumKobo,
      promoCode: req.body.promoCode || null,
      promoDiscountKobo: quote.appliedDiscount
        ? toKobo(quote.appliedDiscount.discountAmount || 0)
        : null,
      pricingMode: quote.pricingMode || "STANDARD",
      expiresAt,
    },
  });

  // [V1 Features 5/6] Persist the adhoc charge lines (AUTO_APPLY as APPLIED,
  // SUGGEST as SUGGESTED for the admin queue) against this quote, using the
  // exact same measurements the total above was computed from.
  let adhocResult = { lines: [], suggestedCount: 0 };
  try {
    adhocResult = await applyAdhocChargesAtQuote({
      quoteId: record.id,
      shipmentMode,
      measurements: quote.measurements,
      basePriceKobo,
    });
  } catch (err) {
    console.error("[Quotes] Failed to persist adhoc charges:", err.message);
  }

  // ─── Sprint 7: Log TERMS_OF_SERVICE consent ──────────────────────────────
  // Fire-and-forget (not awaited) so it never delays the response.
  recordConsent(
    userId,
    req.headers["x-session-id"] || null,
    "TERMS_OF_SERVICE",
    req,
  );

  return created(
    res,
    {
      quoteId: record.id,
      status: record.status,
      expiresAt: record.expiresAt,
      expiresInSeconds: Math.floor(QUOTE_TTL_MS / 1000),
      origin: { city: originCity, id: quote.fromCity.id },
      destination: { city: destinationCity, id: quote.toCity.id },
      zone: quote.zone,
      billableWeightKg: quote.weightKg,
      serviceType: record.serviceType,
      shipmentMode,
      transitHours: quote.transitHours,
      deliveryEstimate: quote.deliveryEstimate,
      distanceKm: quote.distanceKm,
      requiresDangerousGoodsNotice: DANGEROUS_GOODS_MODES.includes(shipmentMode),
      declaredValueNaira: declaredValueNumber,
      pricing: {
        basePriceNaira: record.basePriceKobo / 100,
        fuelSurchargeNaira: record.fuelSurchargeKobo / 100,
        remoteAreaFeeNaira: record.remoteAreaFeeKobo / 100,
        adhocChargesNaira: record.adhocChargesKobo / 100,
        vatNaira: record.vatKobo / 100,
        insurancePremiumNaira: insurancePremiumKobo
          ? insurancePremiumKobo / 100
          : null,
        totalNaira: record.totalPriceKobo / 100,
        basePriceKobo: record.basePriceKobo,
        totalPriceKobo: record.totalPriceKobo,
      },
      pricingMode: quote.pricingMode, // STANDARD | CONTRACT | PROMO (also persisted)
      appliedDiscount: quote.appliedDiscount,
      surchargeBreakdown: quote.surchargeBreakdown,
      // [V1] Each adhoc line the customer is actually being charged, plus a
      // count of items waiting in the admin suggestion queue (not charged).
      adhocCharges: adhocResult.lines,
      adhocSuggestionsPending: adhocResult.suggestedCount,
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

  return success(res, { quote: record });
}

// ─── [V1 Feature 8] Refresh an expired quote ──────────────────────────────────
// Returns a fresh 15-minute quote for the same inputs, at current rates.
// The old quote stays EXPIRED; a shipment draft pointing at it should be
// re-pointed at the new quoteId (see shipmentDraft.controller.js).
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

  if (old.status === "GENERATED" && new Date() > old.expiresAt) {
    await prisma.quote.update({ where: { id }, data: { status: "EXPIRED" } });
  }

  const userId = old.userId || req.user?.id || null;
  const rebuildBody = {
    originCity: old.originCity,
    destinationCity: old.destinationCity,
    weightKg: old.weightKg,
    lengthCm: old.lengthCm,
    widthCm: old.widthCm,
    heightCm: old.heightCm,
    serviceType: old.serviceType,
    shipmentMode: old.shipmentMode || "LAND",
    insuranceSelected: old.insuranceSelected,
    declaredValue: old.declaredValueKobo ? old.declaredValueKobo / 100 : null,
    promoCode: old.promoCode,
    termsAccepted: true, // already accepted when the original quote was made
  };

  req.body = rebuildBody;
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
  getQuote,
  refreshQuote,
  cancelQuote,
  expireStaleQuotes,
  recordConsent,
  SHIPMENT_MODES,
  DANGEROUS_GOODS_MODES,
};
