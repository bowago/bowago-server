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
const { cloudinary } = require("../config/cloudinary");

async function uploadPDFAndGetSignedUrl(pdfBuffer, folder, filename) {
  // Upload to Cloudinary private folder
  const uploadResult = await new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: `bowago/pdfs/${folder}`,
        public_id: filename,
        resource_type: "raw",
        type: "private", // not publicly accessible
        overwrite: true,
      },
      (err, result) => {
        if (err) reject(err);
        else resolve(result);
      },
    );
    uploadStream.end(pdfBuffer);
  });

  // Generate signed URL with 24-hour expiry
  const EXPIRY_SECONDS = 24 * 60 * 60; // 24 hours
  const signedUrl = cloudinary.utils.private_download_url(
    uploadResult.public_id,
    "pdf",
    {
      resource_type: "raw",
      expires_at: Math.floor(Date.now() / 1000) + EXPIRY_SECONDS,
    },
  );

  return {
    signedUrl,
    publicId: uploadResult.public_id,
    expiresInSeconds: EXPIRY_SECONDS,
  };
}

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

// ─── GET /invoices/:paymentId/download — Generate PDF, store on Cloudinary, return signed URL ─
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

  await prisma.activityLog
    .create({
      data: {
        userId: req.user.id,
        action: "DOWNLOAD_INVOICE_PDF",
        resource: "Invoice",
        metadata: { paymentId, invoiceNumber },
      },
    })
    .catch(() => {}); // non-blocking

  try {
    const { signedUrl, expiresInSeconds } = await uploadPDFAndGetSignedUrl(
      pdfBuffer,
      `invoices/${payment.userId}`,
      `invoice-${invoiceNumber}-${Date.now()}`,
    );
    return success(
      res,
      {
        signedUrl,
        filename: `BowaGO-Invoice-${invoiceNumber}.pdf`,
        expiresInSeconds,
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      },
      "Invoice download link generated (valid 24 hours)",
    );
  } catch (cloudinaryErr) {
    // Fallback: stream directly if Cloudinary upload fails
    console.error(
      "[invoice] Cloudinary upload failed, streaming directly:",
      cloudinaryErr.message,
    );
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="BowaGO-Invoice-${invoiceNumber}.pdf"`,
      "Content-Length": pdfBuffer.length,
    });
    return res.send(pdfBuffer);
  }
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

  await prisma.activityLog
    .create({
      data: {
        userId: req.user.id,
        action: "DOWNLOAD_SHIPPING_LABEL",
        resource: "Shipment",
        metadata: { shipmentId: id },
      },
    })
    .catch(() => {});

  try {
    const { signedUrl, expiresInSeconds } = await uploadPDFAndGetSignedUrl(
      pdfBuffer,
      `labels/${shipment.customerId}`,
      `label-${shipment.trackingNumber}-${Date.now()}`,
    );
    return success(
      res,
      {
        signedUrl,
        filename: `BowaGO-Label-${shipment.trackingNumber}.pdf`,
        expiresInSeconds,
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      },
      "Shipping label download link generated (valid 24 hours)",
    );
  } catch (cloudinaryErr) {
    console.error(
      "[invoice] Cloudinary label upload failed, streaming directly:",
      cloudinaryErr.message,
    );
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="BowaGO-Label-${shipment.trackingNumber}.pdf"`,
      "Content-Length": pdfBuffer.length,
    });
    return res.send(pdfBuffer);
  }
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

  await prisma.activityLog
    .create({
      data: {
        userId: req.user.id,
        action: "DOWNLOAD_BOOKING_CONFIRMATION",
        resource: "Shipment",
        metadata: { shipmentId: id },
      },
    })
    .catch(() => {});

  try {
    const { signedUrl, expiresInSeconds } = await uploadPDFAndGetSignedUrl(
      pdfBuffer,
      `confirmations/${shipment.customerId}`,
      `confirmation-${shipment.trackingNumber}-${Date.now()}`,
    );
    return success(
      res,
      {
        signedUrl,
        filename: `BowaGO-Confirmation-${shipment.trackingNumber}.pdf`,
        expiresInSeconds,
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      },
      "Booking confirmation download link generated (valid 24 hours)",
    );
  } catch (cloudinaryErr) {
    console.error(
      "[invoice] Cloudinary confirmation upload failed, streaming directly:",
      cloudinaryErr.message,
    );
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="BowaGO-Confirmation-${shipment.trackingNumber}.pdf"`,
      "Content-Length": pdfBuffer.length,
    });
    return res.send(pdfBuffer);
  }
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

// ─── Customer Invoice Summary ────────────────────────────────────────────────
// Returns payment stats scoped to the authenticated customer only.
async function myInvoiceSummary(req, res) {
  const userId = req.user.id;

  const [paid, pending, refunded, totalSpent] = await Promise.all([
    prisma.payment.count({ where: { userId, status: "PAID" } }),
    prisma.payment.count({ where: { userId, status: "PENDING" } }),
    prisma.payment.count({ where: { userId, status: "REFUNDED" } }),
    prisma.payment.aggregate({
      where: { userId, status: "PAID" },
      _sum: { amountKobo: true },
    }),
  ]);

  return success(res, {
    summary: {
      totalSpentNaira: (totalSpent._sum.amountKobo || 0) / 100,
      paidInvoices: paid,
      pendingInvoices: pending,
      refundedCount: refunded,
      currency: "NGN",
    },
  });
}

module.exports = {
  myInvoices,
  adminListInvoices,
  getInvoice,
  downloadInvoicePDF,
  emailInvoice,
  downloadShippingLabel,
  downloadBookingConfirmation,
  financialOverview,
  myInvoiceSummary,
  autoGenerateInvoice,
};

// ─── GET /invoices/admin — Admin list of all invoices ─────────────────────────
async function adminListInvoices(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { status, userId, fromDate, toDate } = req.query;

  const where = {
    ...(status && { status }),
    ...(userId && { userId }),
    ...((fromDate || toDate) && {
      createdAt: {
        ...(fromDate && { gte: new Date(fromDate) }),
        ...(toDate && { lte: new Date(toDate) }),
      },
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
        shipment: {
          select: {
            id: true,
            trackingNumber: true,
            senderCity: true,
            recipientCity: true,
            status: true,
            quotedPrice: true,
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
    user: p.user,
    shipment: p.shipment,
  }));

  return res.json({
    success: true,
    message: "Invoices retrieved",
    data: { invoices },
    meta: buildMeta(total, page, limit),
  });
}

// ─── Auto-generate invoice on DELIVERED (called from shipment.controller) ─────
// Creates a PDF, stores on Cloudinary, and emails it to the customer.
// This is non-blocking — the caller wraps it in .catch() so a failure here
// never affects the status-update API response.
async function autoGenerateInvoice(shipment) {
  // Only run for paid shipments that have a linked payment
  const payment = await prisma.payment.findFirst({
    where:   { shipmentId: shipment.id, status: 'PAID' },
    orderBy: { createdAt: 'desc' },
    include: {
      user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
    },
  });
  if (!payment) return; // unpaid or COD — skip

  const invoiceNumber = buildInvoiceNumber(payment);

  const pdfBuffer = await generateInvoicePDF({
    invoice:  { number: invoiceNumber, date: payment.createdAt },
    customer: payment.user,
    shipment,
    payment,
  });

  // Upload to Cloudinary (non-critical — if upload fails, still email)
  try {
    await uploadPDFAndGetSignedUrl(
      pdfBuffer,
      `invoices/${payment.userId}`,
      `invoice-${invoiceNumber}-delivered`,
    );
  } catch (e) {
    console.error('[AutoInvoice] Cloudinary upload failed:', e.message);
  }

  // Email invoice to customer
  await sendInvoiceEmail({
    to:            payment.user.email,
    firstName:     payment.user.firstName,
    invoiceNumber: `INV-${invoiceNumber}`,
    amount:        payment.amountKobo / 100,
    trackingNumber: shipment.trackingNumber,
    pdfBuffer,
  });

  // In-app notification
  await prisma.notification.create({
    data: {
      userId: payment.userId,
      type:   'PAYMENT',
      title:  `Invoice Ready — ${shipment.trackingNumber}`,
      body:   `Your invoice INV-${invoiceNumber} for ₦${(payment.amountKobo / 100).toLocaleString()} has been sent to your email.`,
      data:   { shipmentId: shipment.id, invoiceNumber },
    },
  }).catch(() => {});
}
