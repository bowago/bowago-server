// ─── insuranceDisclaimer.controller.js ───────────────────────────────────────
// V1 Feature 7 — versioned, admin-editable wording + liability limit shown
// when a customer leaves insurance off. GET is public (quote page/review
// screen need it for guests too); PUBLISH is ROLE_ADMIN only. Existing
// ConsentLog entries keep the version the user actually saw even after a
// newer version is published — never rewritten retroactively.
const { prisma } = require("../config/db");
const { ApiError } = require("../utils/ApiError");
const { success, created, getPagination, buildMeta } = require("../utils/helpers");

// ─── Public: the currently effective disclaimer ──────────────────────────────
async function getCurrentDisclaimer(req, res) {
  const disclaimer = await prisma.insuranceDisclaimer.findFirst({
    where: { effectiveFrom: { lte: new Date() } },
    orderBy: { effectiveFrom: "desc" },
  });

  if (!disclaimer) {
    return success(res, { disclaimer: null }, "No insurance disclaimer has been published yet");
  }

  return success(res, { disclaimer });
}

// ─── Admin: publish a new version ────────────────────────────────────────────
async function publishDisclaimer(req, res) {
  const { version, body, liabilityLimitKobo, effectiveFrom } = req.body;

  if (!version || !version.trim()) throw new ApiError(400, "version is required");
  if (!body || !body.trim()) throw new ApiError(400, "body is required");
  if (!liabilityLimitKobo || liabilityLimitKobo <= 0) {
    throw new ApiError(400, "liabilityLimitKobo is required and must be greater than 0");
  }

  const existing = await prisma.insuranceDisclaimer.findUnique({ where: { version: version.trim() } });
  if (existing) throw new ApiError(409, `Disclaimer version "${version}" already exists`);

  const disclaimer = await prisma.insuranceDisclaimer.create({
    data: {
      version: version.trim(),
      body,
      liabilityLimitKobo: parseInt(liabilityLimitKobo, 10),
      effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
      createdByUserId: req.user.id,
    },
  });

  await prisma.priceAuditLog.create({
    data: {
      entityType: "InsuranceDisclaimer",
      entityId: disclaimer.id,
      action: "CREATE",
      newValue: disclaimer,
      changedBy: req.user.id,
    },
  });

  return created(res, { disclaimer }, "Insurance disclaimer published");
}

// ─── Admin: version history (viewing is logged) ─────────────────────────────
async function listDisclaimerHistory(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const [disclaimers, total] = await Promise.all([
    prisma.insuranceDisclaimer.findMany({
      skip,
      take: limit,
      orderBy: { effectiveFrom: "desc" },
    }),
    prisma.insuranceDisclaimer.count(),
  ]);

  await prisma.activityLog
    .create({
      data: { userId: req.user.id, action: "VIEW_INSURANCE_DISCLAIMER_HISTORY", resource: "InsuranceDisclaimer" },
    })
    .catch(() => {});

  return res.json({ success: true, data: { disclaimers }, meta: buildMeta(total, page, limit) });
}

module.exports = { getCurrentDisclaimer, publishDisclaimer, listDisclaimerHistory };
