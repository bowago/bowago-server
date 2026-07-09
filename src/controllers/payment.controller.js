const { prisma } = require("../config/db");
const {
  initializePayment,
  verifyPayment,
  refundPayment,
  verifyWebhookSignature,
} = require("../services/paystack.service");
const { ApiError } = require("../utils/ApiError");
const { success, getPagination, buildMeta } = require("../utils/helpers");
const {
  processWebhookWithRetry,
  replayDeadLetter,
} = require("../services/webhook.service");

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
  } catch (err) {
    console.error("[Consent] Failed to log payment consent:", err.message);
  }
}

// ─── Initialize Payment ───────────────────────────────────────────────────────
async function initPayment(req, res) {
  const { shipmentId, refundPolicyAccepted } = req.body;
  const userId = req.user.id;
  const email = req.user.email;

  // ─── Sprint 7: Refund policy consent required before payment ────────────
  if (!refundPolicyAccepted) {
    throw new ApiError(
      400,
      "You must acknowledge the Refund Policy before proceeding to payment.",
    );
  }
  const idempotencyKey =
    req.headers["idempotency-key"] || req.headers["x-idempotency-key"];
  if (idempotencyKey) {
    const cached = await prisma.payment.findFirst({
      where: {
        idempotencyKey,
        userId,
        createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) }, // 60-min TTL
      },
    });
    if (cached) {
      return success(
        res,
        {
          reference: cached.reference,
          authorizationUrl: cached.authorizationUrl,
          accessCode: cached.accessCode,
          idempotent: true,
        },
        "Payment already initialized (idempotent response)",
      );
    }
  }

  // Only customers can initiate Paystack payment — admins use markAsPaid instead.
  const shipment = await prisma.shipment.findFirst({
    where: { id: shipmentId, customerId: userId },
  });
  if (!shipment) throw new ApiError(404, "Shipment not found");
  if (shipment.paymentStatus === "PAID")
    throw new ApiError(400, "Shipment is already paid");

  // Reuse unexpired PENDING payment (prevents duplicate Paystack tx) ──
  // If a PENDING payment already exists for this shipment and was created within
  // the last 30 minutes, reuse its authorization URL instead of creating a new one.
  const existingPending = await prisma.payment.findFirst({
    where: {
      shipmentId,
      userId,
      status: "PENDING",
      createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) }, // 30-min window
    },
    orderBy: { createdAt: "desc" },
  });

  if (existingPending && existingPending.authorizationUrl) {
    return success(
      res,
      {
        reference: existingPending.reference,
        authorizationUrl: existingPending.authorizationUrl,
        accessCode: existingPending.accessCode,
        reused: true,
      },
      "Existing payment session reused",
    );
  }

  const result = await initializePayment({
    userId,
    shipmentId,
    amountNaira: shipment.quotedPrice,
    email,
    idempotencyKey: idempotencyKey || null,
    metadata: {
      trackingNumber: shipment.trackingNumber,
      recipientCity: shipment.recipientCity,
    },
  });

  // Sprint 7: Log REFUND_POLICY consent (fire-and-forget)
  recordConsent(userId, "REFUND_POLICY", req);

  return success(res, result, "Payment initialized");
}

// ─── Create or fetch a PENDING payment record for invoice generation ──────────
// Used by "Generate Invoice Only" — creates a Payment row (no Paystack call,
// no authorization URL) so a proforma invoice can be downloaded/emailed
// before the customer actually pays. If a payment already exists for this
// shipment (pending or paid), that record is reused instead of duplicating.
async function initPendingPayment(req, res) {
  const { shipmentId } = req.body;
  const userId = req.user.id;

  const shipment = await prisma.shipment.findFirst({
    where: { id: shipmentId, customerId: userId },
  });
  if (!shipment) throw new ApiError(404, "Shipment not found");

  // Reuse any existing payment record for this shipment (PENDING or PAID)
  // so we don't create duplicate invoice numbers for the same shipment.
  let payment = await prisma.payment.findFirst({
    where: { shipmentId, userId },
    orderBy: { createdAt: "desc" },
  });

  if (!payment) {
    const reference = `BWG-${shipment.trackingNumber}-${Date.now().toString(36).toUpperCase()}`;
    payment = await prisma.payment.create({
      data: {
        reference,
        userId,
        shipmentId,
        amountKobo: Math.round((shipment.quotedPrice || 0) * 100),
        currency: "NGN",
        status: "PENDING",
      },
    });
  }

  return success(res, { payment }, "Invoice ready");
}

// ─── Verify Payment (called by frontend after redirect) ───────────────────────
async function verifyPaymentHandler(req, res) {
  const { reference } = req.params;

  const result = await verifyPayment(reference);

  if (result.alreadyProcessed) {
    return success(
      res,
      { payment: result.payment },
      "Payment already verified",
    );
  }

  return success(
    res,
    { payment: result.payment },
    result.payment.status === "PAID"
      ? "Payment verified successfully"
      : "Payment verification failed",
  );
}

// ─── Paystack Webhook ─────────────────────────────────────────────────────────
// Paystack calls this URL automatically after every transaction event
async function webhook(req, res) {
  const signature = req.headers["x-paystack-signature"];

  // Always respond 200 first so Paystack doesn't retry on its own schedule —
  // we handle retries ourselves via processWebhookWithRetry below.
  res.status(200).json({ received: true });

  if (!verifyWebhookSignature(req.body, signature)) {
    console.error("Invalid Paystack webhook signature");
    return;
  }

  const { event, data } = req.body;

  if (event === "charge.success") {
    await processWebhookWithRetry(event, req.body, async () => {
      await verifyPayment(data.reference);
    });
  } else if (event === "refund.processed") {
    await processWebhookWithRetry(event, req.body, async () => {
      // Refund already handled in refundPayment(); this just confirms via webhook.
      console.log(`Refund processed for ${data.transaction_reference}`);
    });
  }
  // Unrecognized events are acknowledged (200 already sent) but not processed.
}

// ─── Paystack callback (browser redirect after payment) ───────────────────────
async function paystackCallback(req, res) {
  // Paystack redirects here after the user completes (or cancels) payment in
  // their popup. We verify the payment then redirect the user to the frontend
  // payment callback page with the result embedded in the query string.
  const { reference, trxref } = req.query;
  const ref = reference || trxref;

  // Use only the PRIMARY frontend URL for redirects — CLIENT_URL must be a
  // single URL. Multiple origins for CORS go in CORS_ORIGINS env var.
  const primaryClient = (process.env.CLIENT_URL || "").split(",")[0].trim();
  const frontendCallback = primaryClient
    ? `${primaryClient}/dashboard/payment/callback`
    : null;

  if (!ref) {
    const fallback = frontendCallback
      ? `${frontendCallback}?status=failed&message=No+reference`
      : "/";
    return res.redirect(fallback);
  }

  try {
    const result = await verifyPayment(ref);
    const status = result.payment.status === "PAID" ? "success" : "failed";
    const dest = frontendCallback
      ? `${frontendCallback}?reference=${ref}&status=${status}`
      : `/?reference=${ref}&status=${status}`;
    return res.redirect(dest);
  } catch (err) {
    // Log the real reason so it appears in Vercel function logs
    console.error(
      `[paystackCallback] verifyPayment failed for ref=${ref}:`,
      err.message,
    );
    // Still send the reference so the frontend can retry verification itself
    const dest = frontendCallback
      ? `${frontendCallback}?reference=${ref}&status=failed&reason=${encodeURIComponent(err.message || "unknown")}`
      : "/";
    return res.redirect(dest);
  }
}

// ─── Refund ───────────────────────────────────────────────────────────────────
async function refundHandler(req, res) {
  const { reference } = req.params;
  const { amountNaira } = req.body;

  // PRD Sprint 3: refunds are governed by the shipment-status refund rules
  // table. Customers/Enterprise users must go through the cancellation flow
  // (POST /shipments/:id/cancel) which enforces those rules and calculates
  // the correct refund percentage. This direct endpoint is for internal
  // finance staff only (guarded at the route with requireInvoiceAccess) —
  // it previously let ANY payment owner refund themselves at any status,
  // including IN_TRANSIT and DELIVERED, bypassing the PRD refund rules.
  const payment = await prisma.payment.findUnique({
    where: { reference },
    include: { shipment: { select: { id: true, status: true, trackingNumber: true } } },
  });
  if (!payment) throw new ApiError(404, "Payment not found");

  // Even for finance staff, DELIVERED shipments follow the claims process —
  // the refund rules table says "File damage claim" for delivered shipments.
  if (payment.shipment?.status === "DELIVERED") {
    throw new ApiError(
      400,
      "Delivered shipments cannot be refunded directly. Resolve via the claims process instead.",
    );
  }

  const refunded = await refundPayment(reference, amountNaira || null);

  return success(res, { payment: refunded }, "Refund initiated successfully");
}

// ─── My Payments ──────────────────────────────────────────────────────────────
async function myPayments(req, res) {
  const { page, limit, skip } = getPagination(req.query);

  const where = { userId: req.user.id };

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        shipment: {
          select: {
            trackingNumber: true,
            recipientCity: true,
            recipientState: true,
            status: true,
          },
        },
      },
    }),
    prisma.payment.count({ where }),
  ]);

  // Convert kobo to naira for display
  const mapped = payments.map((p) => ({
    ...p,
    amountNaira: p.amountKobo / 100,
    refundAmountNaira: p.refundAmountKobo ? p.refundAmountKobo / 100 : null,
  }));

  return res.json({
    success: true,
    data: { payments: mapped },
    meta: buildMeta(total, page, limit),
  });
}

// ─── Admin: All Payments ──────────────────────────────────────────────────────
async function adminListPayments(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { status, search, fromDate, toDate } = req.query;

  const where = {
    ...(status && { status }),
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
        { reference: { contains: search, mode: "insensitive" } },
        { user: { email: { contains: search, mode: "insensitive" } } },
      ],
    }),
  };

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        user: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        shipment: { select: { trackingNumber: true, status: true } },
      },
    }),
    prisma.payment.count({ where }),
  ]);

  const mapped = payments.map((p) => ({
    ...p,
    amountNaira: p.amountKobo / 100,
  }));

  return res.json({
    success: true,
    data: { payments: mapped },
    meta: buildMeta(total, page, limit),
  });
}

// ─── Payment stats for admin dashboard ───────────────────────────────────────
async function paymentStats(req, res) {
  const [totalPaid, totalPending, totalRefunded, revenueAgg] =
    await Promise.all([
      prisma.payment.count({ where: { status: "PAID" } }),
      prisma.payment.count({ where: { status: "PENDING" } }),
      prisma.payment.count({ where: { status: "REFUNDED" } }),
      prisma.payment.aggregate({
        where: { status: "PAID" },
        _sum: { amountKobo: true },
      }),
    ]);

  return success(res, {
    stats: { totalPaid, totalPending, totalRefunded },
    revenue: {
      kobo: revenueAgg._sum.amountKobo || 0,
      naira: (revenueAgg._sum.amountKobo || 0) / 100,
      currency: "NGN",
    },
  });
}

// ─── ADMIN: List failed webhooks (Dead Letter Queue) ───────────────────────────
async function listFailedWebhooks(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { status } = req.query;

  const where = { ...(status && { status }) };

  const [items, total] = await Promise.all([
    prisma.failedWebhook.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.failedWebhook.count({ where }),
  ]);

  return success(res, { items, meta: buildMeta(total, page, limit) });
}

// ─── ADMIN: Retry a failed webhook ──────────────────────────────────────────────
async function retryFailedWebhook(req, res) {
  const { id } = req.params;

  const handlerMap = {
    "charge.success": async (payload) => {
      await verifyPayment(payload.data.reference);
    },
    "refund.processed": async (payload) => {
      console.log(`Refund processed for ${payload.data.transaction_reference}`);
    },
  };

  const result = await replayDeadLetter(id, handlerMap);

  if (!result.success) {
    throw new ApiError(400, `Retry failed: ${result.error}`);
  }

  return success(res, {}, "Webhook re-processed successfully");
}

// ─── ADMIN: Dismiss a failed webhook (mark as ignored) ─────────────────────────
async function dismissFailedWebhook(req, res) {
  const { id } = req.params;
  const entry = await prisma.failedWebhook.findUnique({ where: { id } });
  if (!entry) throw new ApiError(404, "DLQ entry not found");

  await prisma.failedWebhook.update({
    where: { id },
    data: { status: "IGNORED", resolvedAt: new Date() },
  });

  return success(res, {}, "Webhook entry dismissed");
}

// ─── MARK SHIPMENT AS PAID (Admin/Super Admin only) ──────────────────────────
// Used when a customer pays offline (cash, bank transfer, etc.) and an admin
// needs to record the payment manually without going through Paystack.
async function markAsPaid(req, res) {
  const { shipmentId } = req.params;
  const { method = "MANUAL", reference, notes } = req.body;
  const adminId = req.user.id;

  const shipment = await prisma.shipment.findFirst({
    where: { id: shipmentId },
    include: {
      customer: {
        select: { id: true, email: true, firstName: true, lastName: true },
      },
    },
  });
  if (!shipment) throw new ApiError(404, "Shipment not found");
  if (shipment.paymentStatus === "PAID") {
    throw new ApiError(400, "This shipment is already marked as paid");
  }

  const manualRef =
    reference || `MANUAL-${Date.now().toString(36).toUpperCase()}`;

  // Create or update the payment record
  const existing = await prisma.payment.findFirst({
    where: { shipmentId, userId: shipment.customerId },
    orderBy: { createdAt: "desc" },
  });

  let payment;
  if (existing) {
    payment = await prisma.payment.update({
      where: { id: existing.id },
      data: {
        status: "PAID",
        channel: "manual",
        paidAt: new Date(),
        gatewayResponse: `Manually marked paid by admin. Method: ${method}. Notes: ${notes || "N/A"}`,
        ...(reference ? { reference: manualRef } : {}),
      },
    });
  } else {
    payment = await prisma.payment.create({
      data: {
        reference: manualRef,
        userId: shipment.customerId,
        shipmentId,
        amountKobo: Math.round((shipment.quotedPrice || 0) * 100),
        currency: "NGN",
        status: "PAID",
        channel: "manual",
        paidAt: new Date(),
        gatewayResponse: `Manually marked paid by admin. Method: ${method}. Notes: ${notes || "N/A"}`,
      },
    });
  }

  // Update shipment payment status — PRD: Paid → AWAITING_PICKUP
  await prisma.shipment.update({
    where: { id: shipmentId },
    data: { paymentStatus: "PAID", status: "AWAITING_PICKUP" },
  });

  return success(res, { payment }, "Shipment marked as paid successfully");
}

// ─── WAIVE PAYMENT (Super Admin only) ─────────────────────────────────────────
// Comps a shipment — marks it paid at ₦0 with reason noted.
async function waivePayment(req, res) {
  const { shipmentId } = req.params;
  const { reason = "Waived by admin" } = req.body;

  const shipment = await prisma.shipment.findFirst({
    where: { id: shipmentId },
  });
  if (!shipment) throw new ApiError(404, "Shipment not found");
  if (shipment.paymentStatus === "PAID") {
    throw new ApiError(400, "Shipment is already paid");
  }

  const payment = await prisma.payment.create({
    data: {
      reference: `WAIVED-${Date.now().toString(36).toUpperCase()}`,
      userId: shipment.customerId,
      shipmentId,
      amountKobo: 0,
      currency: "NGN",
      status: "PAID",
      channel: "waived",
      paidAt: new Date(),
      gatewayResponse: `Payment waived. Reason: ${reason}`,
    },
  });

  await prisma.shipment.update({
    where: { id: shipmentId },
    data: { paymentStatus: "PAID", finalPrice: 0 },
  });

  return success(res, { payment }, "Payment waived successfully");
}

module.exports = {
  initPayment,
  markAsPaid,
  waivePayment,
  initPendingPayment,
  verifyPaymentHandler,
  webhook,
  paystackCallback,
  refundHandler,
  myPayments,
  adminListPayments,
  paymentStats,
  listFailedWebhooks,
  retryFailedWebhook,
  dismissFailedWebhook,
};
