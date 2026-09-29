const { prisma } = require("../config/db");
const { ApiError } = require("../utils/ApiError");
const { success, created } = require("../utils/helpers");
const core = require("../services/pricing/core");

// appliesTo is a comma list of tokens: ALL | EXPRESS|STANDARD|ECONOMY | AIR|LAND|SEA.
// Canonicalised on write so the engine's token matching is predictable.
const APPLIES_TOKENS = ["ALL", "EXPRESS", "STANDARD", "ECONOMY", "AIR", "LAND", "SEA"];
function normalizeAppliesTo(value) {
  if (value === undefined || value === null || String(value).trim() === "") return "ALL";
  const tokens = [...new Set(String(value).split(",").map((t) => t.trim().toUpperCase()).filter(Boolean))];
  const bad = tokens.filter((t) => !APPLIES_TOKENS.includes(t));
  if (bad.length) throw new ApiError(400, `appliesTo has unknown value(s): ${bad.join(", ")}. Use ${APPLIES_TOKENS.join(", ")} (comma-separated).`);
  return tokens.includes("ALL") ? "ALL" : tokens.join(",");
}
const SURCHARGE_EDITABLE = ["type", "label", "description", "ratePercent", "flatAmount", "isActive", "appliesTo"];

// ─── List all surcharges (public — used in quote breakdown) ───────────────────
async function listSurcharges(req, res) {
  const { active, isActive, type, appliesTo } = req.query;

  // support both ?active=true (legacy) and ?isActive=true (new)
  const activeFilter =
    isActive !== undefined
      ? isActive === "true"
      : active === "true"
        ? true
        : undefined;

  const surcharges = await prisma.surcharge.findMany({
    where: {
      ...(activeFilter !== undefined && { isActive: activeFilter }),
      ...(type && { type: { equals: type, mode: "insensitive" } }),
      ...(appliesTo && {
        appliesTo: { equals: appliesTo, mode: "insensitive" },
      }),
    },
    orderBy: { type: "asc" },
  });
  return success(res, { surcharges });
}

// ─── Create surcharge (Admin) ─────────────────────────────────────────────────
async function createSurcharge(req, res) {
  const { type, label, description, ratePercent, flatAmount, appliesTo } =
    req.body;

  if (!ratePercent && !flatAmount) {
    throw new ApiError(400, "Provide either ratePercent or flatAmount");
  }

  // Log to price audit trail
  const surcharge = await prisma.surcharge.create({
    data: {
      type,
      label,
      description,
      ratePercent,
      flatAmount,
      appliesTo: normalizeAppliesTo(appliesTo),
    },
  });

  await prisma.priceAuditLog.create({
    data: {
      entityType: "Surcharge",
      entityId: surcharge.id,
      action: "CREATE",
      newValue: surcharge,
      changedBy: req.user.id,
    },
  });

  return created(res, { surcharge }, "Surcharge created");
}

// ─── Update surcharge (Admin) ─────────────────────────────────────────────────
async function updateSurcharge(req, res) {
  const { id } = req.params;

  const existing = await prisma.surcharge.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "Surcharge not found");

  // Whitelisted fields only; appliesTo is validated/canonicalised.
  const data = Object.fromEntries(Object.entries(req.body).filter(([k]) => SURCHARGE_EDITABLE.includes(k)));
  if ("appliesTo" in data) data.appliesTo = normalizeAppliesTo(data.appliesTo);
  const surcharge = await prisma.surcharge.update({ where: { id }, data });

  await prisma.priceAuditLog.create({
    data: {
      entityType: "Surcharge",
      entityId: id,
      action: "UPDATE",
      previousValue: existing,
      newValue: surcharge,
      changedBy: req.user.id,
      reason: req.body.reason,
    },
  });

  return success(res, { surcharge }, "Surcharge updated");
}

// ─── Delete surcharge ─────────────────────────────────────────────────────────
async function deleteSurcharge(req, res) {
  const { id } = req.params;

  const existing = await prisma.surcharge.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "Surcharge not found");

  await prisma.surcharge.delete({ where: { id } });

  await prisma.priceAuditLog.create({
    data: {
      entityType: "Surcharge",
      entityId: id,
      action: "DELETE",
      previousValue: existing,
      changedBy: req.user.id,
    },
  });

  return success(res, {}, "Surcharge deleted");
}

// ─── Calculate surcharges for a given base price ──────────────────────────────
// Delegates to the SAME functions the quote engine uses (pricing/core), so the
// preview can never disagree with a real quote: comma-list appliesTo, every
// FUEL/REMOTE row counted, and VAT on base + fuel + remote area.
async function calculateSurcharges(basePrice, serviceType = "STANDARD", options = {}) {
  const surcharges = await prisma.surcharge.findMany({ where: { isActive: true } });
  const mode = options.shipmentMode || null;
  const lines = core.computeSurcharges(surcharges, { finalBase: basePrice, mode, service: serviceType, isFragile: !!options.isFragile });
  const tax = core.computeTax(surcharges, { mode, service: serviceType, finalBase: basePrice, surchargeLines: lines, adhocLines: [] });
  const surchargeTotal = lines.reduce((a, l) => a + l.amount, 0);
  const breakdown = [...lines, ...(tax.line ? [tax.line] : [])].map(({ type, label, description, amount, category }) => ({ type, label, description, amount, category }));
  return {
    breakdown,
    surchargeTotal,
    tax: core.fromKobo(tax.taxKobo),
    // deprecated alias: surcharges + tax (kept for older clients)
    totalSurcharge: surchargeTotal + core.fromKobo(tax.taxKobo),
  };
}

// ─── GET surcharge calculation preview ───────────────────────────────────────
async function previewSurcharges(req, res) {
  const {
    basePrice,
    serviceType,
    isFragile,
    shipmentMode,
  } = req.body;

  if (!basePrice) throw new ApiError(400, "basePrice is required");

  const result = await calculateSurcharges(
    parseFloat(basePrice),
    serviceType || "STANDARD",
    { isFragile, shipmentMode },
  );

  return success(res, {
    basePrice: parseFloat(basePrice),
    ...result,
    grandTotal: parseFloat(basePrice) + result.totalSurcharge,
    currency: "NGN",
  });
}

// ─── Price audit log ──────────────────────────────────────────────────────────
async function getPriceAuditLog(req, res) {
  const { entityType, page = 1 } = req.query;
  const limit = 50;
  const skip = (parseInt(page) - 1) * limit;

  const logs = await prisma.priceAuditLog.findMany({
    where: entityType ? { entityType } : {},
    skip,
    take: limit,
    orderBy: { createdAt: "desc" },
    include: {
      user: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
    },
  });

  return success(res, { logs });
}

module.exports = {
  listSurcharges,
  createSurcharge,
  updateSurcharge,
  deleteSurcharge,
  calculateSurcharges,
  previewSurcharges,
  getPriceAuditLog,
};
