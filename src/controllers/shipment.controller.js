const { prisma } = require("../config/db");
const { calculateShippingCost } = require("../services/pricing.service");
const { sendShipmentStatusEmail } = require("../config/email");
const { ApiError } = require("../utils/ApiError");
const {
  success,
  created,
  generateTrackingNumber,
  getPagination,
  buildMeta,
} = require("../utils/helpers");

// ─── CREATE SHIPMENT ──────────────────────────────────────────────────────────
async function createShipment(req, res) {
  const {
    senderName,
    senderPhone,
    senderAddress,
    senderCity,
    senderState,
    recipientName,
    recipientPhone,
    recipientAddress,
    recipientCity,
    recipientState,
    description,
    weightKg,
    weightUnit,
    tons,
    cartons,
    boxDimensionId,
    customLength,
    customWidth,
    customHeight,
    serviceType,
    isFragile,
    requiresInsurance,
    insuranceValue,
    notes,
    pickupDate,
  } = req.body;

  // insuranceValue: frontend can omit entirely — backend auto-calculates at 110% of base price.
  // If frontend provides it, use that value (customer declared value takes precedence).
  const resolvedInsuranceValue = requiresInsurance
    ? (insuranceValue || null)  // null tells pricing service to auto-calculate
    : 0;

  const quote = await calculateShippingCost({
    fromCity: senderCity,
    toCity: recipientCity,
    weightKg: weightKg || null,
    tons: tons || null,
    cartons: cartons || null,
    boxDimensionId: boxDimensionId || null,
    customLength,
    customWidth,
    customHeight,
    serviceType: serviceType || "STANDARD",
    isFragile: !!isFragile,
    requiresInsurance: !!requiresInsurance,
    insuranceValue: resolvedInsuranceValue,
    userId: req.user?.id,
  });

  // quotedPrice already includes all surcharges from calculateShippingCost
  let quotedPrice = quote.total;

  const shipment = await prisma.shipment.create({
    data: {
      trackingNumber: generateTrackingNumber(),
      customerId: req.user.id,
      senderName,
      senderPhone,
      senderAddress,
      senderCity,
      senderState,
      recipientName,
      recipientPhone,
      recipientAddress,
      recipientCity,
      recipientState,
      description,
      weight: quote.weightKg,
      weightUnit: weightUnit || "KG",
      cartons: cartons ? parseInt(cartons) : null,
      boxDimensionId,
      customLength,
      customWidth,
      customHeight,
      fromCityId: quote.fromCity.id,
      toCityId: quote.toCity.id,
      zone: quote.zone,
      distanceKm: quote.distanceKm,
      quotedPrice,
      isFragile: !!isFragile,
      requiresInsurance: !!requiresInsurance,
      insuranceValue: resolvedInsuranceValue,
      notes,
      pickupDate: pickupDate ? new Date(pickupDate) : null,
      trackingHistory: {
        create: {
          status: "PENDING",
          description: "Shipment created and awaiting confirmation",
          updatedBy: req.user.id,
        },
      },
    },
    include: {
      trackingHistory: true,
      fromCity: { select: { id: true, name: true, region: true, state: true } },
      toCity:   { select: { id: true, name: true, region: true, state: true } },
    },
  });

  return created(res, { shipment, quote }, "Shipment created successfully");
}

// ─── LIST SHIPMENTS (Customer) ────────────────────────────────────────────────
async function listMyShipments(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { status, search } = req.query;

  const where = {
    customerId: req.user.id,
    ...(status && { status }),
    ...(search && {
      OR: [
        { trackingNumber: { contains: search, mode: "insensitive" } },
        { recipientName: { contains: search, mode: "insensitive" } },
        { recipientCity: { contains: search, mode: "insensitive" } },
      ],
    }),
  };

  const [shipments, total] = await Promise.all([
    prisma.shipment.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        trackingHistory: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    }),
    prisma.shipment.count({ where }),
  ]);

  return res.json({
    success: true,
    data: { shipments },
    meta: buildMeta(total, page, limit),
  });
}

// ─── GET SINGLE SHIPMENT ──────────────────────────────────────────────────────
async function getShipment(req, res) {
  const { id } = req.params;

  const where = {
    OR: [{ id }, { trackingNumber: id }],
  };

  const shipment = await prisma.shipment.findFirst({
    where,
    include: {
      customer: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          avatar: true,
        },
      },
      assignedTo: {
        select: { id: true, firstName: true, lastName: true },
      },
      fromCity: { select: { id: true, name: true, region: true, state: true } },
      toCity:   { select: { id: true, name: true, region: true, state: true } },
      trackingHistory: { orderBy: { createdAt: "asc" } },
      documents: true,
    },
  });

  if (!shipment) throw new ApiError(404, "Shipment not found");

  // Customer can only view their own shipments
  if (req.user.role === "CUSTOMER" && shipment.customerId !== req.user.id) {
    throw new ApiError(403, "Access denied");
  }

  return success(res, { shipment });
}

// ─── PUBLIC TRACKING (no auth) ────────────────────────────────────────────────
async function trackShipment(req, res) {
  const { trackingNumber } = req.params;

  const shipment = await prisma.shipment.findUnique({
    where: { trackingNumber },
    select: {
      trackingNumber: true,
      status: true,
      senderCity: true,
      senderState: true,
      recipientName: true,
      recipientCity: true,
      recipientState: true,
      pickupDate: true,
      estimatedDelivery: true,
      deliveredAt: true,
      trackingHistory: {
        orderBy: { createdAt: "asc" },
        select: {
          status: true,
          location: true,
          description: true,
          createdAt: true,
          proofUrl: true,
        },
      },
    },
  });

  if (!shipment) throw new ApiError(404, "Tracking number not found");

  return success(res, { shipment });
}

// ─── UPDATE STATUS (Admin) ────────────────────────────────────────────────────
async function updateShipmentStatus(req, res) {
  const { id } = req.params;
  const {
    status,
    location,
    description,
    lat,
    lng,
    proofUrl,
    estimatedDelivery,
  } = req.body;

  const shipment = await prisma.shipment.findUnique({
    where: { id },
    include: { customer: { select: { email: true, firstName: true } } },
  });
  if (!shipment) throw new ApiError(404, "Shipment not found");

  const updateData = {
    status,
    ...(estimatedDelivery && {
      estimatedDelivery: new Date(estimatedDelivery),
    }),
    ...(status === "DELIVERED" && {
      deliveredAt: new Date(),
      paymentStatus: "PAID",
    }),
  };

  const [updated] = await prisma.$transaction([
    prisma.shipment.update({
      where: { id },
      data: updateData,
    }),
    prisma.trackingEvent.create({
      data: {
        shipmentId: id,
        status,
        location,
        description: description || `Status updated to ${status}`,
        lat,
        lng,
        proofUrl,
        updatedBy: req.user.id,
      },
    }),
  ]);

  // Send email notification
  try {
    await sendShipmentStatusEmail(
      shipment.customer.email,
      shipment.customer.firstName,
      { ...shipment, status },
    );
  } catch (e) {
    console.error("Email notification failed:", e.message);
  }

  // Create in-app notification
  await prisma.notification.create({
    data: {
      userId: shipment.customerId,
      type: "SHIPMENT_UPDATE",
      title: `Shipment ${shipment.trackingNumber}`,
      body:
        description ||
        `Your shipment is now ${status.replace(/_/g, " ").toLowerCase()}`,
      data: { shipmentId: id, status, trackingNumber: shipment.trackingNumber },
    },
  });

  return success(res, { shipment: updated }, "Status updated");
}

// ─── ASSIGN SHIPMENT ──────────────────────────────────────────────────────────
async function assignShipment(req, res) {
  const { id } = req.params;
  const { userId } = req.body;

  const shipment = await prisma.shipment.update({
    where: { id },
    data: { assignedToId: userId },
    include: {
      assignedTo: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  return success(res, { shipment }, "Shipment assigned");
}

// ─── CANCEL SHIPMENT ──────────────────────────────────────────────────────────
// ─── CANCEL PREVIEW — step 1: returns calculated refund before confirming ─────
async function cancelPreview(req, res) {
  const { id } = req.params;

  const shipment = await prisma.shipment.findFirst({
    where: { id, customerId: req.user.id },
    include: {
      payment: {
        where: { status: "PAID" },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });
  if (!shipment) throw new ApiError(404, "Shipment not found");

  if (!["PENDING", "CONFIRMED"].includes(shipment.status)) {
    throw new ApiError(400, "Shipment cannot be cancelled at this stage");
  }

  const payment = shipment.payment?.[0] || null;
  const paidAmount = payment ? payment.amountKobo / 100 : 0;

  // Refund policy: 100% if PENDING (not yet confirmed), 80% if CONFIRMED
  let refundPercent = 0;
  let refundReason = "";
  if (!payment || paidAmount === 0) {
    refundPercent = 0;
    refundReason = "No payment made — no refund applicable";
  } else if (shipment.status === "PENDING") {
    refundPercent = 100;
    refundReason = "Full refund — shipment not yet confirmed";
  } else if (shipment.status === "CONFIRMED") {
    refundPercent = 80;
    refundReason = "Partial refund (80%) — shipment already confirmed";
  }

  const refundAmount = Math.floor(paidAmount * (refundPercent / 100));

  return success(
    res,
    {
      shipmentId: id,
      trackingNumber: shipment.trackingNumber,
      paidAmount,
      refundAmount,
      refundPercent,
      refundType:
        refundPercent === 100 ? "FULL" : refundPercent > 0 ? "PARTIAL" : "NONE",
      refundReason,
      currency: "NGN",
      note: "Refund processed via Paystack. Est. 3–5 business days.",
    },
    "Refund preview calculated",
  );
}

// ─── CANCEL CONFIRM — step 2: actually cancels and triggers refund ────────────
async function cancelShipment(req, res) {
  const { id } = req.params;
  const { reason } = req.body;

  const shipment = await prisma.shipment.findFirst({
    where: { id, customerId: req.user.id },
    include: {
      payment: {
        where: { status: "PAID" },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });
  if (!shipment) throw new ApiError(404, "Shipment not found");

  if (!["PENDING", "CONFIRMED"].includes(shipment.status)) {
    throw new ApiError(
      400,
      "Cannot cancel a shipment that is already in transit",
    );
  }

  const payment = shipment.payment?.[0] || null;
  const paidAmount = payment ? payment.amountKobo / 100 : 0;

  let refundAmount = 0;
  if (payment && paidAmount > 0) {
    const refundPercent = shipment.status === "PENDING" ? 100 : 80;
    refundAmount = Math.floor(paidAmount * (refundPercent / 100));
  }

  // Cancel the shipment
  await prisma.$transaction([
    prisma.shipment.update({ where: { id }, data: { status: "CANCELLED" } }),
    prisma.trackingEvent.create({
      data: {
        shipmentId: id,
        status: "CANCELLED",
        description: reason || "Cancelled by customer",
        updatedBy: req.user.id,
      },
    }),
  ]);

  // Trigger refund if payment exists
  let refundResult = null;
  if (payment && refundAmount > 0) {
    const { refundPayment } = require("../services/paystack.service");
    refundResult = await refundPayment(payment.reference, refundAmount);
  }

  return success(
    res,
    {
      cancelled: true,
      refundAmount,
      refundInitiated: !!refundResult,
      currency: "NGN",
    },
    refundResult
      ? `Shipment cancelled. Refund of ₦${refundAmount.toLocaleString()} initiated.`
      : "Shipment cancelled. No refund applicable.",
  );
}

// ─── ADMIN: LIST ALL SHIPMENTS ────────────────────────────────────────────────
async function adminListShipments(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { status, search, assignedTo, fromDate, toDate } = req.query;

  const where = {
    ...(status && { status }),
    ...(assignedTo && { assignedToId: assignedTo }),
    ...(fromDate || toDate
      ? {
          createdAt: {
            ...(fromDate && { gte: new Date(fromDate) }),
            ...(toDate && { lte: new Date(toDate) }),
          },
        }
      : {}),
    ...(search && {
      OR: [
        { trackingNumber: { contains: search, mode: "insensitive" } },
        { senderName: { contains: search, mode: "insensitive" } },
        { recipientName: { contains: search, mode: "insensitive" } },
        { senderCity: { contains: search, mode: "insensitive" } },
        { recipientCity: { contains: search, mode: "insensitive" } },
      ],
    }),
  };

  const [shipments, total] = await Promise.all([
    prisma.shipment.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        customer: {
          select: { id: true, firstName: true, lastName: true, phone: true },
        },
        assignedTo: { select: { id: true, firstName: true, lastName: true } },
        fromCity: { select: { id: true, name: true, state: true } },
        toCity:   { select: { id: true, name: true, state: true } },
        trackingHistory: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    }),
    prisma.shipment.count({ where }),
  ]);

  return res.json({
    success: true,
    data: { shipments },
    meta: buildMeta(total, page, limit),
  });
}

// ─── ADMIN: STATS OVERVIEW ────────────────────────────────────────────────────
async function getShipmentStats(req, res) {
  const [total, pending, inTransit, delivered, cancelled] = await Promise.all([
    prisma.shipment.count(),
    prisma.shipment.count({ where: { status: "PENDING" } }),
    prisma.shipment.count({
      where: {
        status: {
          in: ["CONFIRMED", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY"],
        },
      },
    }),
    prisma.shipment.count({ where: { status: "DELIVERED" } }),
    prisma.shipment.count({ where: { status: "CANCELLED" } }),
  ]);

  const revenue = await prisma.shipment.aggregate({
    where: { paymentStatus: "PAID" },
    _sum: { finalPrice: true, quotedPrice: true },
  });

  return success(res, {
    stats: { total, pending, inTransit, delivered, cancelled },
    revenue: {
      total: revenue._sum.finalPrice || revenue._sum.quotedPrice || 0,
      currency: "NGN",
    },
  });
}

module.exports = {
  createShipment,
  listMyShipments,
  getShipment,
  trackShipment,
  updateShipmentStatus,
  assignShipment,
  cancelPreview,
  cancelShipment,
  adminListShipments,
  getShipmentStats,
};
