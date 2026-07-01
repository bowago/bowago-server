const { prisma } = require("../config/db");
const { checkProximityAndNotify } = require("../services/proximity.service");
const { calculateShippingCost } = require("../services/pricing.service");
const { sendShipmentStatusEmail } = require("../config/email");
const socketService = require("../services/socket.service");
const { getEstimatedDelivery } = require("./deliverySLA.controller");
const { ApiError } = require("../utils/ApiError");
const {
  success,
  created,
  generateTrackingNumber,
  getPagination,
  buildMeta,
} = require("../utils/helpers");
const { earnPoints } = require("../services/loyalty.service");
const { autoGenerateInvoice } = require("./invoice.controller");

// ─── Sprint 7: Consent helper ─────────────────────────────────────────────────
async function recordConsent(userId, consentType, req) {
  try {
    await prisma.consentLog.create({
      data: {
        userId: userId || null,
        consentType,
        tcVersion: process.env.TC_VERSION || "v1.0",
        ipAddress: req.ip || req.headers["x-forwarded-for"] || null,
        userAgent: req.headers["user-agent"] || null,
      },
    });
  } catch (_) {
    /* non-blocking */
  }
}

// ─── CREATE SHIPMENT ──────────────────────────────────────────────────────────
async function createShipment(req, res) {
  console.log("[createShipment] START — body keys:", Object.keys(req.body));
  console.log("[createShipment] user:", req.user?.id, "role:", req.user?.role);

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
    quoteId,
  } = req.body;

  console.log(
    "[createShipment] route:",
    senderCity,
    "→",
    recipientCity,
    "| quoteId:",
    quoteId || "none",
  );
  console.log(
    "[createShipment] weight params — weightKg:",
    weightKg,
    "tons:",
    tons,
    "cartons:",
    cartons,
    "boxDimensionId:",
    boxDimensionId,
  );

  let lockedQuote = null;
  let quote;
  let quotedPrice;
  let resolvedServiceType = serviceType || "STANDARD";
  let resolvedInsuranceValue = requiresInsurance ? insuranceValue || null : 0;

  if (quoteId) {
    console.log("[createShipment] using locked quote:", quoteId);
    lockedQuote = await prisma.quote.findUnique({ where: { id: quoteId } });
    if (!lockedQuote) throw new ApiError(404, "Quote not found");

    if (lockedQuote.userId && lockedQuote.userId !== req.user.id) {
      throw new ApiError(403, "This quote does not belong to your account");
    }

    if (lockedQuote.status === "CANCELLED") {
      throw new ApiError(
        400,
        "This quote was cancelled. Please generate a new quote.",
      );
    }
    if (lockedQuote.status !== "GENERATED") {
      throw new ApiError(
        400,
        `This quote has already been used (status: ${lockedQuote.status}). Please generate a new quote.`,
      );
    }
    if (new Date() > lockedQuote.expiresAt) {
      await prisma.quote.update({
        where: { id: quoteId },
        data: { status: "EXPIRED" },
      });
      throw new ApiError(
        400,
        "This quote has expired (15-minute limit). Please generate a new quote.",
      );
    }

    const [fromCityRec, toCityRec] = await Promise.all([
      prisma.city.findUnique({ where: { id: lockedQuote.originCityId } }),
      prisma.city.findUnique({ where: { id: lockedQuote.destinationCityId } }),
    ]);
    if (!fromCityRec || !toCityRec) {
      throw new ApiError(
        400,
        "Quote references a city that no longer exists. Please generate a new quote.",
      );
    }

    if (
      fromCityRec.name.toLowerCase() !==
        String(senderCity ?? "").toLowerCase() ||
      toCityRec.name.toLowerCase() !== String(recipientCity ?? "").toLowerCase()
    ) {
      console.log(
        "[createShipment] city mismatch — quoted:",
        fromCityRec.name,
        toCityRec.name,
        "| sent:",
        senderCity,
        recipientCity,
      );
      throw new ApiError(
        400,
        "Sender/recipient cities do not match the quoted route. Please generate a new quote.",
      );
    }

    quote = {
      zone: lockedQuote.zone,
      distanceKm: lockedQuote.distanceKm,
      weightKg: lockedQuote.billableWeightKg ?? lockedQuote.weightKg,
      fromCity: fromCityRec,
      toCity: toCityRec,
    };

    quotedPrice = lockedQuote.totalPriceKobo / 100;
    resolvedServiceType = lockedQuote.serviceType;

    if (lockedQuote.insuranceSelected && lockedQuote.declaredValueKobo) {
      resolvedInsuranceValue = lockedQuote.declaredValueKobo / 100;
    }
  } else {
    console.log("[createShipment] no quoteId — calculating live price");
    quote = await calculateShippingCost({
      fromCity: senderCity,
      toCity: recipientCity,
      weightKg: weightKg || null,
      tons: tons || null,
      cartons: cartons || null,
      boxDimensionId: boxDimensionId || null,
      customLength,
      customWidth,
      customHeight,
      serviceType: resolvedServiceType,
      isFragile: !!isFragile,
      requiresInsurance: !!requiresInsurance,
      insuranceValue: resolvedInsuranceValue,
      userId: req.user?.id,
    });
    quotedPrice = quote.total;
  }

  console.log(
    "[createShipment] quote resolved — zone:",
    quote.zone,
    "weightKg:",
    quote.weightKg,
    "quotedPrice:",
    quotedPrice,
  );

  let resolvedPickupDate = pickupDate ? new Date(pickupDate) : new Date();
  let cutoffWarning = false;

  try {
    const nowWAT = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Africa/Lagos" }),
    );
    const bookingHour = nowWAT.getHours();
    if (bookingHour >= 14) {
      cutoffWarning = true;
      if (!pickupDate) {
        const next = new Date(nowWAT);
        next.setDate(next.getDate() + 1);
        while (next.getDay() === 0 || next.getDay() === 6) {
          next.setDate(next.getDate() + 1);
        }
        resolvedPickupDate = next;
      }
    }
    console.log(
      "[createShipment] cutoffWarning:",
      cutoffWarning,
      "| resolvedPickupDate:",
      resolvedPickupDate,
    );
  } catch (tzErr) {
    console.warn("[createShipment] timezone error (non-fatal):", tzErr.message);
  }

  const slaResult = await getEstimatedDelivery(
    quote.zone,
    resolvedServiceType,
    resolvedPickupDate,
  );
  console.log(
    "[createShipment] SLA estimated delivery:",
    slaResult.estimatedDelivery,
  );

  // PRD Sprint 3 state machine: Quoted → BOOKED (on creation) → Paid → Awaiting Pickup
  console.log("[createShipment] creating shipment record in DB...");
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
      boxDimensionId: boxDimensionId || null,
      customLength: customLength || null,
      customWidth: customWidth || null,
      customHeight: customHeight || null,
      fromCityId: quote.fromCity?.id || null,
      toCityId: quote.toCity?.id || null,
      zone: quote.zone || null,
      distanceKm: quote.distanceKm || null,
      serviceType: resolvedServiceType,
      quotedPrice,
      isFragile: !!isFragile,
      requiresInsurance: !!requiresInsurance,
      insuranceValue: resolvedInsuranceValue || null,
      notes: notes || null,
      pickupDate: resolvedPickupDate,
      estimatedDelivery: slaResult.estimatedDelivery,
      trackingHistory: {
        create: {
          status: "PENDING",
          description: "Shipment booked and awaiting payment",
          updatedBy: req.user.id,
        },
      },
    },
    include: {
      trackingHistory: true,
      fromCity: { select: { id: true, name: true, region: true, state: true } },
      toCity: { select: { id: true, name: true, region: true, state: true } },
    },
  });

  console.log(
    "[createShipment] shipment created — id:",
    shipment.id,
    "tracking:",
    shipment.trackingNumber,
  );

  if (lockedQuote) {
    await prisma.quote.update({
      where: { id: lockedQuote.id },
      data: { status: "BOOKED", bookedAt: new Date(), shipmentId: shipment.id },
    });
    console.log("[createShipment] quote marked BOOKED");
  }

  // Sprint 7: SHIPPING_RULES consent (fire-and-forget)
  recordConsent(req.user.id, "SHIPPING_RULES", req);

  return created(
    res,
    { shipment, quote, cutoffWarning },
    cutoffWarning
      ? "Shipment created. Booking after 2PM — earliest pickup is next business day."
      : "Shipment created successfully",
  );
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
      toCity: { select: { id: true, name: true, region: true, state: true } },
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
      serviceType: true,
      senderName: true,
      senderCity: true,
      senderState: true,
      senderAddress: true,
      recipientName: true,
      recipientCity: true,
      recipientState: true,
      recipientAddress: true,
      customerId: true,
      pickupDate: true,
      estimatedDelivery: true,
      deliveredAt: true,
      quotedPrice: true,
      weight: true,
      weightUnit: true,
      cartons: true,
      trackingHistory: {
        orderBy: { createdAt: "asc" },
        select: {
          status: true,
          location: true,
          description: true,
          createdAt: true,
          proofUrl: true,
          lat: true,
          lng: true,
        },
      },
    },
  });

  if (!shipment) throw new ApiError(404, "Tracking number not found");

  // ── Address masking for unauthenticated/public access ─────────────────────
  // PRD Sprint 4: Non-logged-in users see only city/state, not full street.
  // Logged-in users who own the shipment see full addresses.
  const viewerId = req.user?.id;
  const isOwner = viewerId && viewerId === shipment.customerId;

  // PRD Sprint 4: "123 Main Street, Lagos, Lagos State, NG" → "Lagos, Lagos State, NG"
  // Guests see city + state only; map marker still shows exact location.
  // Logged-in owners see full street address.
  const masked = {
    ...shipment,
    senderAddress: isOwner
      ? shipment.senderAddress
      : [shipment.senderCity, shipment.senderState, "NG"]
          .filter(Boolean)
          .join(", "),
    recipientAddress: isOwner
      ? shipment.recipientAddress
      : [shipment.recipientCity, shipment.recipientState, "NG"]
          .filter(Boolean)
          .join(", "),
    recipientName: isOwner
      ? shipment.recipientName
      : (shipment.recipientName?.split(" ")[0] ?? "") + " ***",
    senderName: isOwner
      ? shipment.senderName
      : (shipment.senderName?.split(" ")[0] ?? "") + " ***",
  };

  // Remove internal fields from response
  delete masked.customerId;

  return success(res, { shipment: masked });
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
  const notification = await prisma.notification.create({
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

  // ─── Sprint 4: Real-time push via WebSocket ──────────────────────────────
  // Fetch updated timeline so the tracking room gets the full event list
  const timeline = await prisma.trackingEvent.findMany({
    where: { shipmentId: id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  socketService.emitShipmentUpdate(updated, timeline);
  socketService.emitNotification(shipment.customerId, notification);

  // ── On DELIVERED: auto-generate invoice + earn loyalty points ─────────────
  if (status === "DELIVERED") {
    // Auto-invoice (non-blocking — failure must not affect the status update response)
    autoGenerateInvoice(updated).catch((err) =>
      console.error("[AutoInvoice] Failed for shipment", updated.trackingNumber, err.message),
    );

    // Loyalty points earn
    const finalPrice = updated.finalPrice ?? updated.quotedPrice;
    earnPoints({
      userId:           shipment.customerId,
      shipmentId:       id,
      finalPriceNaira:  finalPrice,
    }).catch((err) =>
      console.error("[Loyalty] Earn failed for shipment", updated.trackingNumber, err.message),
    );
  }

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
  const isAdmin = ["ADMIN", "SUPER_ADMIN"].includes(req.user.role);

  // Admins can preview cancellation for any shipment; customers only for their own
  const whereClause = isAdmin ? { id } : { id, customerId: req.user.id };

  const shipment = await prisma.shipment.findFirst({
    where: whereClause,
    include: {
      payments: {
        where: { status: "PAID" },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });
  if (!shipment) throw new ApiError(404, "Shipment not found");

  const CANCELLABLE = ["PENDING", "BOOKED", "AWAITING_PICKUP", "CONFIRMED"];
  if (!CANCELLABLE.includes(shipment.status)) {
    throw new ApiError(400, "Shipment cannot be cancelled at this stage");
  }

  const payment = shipment.payments?.[0] || null;
  const paidAmount = payment ? payment.amountKobo / 100 : 0;

  // Refund policy per PRD:
  // PENDING / BOOKED (not yet paid)      → no refund applicable
  // AWAITING_PICKUP (paid, not picked up) → 100% full refund
  // CONFIRMED (paid, being processed)     → 80% partial refund
  let refundPercent = 0;
  let refundReason = "";
  if (!payment || paidAmount === 0) {
    refundPercent = 0;
    refundReason = "No payment made — no refund applicable";
  } else if (["PENDING", "BOOKED"].includes(shipment.status)) {
    refundPercent = 100;
    refundReason = "Full refund — payment made but shipment not yet processed";
  } else if (shipment.status === "AWAITING_PICKUP") {
    refundPercent = 100;
    refundReason = "Full refund — shipment paid but not yet picked up";
  } else if (shipment.status === "CONFIRMED") {
    refundPercent = 80;
    refundReason =
      "Partial refund (80%) — shipment already confirmed for processing";
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
  const isAdmin = ["ADMIN", "SUPER_ADMIN"].includes(req.user.role);

  // Admins can cancel any shipment; customers only their own
  const whereClause = isAdmin ? { id } : { id, customerId: req.user.id };

  const shipment = await prisma.shipment.findFirst({
    where: whereClause,
    include: {
      payments: {
        where: { status: "PAID" },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });
  if (!shipment) throw new ApiError(404, "Shipment not found");

  // ── PRD Sprint 3: Cancellable statuses aligned with refund rules table ─────────
  // PICKED_UP → partial 92% refund (warehouse fee deducted; PRD says 90-95%)
  // FAILED    → partial 95% refund (operator fee deducted; PRD: "full minus fee")
  // IN_TRANSIT / OUT_FOR_DELIVERY / DELIVERED → no cancel; must file claim
  const CANCELLABLE_STATUSES = [
    "PENDING",
    "BOOKED",
    "AWAITING_PICKUP",
    "CONFIRMED",
    "PICKED_UP",
    "FAILED",
  ];

  if (!CANCELLABLE_STATUSES.includes(shipment.status)) {
    throw new ApiError(
      400,
      shipment.status === "DELIVERED"
        ? "Cannot cancel a delivered shipment. File a damage/loss claim instead."
        : "Cannot cancel — shipment is in transit. Contact support or file a claim.",
    );
  }

  const payment = shipment.payments?.[0] || null;
  const paidAmount = payment ? payment.amountKobo / 100 : 0;

  // ── PRD refund % by status ────────────────────────────────────────────────────
  let refundPercent = 0;
  if (payment && paidAmount > 0) {
    if (
      ["PENDING", "BOOKED", "AWAITING_PICKUP", "CONFIRMED"].includes(
        shipment.status,
      )
    ) {
      refundPercent = 100;
    } else if (shipment.status === "PICKED_UP") {
      refundPercent = 92; // PRD: 90-95%; 92% midpoint (deduct warehouse fee)
    } else if (shipment.status === "FAILED") {
      refundPercent = 95; // PRD: full minus operator fee
    }
  }
  const refundAmount = Math.floor(paidAmount * (refundPercent / 100));

  // ── Cancel the shipment ───────────────────────────────────────────────────────
  await prisma.$transaction([
    prisma.shipment.update({
      where: { id },
      data: {
        status: "CANCELLED",
        // Mark paymentStatus REFUNDED immediately so UI reflects correct state
        ...(refundAmount > 0 && payment ? { paymentStatus: "REFUNDED" } : {}),
      },
    }),
    prisma.trackingEvent.create({
      data: {
        shipmentId: id,
        status: "CANCELLED",
        description:
          reason ||
          `Cancelled by ${req.user.role === "ADMIN" ? "admin" : "customer"}`,
        updatedBy: req.user.id,
      },
    }),
  ]);

  // ── Trigger Paystack refund ───────────────────────────────────────────────────
  let refundResult = null;
  if (payment && refundAmount > 0) {
    const { refundPayment } = require("../services/paystack.service");
    refundResult = await refundPayment(payment.reference, refundAmount);
  }

  // ── Notify customer ───────────────────────────────────────────────────────────
  await prisma.notification
    .create({
      data: {
        userId: shipment.customerId,
        type: "SHIPMENT_UPDATE",
        title: `Shipment ${shipment.trackingNumber} Cancelled`,
        body:
          refundAmount > 0
            ? `Your shipment has been cancelled. A refund of ₦${refundAmount.toLocaleString()} (${refundPercent}%) has been initiated and will reflect in 3-5 business days.`
            : `Your shipment has been cancelled. No refund is applicable.`,
        data: {
          shipmentId: id,
          status: "CANCELLED",
          trackingNumber: shipment.trackingNumber,
        },
      },
    })
    .catch(() => {}); // non-blocking

  return success(
    res,
    {
      cancelled: true,
      refundAmount,
      refundPercent,
      refundInitiated: !!refundResult,
      currency: "NGN",
    },
    refundResult
      ? `Shipment cancelled. Refund of ₦${refundAmount.toLocaleString()} (${refundPercent}%) initiated.`
      : "Shipment cancelled. No refund applicable.",
  );
}

// ─── ADMIN: LIST ALL SHIPMENTS ────────────────────────────────────────────────
async function adminListShipments(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { status, search, assignedTo, fromDate, toDate } = req.query;
  const subRole = req.user.adminSubRole;

  const statusFilter = (() => {
    if (!status) return undefined;
    const values = Array.isArray(status) ? status : String(status).split(",");
    return values.length > 1 ? { in: values } : values[0];
  })();

  // ── Org-scoped filtering (Sprint 8 team feature) ─────────────────────────
  // ROLE_DISPATCHER and ROLE_FINANCE see only their org's shipments:
  //   → their own shipments (they created) + shipments by other team members
  //     under the same master.
  // ROLE_MASTER sees all shipments created by any member of their org.
  // SUPER_ADMIN / LOGISTICS_MANAGER / ROLE_ADMIN → see everything.
  let orgFilter = {};

  const ORG_ROLES = ['ROLE_DISPATCHER', 'ROLE_FINANCE', 'ROLE_MASTER', 'ROLE_USER'];

  if (ORG_ROLES.includes(subRole)) {
    // Find all user IDs who belong to the same organisation
    // For ROLE_MASTER: masterId is the master themselves
    // For team members: masterId stored on their user record points to the master
    const masterId = subRole === 'ROLE_MASTER'
      ? req.user.id
      : req.user.masterId;

    if (masterId) {
      // Get all org members (master + their team)
      const orgMembers = await prisma.user.findMany({
        where: {
          OR: [
            { id: masterId },                 // the master
            { masterId: masterId },            // team members
          ],
        },
        select: { id: true },
      });
      const memberIds = orgMembers.map(u => u.id);
      orgFilter = { customerId: { in: memberIds } };
    } else {
      // No org link found — show only their own shipments
      orgFilter = { customerId: req.user.id };
    }
  }

  const where = {
    ...orgFilter,
    ...(statusFilter && { status: statusFilter }),
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
        toCity: { select: { id: true, name: true, state: true } },
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

// ─── DRIVER LOCATION UPDATE — Sprint 4 ───────────────────────────────────────
// POST /shipments/:id/driver-location
// Called by driver app every ~5 min. Appends a tracking event, broadcasts
// via Socket.IO, and triggers the PRD-specified proximity alert (≤ 500 m).
async function updateDriverLocation(req, res) {
  const { id } = req.params;
  const { lat, lng, location } = req.body;

  if (lat == null || lng == null) {
    throw new ApiError(400, "lat and lng are required");
  }

  const shipment = await prisma.shipment.findUnique({
    where: { id },
    select: { id: true, customerId: true, trackingNumber: true, status: true },
  });
  if (!shipment) throw new ApiError(404, "Shipment not found");

  // Persist as a tracking event so the map has data to display
  const event = await prisma.trackingEvent.create({
    data: {
      shipmentId: id,
      status: shipment.status,
      description: location ?? "Driver location updated",
      location: location ?? null,
      lat,
      lng,
      updatedBy: req.user.id,
    },
  });

  // Broadcast to tracking page subscribers (Socket.IO room = tracking:<number>)
  socketService.emitShipmentUpdate(shipment.trackingNumber, {
    type: "DRIVER_LOCATION",
    trackingNumber: shipment.trackingNumber,
    lat,
    lng,
    location: location ?? null,
    timestamp: event.createdAt,
  });

  // Proximity check — fire-and-forget, must not fail the response
  checkProximityAndNotify(id, lat, lng).catch((err) =>
    console.error("[proximity] check failed:", err.message),
  );

  return success(res, { lat, lng, location }, "Location updated");
}

// ─── ADMIN CSV EXPORT — Sprint 6 ─────────────────────────────────────────────
// GET /shipments/export/csv
// Downloads a .csv of all shipments, respecting optional filters.
// Uses the xlsx package that is already in package.json.
async function exportShipmentsCsv(req, res) {
  const { status, fromDate, toDate } = req.query;

  const where = {
    ...(status ? { status } : {}),
    ...(fromDate || toDate
      ? {
          createdAt: {
            ...(fromDate ? { gte: new Date(fromDate) } : {}),
            ...(toDate ? { lte: new Date(toDate) } : {}),
          },
        }
      : {}),
  };

  const shipments = await prisma.shipment.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 10_000,
    select: {
      trackingNumber: true,
      status: true,
      paymentStatus: true,
      serviceType: true,
      senderName: true,
      senderCity: true,
      senderState: true,
      recipientName: true,
      recipientCity: true,
      recipientState: true,
      weight: true,
      weightUnit: true,
      quotedPrice: true,
      finalPrice: true,
      pickupDate: true,
      estimatedDelivery: true,
      deliveredAt: true,
      createdAt: true,
      customer: { select: { email: true, firstName: true, lastName: true } },
    },
  });

  const XLSX = require("xlsx");

  const rows = shipments.map((s) => ({
    "Tracking Number": s.trackingNumber,
    Status: s.status,
    "Payment Status": s.paymentStatus,
    Service: s.serviceType,
    "Customer Name": s.customer
      ? `${s.customer.firstName} ${s.customer.lastName}`
      : "",
    "Customer Email": s.customer?.email ?? "",
    "Sender Name": s.senderName,
    "Sender City": s.senderCity,
    "Sender State": s.senderState,
    "Recipient Name": s.recipientName,
    "Recipient City": s.recipientCity,
    "Recipient State": s.recipientState,
    Weight: s.weight != null ? `${s.weight} ${s.weightUnit ?? "kg"}` : "",
    "Quoted Price (N)":
      s.quotedPrice != null ? (s.quotedPrice / 100).toFixed(2) : "",
    "Final Price (N)":
      s.finalPrice != null ? (s.finalPrice / 100).toFixed(2) : "",
    "Pickup Date": s.pickupDate
      ? new Date(s.pickupDate).toISOString().slice(0, 10)
      : "",
    "Est. Delivery": s.estimatedDelivery
      ? new Date(s.estimatedDelivery).toISOString().slice(0, 10)
      : "",
    "Delivered At": s.deliveredAt
      ? new Date(s.deliveredAt).toISOString().slice(0, 10)
      : "",
    "Created At": new Date(s.createdAt).toISOString().slice(0, 10),
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Shipments");

  const date = new Date().toISOString().slice(0, 10);
  const filename = `BowaGo-Shipments-${date}.csv`;
  const buf = XLSX.write(wb, { type: "buffer", bookType: "csv" });

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(buf);
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
  updateDriverLocation,
  exportShipmentsCsv,
};
