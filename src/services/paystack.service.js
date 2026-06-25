const https = require("https");
const { prisma } = require("../config/db");
const { ApiError } = require("../utils/ApiError");
const { randomUUID } = require("crypto");
const {
  generateInvoicePDF,
  generateShippingLabelPDF,
  generateBookingConfirmationPDF,
} = require("./pdf.service");
const {
  sendBookingConfirmationEmail,
  sendPaymentSuccessEmail,
} = require("./invoiceEmail.service");

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE = "api.paystack.co";

function paystackRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: PAYSTACK_BASE,
      port: 443,
      path,
      method,
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        "Content-Type": "application/json",
        ...(data && { "Content-Length": Buffer.byteLength(data) }),
      },
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error("Invalid JSON from Paystack"));
        }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function initializePayment({
  userId,
  shipmentId,
  amountNaira,
  email,
  idempotencyKey = null,
  metadata = {},
}) {
  if (!PAYSTACK_SECRET)
    throw new ApiError(500, "Paystack secret key not configured");

  const amountKobo = Math.round(amountNaira * 100);
  const reference = `BWG-${randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase()}`;

  const response = await paystackRequest("POST", "/transaction/initialize", {
    email,
    amount: amountKobo,
    reference,
    currency: "NGN",
    metadata: {
      userId,
      shipmentId,
      ...metadata,
      cancel_action: `${process.env.CLIENT_URL || ""}/payment/cancelled`,
    },
    callback_url: `${process.env.API_URL || ""}/api/v1/payments/callback`,
  });

  if (!response.status)
    throw new ApiError(502, response.message || "Failed to initialize payment");

  // Gap 1: store authorizationUrl + accessCode so we can reuse them on duplicate requests
  await prisma.payment.create({
    data: {
      reference,
      userId,
      shipmentId,
      amountKobo,
      currency: "NGN",
      status: "PENDING",
      metadata,
      authorizationUrl: response.data.authorization_url,
      accessCode: response.data.access_code,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  });

  return {
    reference,
    authorizationUrl: response.data.authorization_url,
    accessCode: response.data.access_code,
  };
}

async function verifyPayment(reference) {
  const response = await paystackRequest(
    "GET",
    `/transaction/verify/${encodeURIComponent(reference)}`,
  );
  if (!response.status)
    throw new ApiError(502, response.message || "Failed to verify payment");

  const tx = response.data;
  const payment = await prisma.payment.findUnique({ where: { reference } });
  if (!payment) throw new ApiError(404, "Payment record not found");

  if (payment.status === "PAID") return { payment, alreadyProcessed: true };

  const isPaid = tx.status === "success";

  const updated = await prisma.payment.update({
    where: { reference },
    data: {
      status: isPaid ? "PAID" : "FAILED",
      paystackId: tx.id ? String(tx.id) : null,
      gatewayResponse: tx.gateway_response,
      paidAt: isPaid ? new Date(tx.paid_at) : null,
      channel: mapChannel(tx.channel),
      authorizationCode: tx.authorization?.authorization_code,
      cardLast4: tx.authorization?.last4,
      cardBank: tx.authorization?.bank,
    },
  });

  // Save the card for future use if Paystack marked the authorization
  // reusable — this powers the Payment Method tab in Settings.
  const auth = tx.authorization;
  if (isPaid && auth?.reusable && auth?.authorization_code) {
    const existingCount = await prisma.savedCard.count({
      where: { userId: payment.userId },
    });
    await prisma.savedCard.upsert({
      where: { authorizationCode: auth.authorization_code },
      update: {
        last4: auth.last4,
        cardType: auth.card_type,
        bank: auth.bank,
        expMonth: auth.exp_month,
        expYear: auth.exp_year,
      },
      create: {
        userId: payment.userId,
        authorizationCode: auth.authorization_code,
        last4: auth.last4,
        cardType: auth.card_type,
        bank: auth.bank,
        expMonth: auth.exp_month,
        expYear: auth.exp_year,
        isDefault: existingCount === 0, // first saved card becomes default
      },
    });
  }

  if (isPaid && payment.shipmentId) {
    // PRD Sprint 3 state machine: Quoted → Booked → Paid → AWAITING_PICKUP
    await prisma.shipment.update({
      where: { id: payment.shipmentId },
      data: {
        paymentStatus: "PAID",
        status: "AWAITING_PICKUP",
        finalPrice: tx.amount / 100,
      },
    });

    // Add tracking event
    await prisma.trackingEvent.create({
      data: {
        shipmentId: payment.shipmentId,
        status: "AWAITING_PICKUP",
        description: `Payment confirmed via ${tx.channel || "card"}. Shipment is awaiting pickup.`,
      },
    });

    // In-app notification
    await prisma.notification.create({
      data: {
        userId: payment.userId,
        type: "PAYMENT",
        title: "Payment Successful",
        body: `Your payment of ₦${(tx.amount / 100).toLocaleString()} has been received. Shipment confirmed.`,
        data: { reference, shipmentId: payment.shipmentId },
      },
    });

    // ── Sprint 3: Auto-send booking confirmation email with PDFs ─────────────
    try {
      const [shipment, user] = await Promise.all([
        prisma.shipment.findUnique({ where: { id: payment.shipmentId } }),
        prisma.user.findUnique({
          where: { id: payment.userId },
          select: { firstName: true, lastName: true, email: true },
        }),
      ]);

      const surchargeBreakdown = shipment.surchargeBreakdown
        ? typeof shipment.surchargeBreakdown === "string"
          ? JSON.parse(shipment.surchargeBreakdown)
          : shipment.surchargeBreakdown
        : [];

      // Generate both PDFs in parallel
      const [confirmationPdf, labelPdf] = await Promise.all([
        generateBookingConfirmationPDF({
          shipment,
          customer: user,
          quote: { surchargeBreakdown },
        }),
        generateShippingLabelPDF(shipment),
      ]);

      // Send email with both attachments
      await sendBookingConfirmationEmail({
        to: user.email,
        firstName: user.firstName,
        trackingNumber: shipment.trackingNumber,
        senderCity: shipment.senderCity,
        recipientCity: shipment.recipientCity,
        amount: tx.amount / 100,
        confirmationPdfBuffer: confirmationPdf,
        labelPdfBuffer: labelPdf,
        cutoffWarning: shipment.cutoffWarning,
      });

      console.log(`📧 Booking confirmation + label sent to ${user.email}`);

      // Payment receipt email (separate from booking confirmation)
      try {
        await sendPaymentSuccessEmail({
          to: user.email,
          firstName: user.firstName,
          amount: tx.amount / 100,
          trackingNumber: shipment.trackingNumber,
          reference,
        });
        console.log(`📧 Payment receipt sent to ${user.email}`);
      } catch (receiptErr) {
        console.error("Payment receipt email error:", receiptErr.message);
      }
    } catch (emailErr) {
      // Non-blocking — payment already verified, don't fail because of email
      console.error("Post-payment email error:", emailErr.message);
    }
  }

  return { payment: updated, alreadyProcessed: false, paystackData: tx };
}

async function refundPayment(reference, amountNaira = null) {
  const payment = await prisma.payment.findUnique({ where: { reference } });
  if (!payment) throw new ApiError(404, "Payment not found");
  if (payment.status !== "PAID")
    throw new ApiError(400, "Only paid transactions can be refunded");

  const refundKobo = amountNaira
    ? Math.round(amountNaira * 100)
    : payment.amountKobo;

  const response = await paystackRequest("POST", "/refund", {
    transaction: reference,
    amount: refundKobo,
  });

  if (!response.status)
    throw new ApiError(502, response.message || "Refund request failed");

  const refundRef = response.data?.id
    ? `REFUND-${response.data.id}`
    : `REFUND-${randomUUID().slice(0, 8)}`;

  const updated = await prisma.payment.update({
    where: { reference },
    data: {
      status: "REFUNDED",
      refundedAt: new Date(),
      refundReference: refundRef,
      refundAmountKobo: refundKobo,
    },
  });

  // Cancel the shipment so it doesn't show as active after refund
  if (payment.shipmentId) {
    await prisma.shipment.update({
      where: { id: payment.shipmentId },
      data: {
        paymentStatus: "REFUNDED",
        status: "CANCELLED",
      },
    });

    await prisma.trackingEvent.create({
      data: {
        shipmentId: payment.shipmentId,
        status: "CANCELLED",
        description: `Shipment cancelled following refund of ₦${(refundKobo / 100).toLocaleString()}.`,
      },
    });
  }

  if (payment.userId) {
    await prisma.notification.create({
      data: {
        userId: payment.userId,
        type: "PAYMENT",
        title: "Refund Initiated",
        body: `A refund of ₦${(refundKobo / 100).toLocaleString()} has been initiated. It will reflect in 3-5 business days.`,
        data: { reference, refundReference: refundRef },
      },
    });
  }

  return updated;
}

function verifyWebhookSignature(body, signature) {
  const crypto = require("crypto");
  const hash = crypto
    .createHmac("sha512", PAYSTACK_SECRET)
    .update(JSON.stringify(body))
    .digest("hex");
  return hash === signature;
}

function mapChannel(channel) {
  const map = {
    card: "CARD",
    bank: "BANK_TRANSFER",
    ussd: "USSD",
    mobile_money: "MOBILE_MONEY",
    qr: "QR",
  };
  return map[channel] || null;
}

module.exports = {
  initializePayment,
  verifyPayment,
  refundPayment,
  verifyWebhookSignature,
};
