const { prisma } = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { success, created, getPagination, buildMeta } = require('../utils/helpers');
const { sendEmail } = require('../config/email');

// ─── Customer: Request address change ────────────────────────────────────────
async function requestAddressChange(req, res) {
  const { shipmentId, newRecipientAddress, newRecipientCity, newRecipientState, reason } = req.body;

  const shipment = await prisma.shipment.findFirst({
    where: { id: shipmentId, customerId: req.user.id },
  });
  if (!shipment) throw new ApiError(404, 'Shipment not found');

  // Can only request change if not yet delivered or cancelled
  const blocked = ['DELIVERED', 'CANCELLED', 'RETURNED', 'FAILED'];
  if (blocked.includes(shipment.status)) {
    throw new ApiError(400, `Cannot request address change for a shipment with status: ${shipment.status}`);
  }

  // Check no pending request exists
  const existing = await prisma.addressChangeRequest.findFirst({
    where: { shipmentId, status: 'PENDING' },
  });
  if (existing) {
    throw new ApiError(409, 'There is already a pending address change request for this shipment');
  }

  const changeReq = await prisma.addressChangeRequest.create({
    data: {
      shipmentId,
      userId: req.user.id,
      newRecipientAddress,
      newRecipientCity,
      newRecipientState,
      reason,
    },
  });

  // Set shipment to pending review status
  await prisma.shipment.update({
    where: { id: shipmentId },
    data: { status: 'PENDING_ADMIN_REVIEW' },
  });

  // Notify admins
  await prisma.notification.create({
    data: {
      userId: req.user.id,
      type: 'SHIPMENT_UPDATE',
      title: 'Address Change Requested',
      body: `Your address change request for shipment ${shipment.trackingNumber} has been submitted and is awaiting admin approval.`,
      data: { shipmentId, changeRequestId: changeReq.id },
    },
  });

  return created(res, { changeRequest: changeReq }, 'Address change request submitted. Awaiting admin approval.');
}

// ─── Customer: My address change requests ────────────────────────────────────
async function myAddressChangeRequests(req, res) {
  const requests = await prisma.addressChangeRequest.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
    include: {
      shipment: { select: { trackingNumber: true, status: true } },
    },
  });
  return success(res, { requests });
}

// ─── Admin: List pending requests ────────────────────────────────────────────
async function listAddressChangeRequests(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { status } = req.query;

  const where = status ? { status } : {};

  const [requests, total] = await Promise.all([
    prisma.addressChangeRequest.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        shipment: { select: { trackingNumber: true, senderCity: true, recipientCity: true, status: true } },
        user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
      },
    }),
    prisma.addressChangeRequest.count({ where }),
  ]);

  return res.json({ success: true, data: { requests }, meta: buildMeta(total, page, limit) });
}

// ─── Admin: Approve or reject ─────────────────────────────────────────────────
async function reviewAddressChange(req, res) {
  const { id } = req.params;
  const { action, reviewNote } = req.body; // action: 'APPROVE' | 'REJECT'

  if (!['APPROVE', 'REJECT'].includes(action)) {
    throw new ApiError(400, 'action must be APPROVE or REJECT');
  }

  const changeReq = await prisma.addressChangeRequest.findUnique({
    where: { id },
    include: { shipment: true },
  });
  if (!changeReq) throw new ApiError(404, 'Request not found');
  if (changeReq.status !== 'PENDING') throw new ApiError(400, 'Request already reviewed');

  const newStatus = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';

  await prisma.addressChangeRequest.update({
    where: { id },
    data: {
      status: newStatus,
      reviewedBy: req.user.id,
      reviewedAt: new Date(),
      reviewNote,
    },
  });

  if (action === 'APPROVE') {
    // Apply the address change to the shipment
    await prisma.shipment.update({
      where: { id: changeReq.shipmentId },
      data: {
        recipientAddress: changeReq.newRecipientAddress,
        recipientCity: changeReq.newRecipientCity,
        recipientState: changeReq.newRecipientState,
        status: 'CONFIRMED', // restore to confirmed after review
      },
    });
  } else {
    // Restore previous status
    await prisma.shipment.update({
      where: { id: changeReq.shipmentId },
      data: { status: changeReq.shipment.status === 'PENDING_ADMIN_REVIEW' ? 'CONFIRMED' : changeReq.shipment.status },
    });
  }

  // Notify customer
  await prisma.notification.create({
    data: {
      userId: changeReq.userId,
      type: 'SHIPMENT_UPDATE',
      title: action === 'APPROVE' ? 'Address Change Approved' : 'Address Change Rejected',
      body: action === 'APPROVE'
        ? `Your address change for shipment ${changeReq.shipment.trackingNumber} has been approved.`
        : `Your address change request was rejected. Reason: ${reviewNote || 'No reason provided.'}`,
      data: { shipmentId: changeReq.shipmentId },
    },
  });

  return success(res, {}, `Request ${newStatus.toLowerCase()}`);
}

module.exports = {
  requestAddressChange,
  myAddressChangeRequests,
  listAddressChangeRequests,
  reviewAddressChange,
};
