const { prisma } = require("../config/db");
const {
  initializePayment,
  verifyPayment,
  refundPayment,
  verifyWebhookSignature,
} = require("../services/paystack.service");
const { ApiError } = require("../utils/ApiError");
const { success, getPagination, buildMeta } = require("../utils/helpers");

// ─── Initialize Payment ───────────────────────────────────────────────────────
async function initPayment(req, res) {
  const { shipmentId } = req.body;
  const userId = req.user.id;
  const email = req.user.email;

  const shipment = await prisma.shipment.findFirst({
    where: { id: shipmentId, customerId: userId },
  });
  if (!shipment) throw new ApiError(404, "Shipment not found");
  if (shipment.paymentStatus === "PAID")
    throw new ApiError(400, "Shipment is already paid");

  // Check for existing pending payment (idempotency)
  const existingPending = await prisma.payment.findFirst({
    where: { shipmentId, userId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });

  // Reuse unexpired pending payment if it exists
  if (existingPending) {
    // Re-initialize to get a fresh authorization URL
  }

  const result = await initializePayment({
    userId,
    shipmentId,
    amountNaira: shipment.quotedPrice,
    email,
    metadata: {
      trackingNumber: shipment.trackingNumber,
      recipientCity: shipment.recipientCity,
    },
  });

  return success(res, result, "Payment initialized");
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

  // Always respond 200 first so Paystack doesn't retry
  res.status(200).json({ received: true });

  if (!verifyWebhookSignature(req.body, signature)) {
    console.error("Invalid Paystack webhook signature");
    return;
  }

  const { event, data } = req.body;

  try {
    if (event === "charge.success") {
      await verifyPayment(data.reference);
      console.log(`✅ Webhook: Payment ${data.reference} confirmed`);
    }

    if (event === "refund.processed") {
      console.log(
        `✅ Webhook: Refund processed for ${data.transaction_reference}`,
      );
      // Refund already handled in refundPayment(), just log here
    }
  } catch (err) {
    console.error("Webhook processing error:", err.message);
  }
}

// ─── Paystack callback (browser redirect after payment) ───────────────────────
async function paystackCallback(req, res) {
  const { reference } = req.query;
  if (!reference) {
    return res.redirect(`${process.env.CLIENT_URL}/payment/failed`);
  }

  try {
    const result = await verifyPayment(reference);
    if (result.payment.status === "PAID") {
      return res.redirect(
        `${process.env.CLIENT_URL}/payment/success?ref=${reference}`,
      );
    }
    return res.redirect(
      `${process.env.CLIENT_URL}/payment/failed?ref=${reference}`,
    );
  } catch (err) {
    return res.redirect(`${process.env.CLIENT_URL}/payment/failed`);
  }
}

// ─── Refund ───────────────────────────────────────────────────────────────────
async function refundHandler(req, res) {
  const { reference } = req.params;
  const { amountNaira } = req.body;

  // Only admin or the payment owner can refund
  const payment = await prisma.payment.findUnique({ where: { reference } });
  if (!payment) throw new ApiError(404, "Payment not found");

  if (req.user.role !== "ADMIN" && payment.userId !== req.user.id) {
    throw new ApiError(403, "Not authorized to refund this payment");
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

module.exports = {
  initPayment,
  verifyPaymentHandler,
  webhook,
  paystackCallback,
  refundHandler,
  myPayments,
  adminListPayments,
  paymentStats,
};
