const { prisma } = require("../config/db");
const { ApiError } = require("../utils/ApiError");
const { assertOwnedResourceAccess } = require("../utils/access");
const {
  success,
  created,
  getPagination,
  buildMeta,
} = require("../utils/helpers");
const { notify } = require("../services/notify.service");

// ─── Customer: File a claim ───────────────────────────────────────────────────
async function fileClaim(req, res) {
  const {
    shipmentId: shipmentIdOrTrackingNumber,
    type,
    description,
    declaredValue,
    claimAmount,
    bankName,
    accountNumber,
    accountName,
  } = req.body;

  // Customers only ever know their tracking number (e.g. "BG-20260713-KD7H8"),
  // never the internal shipment UUID — the form used to ask for the raw UUID
  // directly, which nobody filing a claim could actually provide. Accept
  // either here, same lookup pattern as shipment.controller.js#getShipment.
  const shipment = await prisma.shipment.findFirst({
    where: {
      OR: [
        { id: shipmentIdOrTrackingNumber },
        { trackingNumber: shipmentIdOrTrackingNumber },
      ],
      customerId: req.user.id,
    },
  });
  if (!shipment) throw new ApiError(404, "Shipment not found");

  // Everything from here on uses the resolved DB id, never the raw input
  // (which may have been a tracking number, not a valid foreign key value).
  const shipmentId = shipment.id;

  // Can only file claims on delivered or failed shipments
  if (!["DELIVERED", "FAILED", "RETURNED"].includes(shipment.status)) {
    throw new ApiError(
      400,
      "Claims can only be filed for delivered, failed, or returned shipments",
    );
  }

  // Check for duplicate claim
  const existing = await prisma.claim.findFirst({
    where: { shipmentId, userId: req.user.id, status: { not: "REJECTED" } },
  });
  if (existing)
    throw new ApiError(409, "A claim already exists for this shipment");

  // ─── PRD Sprint 7 claim validation ────────────────────────────────────────
  // description 20–1000 chars
  const desc = String(description || "").trim();
  if (desc.length < 20 || desc.length > 1000) {
    throw new ApiError(
      400,
      "Description must be between 20 and 1000 characters",
    );
  }

  // claimAmount must be a positive number and ≤ declaredValue
  const declared = parseFloat(declaredValue);
  const amount = parseFloat(claimAmount);
  if (!Number.isFinite(declared) || declared <= 0) {
    throw new ApiError(400, "declaredValue must be a positive number");
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ApiError(400, "claimAmount must be a positive number");
  }
  if (amount > declared) {
    throw new ApiError(400, "Claim amount cannot exceed the declared value");
  }

  // claimAmount ≤ insurable amount — if the shipment was insured, the payout
  // cap is the insured value declared at booking time.
  if (
    shipment.requiresInsurance &&
    shipment.insuranceValue &&
    amount > shipment.insuranceValue
  ) {
    throw new ApiError(
      400,
      `Claim amount cannot exceed the insured value of ₦${Number(shipment.insuranceValue).toLocaleString()}`,
    );
  }

  // Evidence images: min 1, max 5 (max enforced by multer at the route).
  if (!req.files || req.files.length === 0) {
    throw new ApiError(
      400,
      "At least one evidence photo is required to file a claim",
    );
  }

  // req.body comes from multipart/form-data (required for the image
  // upload alongside it), so every field arrives as a string regardless of
  // its logical type — declaredValue/claimAmount need explicit coercion or
  // Prisma's Float columns reject them outright with a 500.
  const declaredValueNum = Number(declaredValue);
  const claimAmountNum = Number(claimAmount);
  if (!Number.isFinite(declaredValueNum) || declaredValueNum <= 0) {
    throw new ApiError(400, "Declared value must be a valid positive number");
  }
  if (!Number.isFinite(claimAmountNum) || claimAmountNum <= 0) {
    throw new ApiError(400, "Claim amount must be a valid positive number");
  }

  const claim = await prisma.claim.create({
    data: {
      shipmentId,
      userId: req.user.id,
      type,
      description,
      declaredValue: declaredValueNum,
      claimAmount: claimAmountNum,
      bankName,
      accountNumber,
      accountName,
    },
  });

  // Handle image uploads if provided
  if (req.files && req.files.length > 0) {
    await prisma.claimImage.createMany({
      data: req.files.map((f) => ({
        claimId: claim.id,
        url: f.path,
        publicId: f.filename,
      })),
    });
  }

  const claimSubmittedNotification = await prisma.notification.create({
    data: {
      userId: req.user.id,
      type: "SYSTEM",
      title: "Claim Submitted",
      body: `Your claim for shipment ${shipment.trackingNumber} has been submitted. We will review it within 3-5 business days.`,
      data: { claimId: claim.id, shipmentId },
    },
  });
  notify(req.user.id, claimSubmittedNotification);

  return created(res, { claim }, "Claim submitted successfully");
}

// ─── Customer: My claims ──────────────────────────────────────────────────────
async function myClaims(req, res) {
  const claims = await prisma.claim.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: "desc" },
    include: {
      images: true,
      shipment: { select: { trackingNumber: true, recipientCity: true } },
    },
  });
  return success(res, { claims });
}

// ─── Get single claim ─────────────────────────────────────────────────────────
async function getClaim(req, res) {
  const { id } = req.params;

  const claim = await prisma.claim.findUnique({
    where: { id },
    include: {
      images: true,
      shipment: {
        select: {
          trackingNumber: true,
          senderCity: true,
          recipientCity: true,
          status: true,
        },
      },
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
        },
      },
    },
  });

  if (!claim) throw new ApiError(404, "Claim not found");
  await assertOwnedResourceAccess(req.user, claim.userId, {
    resource: "Claim",
    resourceId: claim.id,
    req,
  });

  return success(res, { claim });
}

// ─── Admin: List all claims ───────────────────────────────────────────────────
async function listClaims(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { status, type } = req.query;

  const where = {
    ...(status && { status }),
    ...(type && { type }),
  };

  const [claims, total] = await Promise.all([
    prisma.claim.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        images: true,
        shipment: { select: { trackingNumber: true } },
        user: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    }),
    prisma.claim.count({ where }),
  ]);

  return res.json({
    success: true,
    data: { claims },
    meta: buildMeta(total, page, limit),
  });
}

// ─── Admin: Review claim ──────────────────────────────────────────────────────
async function reviewClaim(req, res) {
  const { id } = req.params;
  const { status, reviewNote, approvedAmount } = req.body;

  const validStatuses = ["UNDER_REVIEW", "APPROVED", "REJECTED", "PAID"];
  if (!validStatuses.includes(status)) {
    throw new ApiError(
      400,
      `Status must be one of: ${validStatuses.join(", ")}`,
    );
  }

  const claim = await prisma.claim.findUnique({ where: { id } });
  if (!claim) throw new ApiError(404, "Claim not found");

  // Defensive coercion — same reasoning as fileClaim: a number input's raw
  // DOM value is always a string, so guard against that reaching Prisma's
  // Float column regardless of how the frontend happens to send it.
  const approvedAmountNum =
    approvedAmount !== undefined &&
    approvedAmount !== null &&
    approvedAmount !== ""
      ? Number(approvedAmount)
      : undefined;
  if (approvedAmountNum !== undefined && !Number.isFinite(approvedAmountNum)) {
    throw new ApiError(400, "Approved amount must be a valid number");
  }

  const updated = await prisma.claim.update({
    where: { id },
    data: {
      status,
      reviewNote,
      reviewedBy: req.user.id,
      reviewedAt: new Date(),
      ...(approvedAmountNum !== undefined && {
        approvedAmount: approvedAmountNum,
      }),
      ...(status === "PAID" && { paidAt: new Date() }),
    },
  });

  // Notify customer
  const messages = {
    UNDER_REVIEW: "Your claim is now under review.",
    APPROVED: `Your claim has been approved for ₦${(approvedAmountNum ?? claim.claimAmount).toLocaleString()}.`,
    REJECTED: `Your claim has been rejected. Reason: ${reviewNote || "No reason provided."}`,
    PAID: "Your approved claim amount has been paid to your bank account.",
  };

  const claimUpdateNotification = await prisma.notification.create({
    data: {
      userId: claim.userId,
      type: "PAYMENT",
      title: "Claim Update",
      body: messages[status],
      data: { claimId: id, status },
    },
  });
  notify(claim.userId, claimUpdateNotification);

  return success(res, { claim: updated }, "Claim updated");
}

module.exports = { fileClaim, myClaims, getClaim, listClaims, reviewClaim };
