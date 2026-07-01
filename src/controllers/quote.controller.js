const { prisma } = require("../config/db");
const { calculateShippingCost } = require("../services/pricing.service");
const { ApiError } = require("../utils/ApiError");
const { success, created } = require("../utils/helpers");
const { getNumberSetting } = require("../services/settings.service");

const QUOTE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ─── Convert Naira to Kobo (avoid float errors per PRD) ──────────────────────
function toKobo(naira) {
  return Math.round(parseFloat(naira) * 100);
}

// ─── Sprint 7: Record user consent at quote time ─────────────────────────────
async function recordConsent(userId, sessionId, consentType, req) {
  try {
    await prisma.consentLog.create({
      data: {
        userId: userId || null,
        sessionId: sessionId || null,
        consentType,
        tcVersion: process.env.TC_VERSION || "v1.0",
        ipAddress: req.ip || req.headers["x-forwarded-for"] || null,
        userAgent: req.headers["user-agent"] || null,
      },
    });
  } catch (err) {
    // Non-blocking — consent logging failure must not break the flow
    console.error("[Consent] Failed to record consent:", err.message);
  }
}

// ─── Generate Quote (Public — no auth required) ───────────────────────────────
async function generateQuote(req, res) {
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
    termsAccepted, // Sprint 7: user must tick "I agree to Terms of Service"
  } = req.body;

  // ─── Sprint 7: Terms consent check ──────────────────────────────────────
  if (!termsAccepted) {
    throw new ApiError(
      400,
      "You must accept the Terms of Service to generate a quote.",
    );
  }

  const userId = req.user?.id || null;

  // Calculate via the pricing service
  const quote = await calculateShippingCost({
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
    isFragile: false,
    requiresInsurance: !!insuranceSelected,
    insuranceValue: declaredValue || null,
    promoCode: promoCode || null,
    userId,
  });

  const now = new Date();
  const expiresAt = new Date(now.getTime() + QUOTE_TTL_MS);

  // Insurance premium — rate is configurable by Super Admin in
  // Settings → Business Rules (insurance.rate_percent, default 2.5%).
  // Minimum premium is also configurable (insurance.min_premium_naira, default ₦100).
  let insurancePremiumKobo = null;
  let declaredValueKobo = null;
  if (insuranceSelected && declaredValue) {
    const [ratePercent, minPremiumNaira] = await Promise.all([
      getNumberSetting('insurance.rate_percent'),
      getNumberSetting('insurance.min_premium_naira'),
    ]);
    declaredValueKobo = toKobo(declaredValue);
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
  const totalPriceKobo = toKobo(quote.total) + (insurancePremiumKobo || 0);

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
      volumetricWeightKg: quote.weightKg, // pricing service already resolves billable weight
      billableWeightKg: quote.weightKg,
      lengthCm: lengthCm || null,
      widthCm: widthCm || null,
      heightCm: heightCm || null,
      serviceType: serviceType || "STANDARD",
      basePriceKobo,
      fuelSurchargeKobo: fuelKobo,
      remoteAreaFeeKobo: remoteKobo,
      vatKobo,
      totalPriceKobo,
      insuranceSelected: !!insuranceSelected,
      declaredValueKobo,
      insurancePremiumKobo,
      promoCode: promoCode || null,
      promoDiscountKobo: quote.appliedDiscount
        ? toKobo(quote.appliedDiscount.discountAmount || 0)
        : null,
      pricingMode: quote.pricingMode || "STANDARD",
      expiresAt,
    },
  });

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
      pricing: {
        basePriceNaira: record.basePriceKobo / 100,
        fuelSurchargeNaira: record.fuelSurchargeKobo / 100,
        remoteAreaFeeNaira: record.remoteAreaFeeKobo / 100,
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
      currency: "NGN",
    },
    "Quote generated",
  );

  // ─── Sprint 7: Log TERMS_OF_SERVICE consent (non-blocking, after response) ─
  // Fire-and-forget after res is sent — doesn't delay the client
  await recordConsent(
    userId,
    req.headers["x-session-id"] || null,
    "TERMS_OF_SERVICE",
    req,
  );
}

// ─── Get Quote by ID ──────────────────────────────────────────────────────────
async function getQuote(req, res) {
  const { id } = req.params;
  const record = await prisma.quote.findUnique({ where: { id } });
  if (!record) throw new ApiError(404, "Quote not found");

  // Expire if past TTL
  if (record.status === "GENERATED" && new Date() > record.expiresAt) {
    await prisma.quote.update({ where: { id }, data: { status: "EXPIRED" } });
    record.status = "EXPIRED";
  }

  return success(res, { quote: record });
}

// ─── Expire stale quotes (called internally / by cron) ───────────────────────
async function expireStaleQuotes() {
  const result = await prisma.quote.updateMany({
    where: { status: "GENERATED", expiresAt: { lt: new Date() } },
    data: { status: "EXPIRED" },
  });
  return result.count;
}

// ─── Cancel a quote ───────────────────────────────────────────────────────────
async function cancelQuote(req, res) {
  const { id } = req.params;
  const record = await prisma.quote.findUnique({ where: { id } });
  if (!record) throw new ApiError(404, "Quote not found");
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

module.exports = { generateQuote, getQuote, cancelQuote, expireStaleQuotes };
