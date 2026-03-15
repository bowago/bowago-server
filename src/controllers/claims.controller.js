const { prisma } = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { success, created, getPagination, buildMeta } = require('../utils/helpers');

// ─── Customer: File a claim ───────────────────────────────────────────────────
async function fileClaim(req, res) {
  const {
    shipmentId, type, description, declaredValue,
    claimAmount, bankName, accountNumber, accountName,
  } = req.body;

  const shipment = await prisma.shipment.findFirst({
    where: { id: shipmentId, customerId: req.user.id },
  });
  if (!shipment) throw new ApiError(404, 'Shipment not found');

  // Can only file claims on delivered or failed shipments
  if (!['DELIVERED', 'FAILED', 'RETURNED'].includes(shipment.status)) {
    throw new ApiError(400, 'Claims can only be filed for delivered, failed, or returned shipments');
  }

  // Check for duplicate claim
  const existing = await prisma.claim.findFirst({
    where: { shipmentId, userId: req.user.id, status: { not: 'REJECTED' } },
  });
  if (existing) throw new ApiError(409, 'A claim already exists for this shipment');

  const claim = await prisma.claim.create({
    data: {
      shipmentId,
      userId: req.user.id,
      type,
      description,
      declaredValue,
      claimAmount,
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

  await prisma.notification.create({
    data: {
      userId: req.user.id,
      type: 'SYSTEM',
      title: 'Claim Submitted',
      body: `Your claim for shipment ${shipment.trackingNumber} has been submitted. We will review it within 3-5 business days.`,
      data: { claimId: claim.id, shipmentId },
    },
  });

  return created(res, { claim }, 'Claim submitted successfully');
}

// ─── Customer: My claims ──────────────────────────────────────────────────────
async function myClaims(req, res) {
  const claims = await prisma.claim.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
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
      shipment: { select: { trackingNumber: true, senderCity: true, recipientCity: true, status: true } },
      user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
    },
  });

  if (!claim) throw new ApiError(404, 'Claim not found');
  if (req.user.role === 'CUSTOMER' && claim.userId !== req.user.id) {
    throw new ApiError(403, 'Access denied');
  }

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
      orderBy: { createdAt: 'desc' },
      include: {
        images: true,
        shipment: { select: { trackingNumber: true } },
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    }),
    prisma.claim.count({ where }),
  ]);

  return res.json({ success: true, data: { claims }, meta: buildMeta(total, page, limit) });
}

// ─── Admin: Review claim ──────────────────────────────────────────────────────
async function reviewClaim(req, res) {
  const { id } = req.params;
  const { status, reviewNote, approvedAmount } = req.body;

  const validStatuses = ['UNDER_REVIEW', 'APPROVED', 'REJECTED', 'PAID'];
  if (!validStatuses.includes(status)) {
    throw new ApiError(400, `Status must be one of: ${validStatuses.join(', ')}`);
  }

  const claim = await prisma.claim.findUnique({ where: { id } });
  if (!claim) throw new ApiError(404, 'Claim not found');

  const updated = await prisma.claim.update({
    where: { id },
    data: {
      status,
      reviewNote,
      reviewedBy: req.user.id,
      reviewedAt: new Date(),
      ...(approvedAmount && { approvedAmount }),
      ...(status === 'PAID' && { paidAt: new Date() }),
    },
  });

  // Notify customer
  const messages = {
    UNDER_REVIEW: 'Your claim is now under review.',
    APPROVED: `Your claim has been approved for ₦${(approvedAmount || claim.claimAmount).toLocaleString()}.`,
    REJECTED: `Your claim has been rejected. Reason: ${reviewNote || 'No reason provided.'}`,
    PAID: 'Your approved claim amount has been paid to your bank account.',
  };

  await prisma.notification.create({
    data: {
      userId: claim.userId,
      type: 'PAYMENT',
      title: 'Claim Update',
      body: messages[status],
      data: { claimId: id, status },
    },
  });

  return success(res, { claim: updated }, 'Claim updated');
}

module.exports = { fileClaim, myClaims, getClaim, listClaims, reviewClaim };
