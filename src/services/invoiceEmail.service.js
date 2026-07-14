const { emailShell, FRONTEND, sendEmail } = require("../config/email");

function formatNaira(koboOrNaira) {
  const naira = Number(koboOrNaira || 0);
  // If value > 100,000 it's probably already in naira (legacy), else treat as kobo
  const amount = naira > 100000 ? naira / 100 : naira;
  return `₦${amount.toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
}

// ─── Invoice Email ────────────────────────────────────────────────────────────

async function sendInvoiceEmail({
  to,
  firstName,
  invoiceNumber,
  amount,
  trackingNumber,
  appliedDiscount, // { label, discountAmount } | null
  pdfBuffer,
}) {
  const trackUrl = trackingNumber
    ? `${FRONTEND}/track?q=${trackingNumber}`
    : null;

  const html = emailShell(
    `
    <h2>Your Invoice is Ready, ${firstName}!</h2>
    <p>Thank you for using BowaGO. Your invoice is attached to this email.</p>

    <div class="info-box">
      <p class="lbl">Invoice Number</p>
      <p class="val">INV-${invoiceNumber}</p>
    </div>

    <div class="amount-box">
      <p class="lbl">Amount Paid</p>
      <p class="val">${formatNaira(amount)}</p>
    </div>

    ${
      appliedDiscount
        ? `
    <div class="info-box" style="background:#E8F8F5;">
      <p class="lbl">✓ ${appliedDiscount.label}</p>
      <p class="val" style="font-size:14px;">You saved ${formatNaira(appliedDiscount.discountAmount || 0)} — already reflected in the amount above</p>
    </div>
    `
        : ""
    }

    ${
      trackingNumber
        ? `
    <div class="info-box">
      <p class="lbl">Tracking Number</p>
      <p class="val" style="font-size:16px;">${trackingNumber}</p>
    </div>
    <p><a href="${trackUrl}" class="btn">Track Your Shipment →</a></p>
    `
        : ""
    }

    <p style="color:#AAAAAA;font-size:13px;">
      The attached PDF is your official invoice. Please keep it for your records.
    </p>
  `,
    {
      preheader: `BowaGO Invoice INV-${invoiceNumber} — ${formatNaira(amount)}`,
    },
  );

  await sendEmail({
    to,
    subject: `BowaGO Invoice INV-${invoiceNumber}`,
    html,
    attachments: [
      {
        filename: `BowaGO-Invoice-${invoiceNumber}.pdf`,
        content: pdfBuffer,
      },
    ],
  });
}

// ─── Booking Confirmation Email ───────────────────────────────────────────────

async function sendBookingConfirmationEmail({
  to,
  firstName,
  trackingNumber,
  senderCity,
  recipientCity,
  amount,
  confirmationPdfBuffer,
  labelPdfBuffer,
  cutoffWarning,
}) {
  const trackUrl = `${FRONTEND}/track?q=${trackingNumber}`;
  const guideUrl = `${FRONTEND}/packaging-guide`;

  const html = emailShell(
    `
    <h2>Booking Confirmed</h2>
    <p>Hi ${firstName}, your shipment has been booked successfully.</p>

    <div class="info-box">
      <p class="lbl">Tracking Number</p>
      <p class="val" style="color:#CC0000;">${trackingNumber}</p>
    </div>

    <table class="details-table">
      <tr><td>Route</td><td>${senderCity} → ${recipientCity}</td></tr>
      <tr><td>Quoted Price</td><td>${formatNaira(amount)}</td></tr>
    </table>

    ${
      cutoffWarning
        ? `
    <div class="notice-box">
      <strong>Pickup Notice:</strong> Your booking was placed after 2:00 PM. The earliest available pickup is the next business day.
    </div>
    `
        : ""
    }

    <p><a href="${trackUrl}" class="btn">Track Shipment →</a></p>

    <p style="color:#AAAAAA;font-size:13px;">
      Your <strong>booking confirmation</strong> and <strong>shipping label</strong> are attached.
      Please print the shipping label and attach it to your package before pickup.
    </p>
    <p style="color:#AAAAAA;font-size:12px;">
      Need packaging tips? <a href="${guideUrl}" style="color:#CC0000;">View our packaging guide →</a>
    </p>
  `,
    {
      preheader: `Booking confirmed — ${trackingNumber} | ${senderCity} → ${recipientCity}`,
    },
  );

  const attachments = [
    {
      filename: `BowaGO-Confirmation-${trackingNumber}.pdf`,
      content: confirmationPdfBuffer,
      contentType: "application/pdf",
    },
  ];

  if (labelPdfBuffer) {
    attachments.push({
      filename: `BowaGO-ShippingLabel-${trackingNumber}.pdf`,
      content: labelPdfBuffer,
      contentType: "application/pdf",
    });
  }

  await sendEmail({
    to,
    subject: `BowaGO Booking Confirmed — ${trackingNumber}`,
    html,
    attachments,
  });
}

// ─── Payment Success Email ────────────────────────────────────────────────────

async function sendPaymentSuccessEmail({
  to,
  firstName,
  amount,
  trackingNumber,
  reference,
}) {
  const trackUrl = `${FRONTEND}/track?q=${trackingNumber}`;

  const html = emailShell(
    `
    <h2>Payment Received</h2>
    <p>Hi ${firstName}, we've received your payment. Your shipment is now confirmed.</p>

    <div class="amount-box">
      <p class="lbl">Amount Paid</p>
      <p class="val">${formatNaira(amount)}</p>
    </div>

    <table class="details-table">
      <tr><td>Tracking Number</td><td>${trackingNumber}</td></tr>
      <tr><td>Payment Reference</td><td><span style="font-family:monospace;">${reference}</span></td></tr>
      <tr><td>Status</td><td><span class="status-badge status-ok">PAID</span></td></tr>
    </table>

    <p><a href="${trackUrl}" class="btn">Track Your Shipment →</a></p>
    <p style="color:#AAAAAA;font-size:13px;">A full invoice has been sent separately and is also available in your dashboard.</p>
  `,
    {
      preheader: `Payment received — ${formatNaira(amount)} for ${trackingNumber}`,
    },
  );

  await sendEmail({
    to,
    subject: `Payment Confirmed — ${formatNaira(amount)} received`,
    html,
  });
}

module.exports = {
  sendInvoiceEmail,
  sendBookingConfirmationEmail,
  sendPaymentSuccessEmail,
};
