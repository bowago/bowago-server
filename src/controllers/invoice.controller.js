const { prisma } = require("../config/db");
const { ApiError } = require("../utils/ApiError");
const { success, getPagination, buildMeta } = require("../utils/helpers");
const {
  generateInvoicePDF,
  generateShippingLabelPDF,
  generateBookingConfirmationPDF,
} = require("../services/pdf.service");
const {
  sendInvoiceEmail,
  sendBookingConfirmationEmail,
} = require("../services/invoiceEmail.service");

// ─── Helper: build invoice number ─────────────────────────────────────────────
function buildInvoiceNumber(payment) {
  const date = new Date(payment.createdAt);
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const seq = payment.paystackId
    ? String(payment.paystackId).slice(-5).padStart(5, "0")
    : payment.id.slice(-5).toUpperCase();
  return `${yy}${mm}-${seq}`;
}

// ─── Helper: get surcharge breakdown from shipment ───────────────────────────
function getSurchargeBreakdown(shipment) {
  if (!shipment.surchargeBreakdown) return [];
  if (typeof shipment.surchargeBreakdown === "string") {
    try {
      return JSON.parse(shipment.surchargeBreakdown);
    } catch {
      return [];
    }
  }
  return Array.isArray(shipment.surchargeBreakdown)
    ? shipment.surchargeBreakdown
    : [];
}

// ─── GET /invoices/my — Customer invoice list ─────────────────────────────────
async function myInvoices(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { status } = req.query;

  const where = {
    userId: req.user.id,
    ...(status && { status }),
  };

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        shipment: {
          select: {
            id: true,
            trackingNumber: true,
            senderCity: true,
            recipientCity: true,
            recipientState: true,
            status: true,
            quotedPrice: true,
            weight: true,
          },
        },
      },
    }),
    prisma.payment.count({ where }),
  ]);

  const invoices = payments.map((p) => ({
    invoiceNumber: `INV-${buildInvoiceNumber(p)}`,
    paymentId: p.id,
    reference: p.reference,
    amount: p.amountKobo / 100,
    currency: p.currency,
    status: p.status,
    channel: p.channel,
    paidAt: p.paidAt,
    createdAt: p.createdAt,
    shipment: p.shipment,
  }));

  return res.json({
    success: true,
    message: "Invoices retrieved",
    data: { invoices },
    meta: buildMeta(total, page, limit),
  });
}

// ─── GET /invoices/:paymentId — Single invoice detail ────────────────────────
async function getInvoice(req, res) {
  const { paymentId } = req.params;

  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
        },
      },
      shipment: true,
    },
  });

  if (!payment) throw new ApiError(404, "Invoice not found");

  // Customers can only see their own
  if (req.user.role === "CUSTOMER" && payment.userId !== req.user.id) {
    throw new ApiError(403, "Access denied");
  }

  return success(res, {
    invoice: {
      invoiceNumber: `INV-${buildInvoiceNumber(payment)}`,
      ...payment,
      amountNaira: payment.amountKobo / 100,
      surchargeBreakdown: getSurchargeBreakdown(payment.shipment),
    },
  });
}

// ─── GET /invoices/:paymentId/download — Stream PDF to browser ───────────────
async function downloadInvoicePDF(req, res) {
  const { paymentId } = req.params;

  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
        },
      },
      shipment: true,
    },
  });

  if (!payment) throw new ApiError(404, "Invoice not found");
  if (req.user.role === "CUSTOMER" && payment.userId !== req.user.id) {
    throw new ApiError(403, "Access denied");
  }

  const invoiceNumber = buildInvoiceNumber(payment);

  const pdfBuffer = await generateInvoicePDF({
    invoice: { number: invoiceNumber, date: payment.createdAt },
    customer: payment.user,
    shipment: payment.shipment,
    payment,
    surchargeBreakdown: getSurchargeBreakdown(payment.shipment),
  });

  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="BowaGO-Invoice-${invoiceNumber}.pdf"`,
    "Content-Length": pdfBuffer.length,
  });
  res.send(pdfBuffer);
}

// ─── GET /invoices/:paymentId/email — Send invoice to customer's email ────────
async function emailInvoice(req, res) {
  const { paymentId } = req.params;

  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
        },
      },
      shipment: true,
    },
  });

  if (!payment) throw new ApiError(404, "Invoice not found");
  if (req.user.role === "CUSTOMER" && payment.userId !== req.user.id) {
    throw new ApiError(403, "Access denied");
  }

  const invoiceNumber = buildInvoiceNumber(payment);

  const pdfBuffer = await generateInvoicePDF({
    invoice: { number: invoiceNumber, date: payment.createdAt },
    customer: payment.user,
    shipment: payment.shipment,
    payment,
    surchargeBreakdown: getSurchargeBreakdown(payment.shipment),
  });

  await sendInvoiceEmail({
    to: payment.user.email,
    firstName: payment.user.firstName,
    invoiceNumber,
    amount: payment.amountKobo / 100,
    trackingNumber: payment.shipment?.trackingNumber,
    pdfBuffer,
  });

  return success(res, {}, `Invoice sent to ${payment.user.email}`);
}

// ─── GET /shipments/:id/label — Download shipping label ──────────────────────
async function downloadShippingLabel(req, res) {
  const { id } = req.params;

  const shipment = await prisma.shipment.findUnique({ where: { id } });
  if (!shipment) throw new ApiError(404, "Shipment not found");

  if (req.user.role === "CUSTOMER" && shipment.customerId !== req.user.id) {
    throw new ApiError(403, "Access denied");
  }

  const pdfBuffer = await generateShippingLabelPDF(shipment);

  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="BowaGO-Label-${shipment.trackingNumber}.pdf"`,
    "Content-Length": pdfBuffer.length,
  });
  res.send(pdfBuffer);
}

// ─── GET /shipments/:id/confirmation — Booking confirmation PDF ───────────────
async function downloadBookingConfirmation(req, res) {
  const { id } = req.params;

  const shipment = await prisma.shipment.findUnique({
    where: { id },
    include: {
      customer: { select: { firstName: true, lastName: true, email: true } },
    },
  });
  if (!shipment) throw new ApiError(404, "Shipment not found");

  if (req.user.role === "CUSTOMER" && shipment.customerId !== req.user.id) {
    throw new ApiError(403, "Access denied");
  }

  const surchargeBreakdown = getSurchargeBreakdown(shipment);

  const pdfBuffer = await generateBookingConfirmationPDF({
    shipment,
    customer: shipment.customer,
    quote: { surchargeBreakdown },
  });

  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="BowaGO-Confirmation-${shipment.trackingNumber}.pdf"`,
    "Content-Length": pdfBuffer.length,
  });
  res.send(pdfBuffer);
}

// ─── Admin: Financial overview ────────────────────────────────────────────────
async function financialOverview(req, res) {
  const { fromDate, toDate } = req.query;

  const dateFilter =
    fromDate || toDate
      ? {
          createdAt: {
            ...(fromDate && { gte: new Date(fromDate) }),
            ...(toDate && { lte: new Date(toDate) }),
          },
        }
      : {};

  const [
    totalRevenue,
    paidCount,
    pendingRevenue,
    pendingCount,
    refundedAmount,
    refundedCount,
    recentPayments,
  ] = await Promise.all([
    prisma.payment.aggregate({
      where: { status: "PAID", ...dateFilter },
      _sum: { amountKobo: true },
    }),
    prisma.payment.count({ where: { status: "PAID", ...dateFilter } }),
    prisma.payment.aggregate({
      where: { status: "PENDING", ...dateFilter },
      _sum: { amountKobo: true },
    }),
    prisma.payment.count({ where: { status: "PENDING", ...dateFilter } }),
    prisma.payment.aggregate({
      where: { status: "REFUNDED", ...dateFilter },
      _sum: { refundAmountKobo: true },
    }),
    prisma.payment.count({ where: { status: "REFUNDED", ...dateFilter } }),
    prisma.payment.findMany({
      where: { status: "PAID", ...dateFilter },
      orderBy: { paidAt: "desc" },
      take: 10,
      include: {
        user: { select: { firstName: true, lastName: true, email: true } },
        shipment: { select: { trackingNumber: true, recipientCity: true } },
      },
    }),
  ]);

  return success(res, {
    summary: {
      totalRevenueNaira: (totalRevenue._sum.amountKobo || 0) / 100,
      paidInvoices: paidCount,
      pendingRevenueNaira: (pendingRevenue._sum.amountKobo || 0) / 100,
      pendingInvoices: pendingCount,
      refundedNaira: (refundedAmount._sum.refundAmountKobo || 0) / 100,
      refundedCount,
      currency: "NGN",
    },
    recentPayments: recentPayments.map((p) => ({
      ...p,
      amountNaira: p.amountKobo / 100,
    })),
  });
}

module.exports = {
  myInvoices,
  getInvoice,
  downloadInvoicePDF,
  emailInvoice,
  downloadShippingLabel,
  downloadBookingConfirmation,
  financialOverview,
};
