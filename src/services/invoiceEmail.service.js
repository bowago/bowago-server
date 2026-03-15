const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_PORT === '465',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

const FROM = process.env.EMAIL_FROM || 'BowaGO <noreply@bowago.com>';

function formatNaira(amount) {
  return `₦${Number(amount || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
}

// ─── Branded email wrapper ────────────────────────────────────────────────────
function emailShell(content) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; background: #F4F4F4; font-family: Arial, sans-serif; }
    .wrapper { max-width: 600px; margin: 30px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .header { background: #E85D04; padding: 24px 32px; }
    .header h1 { margin: 0; color: #fff; font-size: 26px; letter-spacing: 1px; }
    .header p { margin: 4px 0 0; color: rgba(255,255,255,0.8); font-size: 12px; }
    .body { padding: 32px; }
    .body h2 { color: #1A1A2E; font-size: 18px; margin: 0 0 16px; }
    .body p { color: #555; font-size: 14px; line-height: 1.6; }
    .info-box { background: #F8F9FA; border-left: 4px solid #E85D04; border-radius: 4px; padding: 16px 20px; margin: 20px 0; }
    .info-box .label { color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
    .info-box .value { color: #1A1A2E; font-size: 20px; font-weight: bold; margin: 4px 0 0; }
    .amount-box { background: #1A1A2E; border-radius: 6px; padding: 16px 20px; margin: 20px 0; text-align: center; }
    .amount-box .label { color: rgba(255,255,255,0.6); font-size: 11px; text-transform: uppercase; }
    .amount-box .value { color: #E85D04; font-size: 28px; font-weight: bold; margin: 4px 0 0; }
    .btn { display: inline-block; background: #E85D04; color: #fff !important; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-weight: bold; font-size: 14px; margin: 16px 0; }
    table.details { width: 100%; border-collapse: collapse; margin: 16px 0; }
    table.details td { padding: 8px 0; border-bottom: 1px solid #EEE; font-size: 13px; color: #444; }
    table.details td:last-child { text-align: right; font-weight: bold; color: #1A1A2E; }
    .footer { background: #F8F9FA; padding: 20px 32px; border-top: 1px solid #EEE; text-align: center; }
    .footer p { color: #AAA; font-size: 11px; margin: 4px 0; }
    .status-paid { display: inline-block; background: #E8F8F5; color: #27AE60; font-weight: bold; font-size: 12px; padding: 4px 12px; border-radius: 20px; }
  </style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <h1>BowaGO</h1>
    <p>Fast &amp; Reliable Nigerian Logistics</p>
  </div>
  <div class="body">${content}</div>
  <div class="footer">
    <p>© ${new Date().getFullYear()} BowaGO Logistics Ltd. All rights reserved.</p>
    <p>You received this email because you have an account on BowaGO.</p>
    <p><a href="https://bowago.com" style="color:#E85D04;">bowago.com</a> · support@bowago.com</p>
  </div>
</div>
</body>
</html>`;
}

// ─── Send Invoice Email ───────────────────────────────────────────────────────
async function sendInvoiceEmail({ to, firstName, invoiceNumber, amount, trackingNumber, pdfBuffer }) {
  const html = emailShell(`
    <h2>Your Invoice is Ready, ${firstName}!</h2>
    <p>Thank you for using BowaGO. Please find your invoice attached to this email.</p>

    <div class="info-box">
      <div class="label">Invoice Number</div>
      <div class="value">INV-${invoiceNumber}</div>
    </div>

    <div class="amount-box">
      <div class="label">Amount Paid</div>
      <div class="value">${formatNaira(amount)}</div>
    </div>

    ${trackingNumber ? `
    <div class="info-box">
      <div class="label">Tracking Number</div>
      <div class="value" style="font-size:16px;">${trackingNumber}</div>
    </div>
    <p><a href="https://bowago.com/track/${trackingNumber}" class="btn">Track Your Shipment →</a></p>
    ` : ''}

    <p style="color:#888; font-size:13px;">The attached PDF is your official invoice. Please keep it for your records.</p>
  `);

  await transporter.sendMail({
    from: FROM,
    to,
    subject: `BowaGO Invoice INV-${invoiceNumber}`,
    html,
    attachments: [{
      filename: `BowaGO-Invoice-${invoiceNumber}.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf',
    }],
  });
}

// ─── Send Booking Confirmation Email (with label + confirmation PDF) ──────────
async function sendBookingConfirmationEmail({
  to, firstName, trackingNumber,
  senderCity, recipientCity, amount,
  confirmationPdfBuffer, labelPdfBuffer,
  cutoffWarning,
}) {
  const html = emailShell(`
    <h2>Booking Confirmed! 🎉</h2>
    <p>Hi ${firstName}, your shipment has been booked successfully.</p>

    <div class="info-box">
      <div class="label">Tracking Number</div>
      <div class="value">${trackingNumber}</div>
    </div>

    <table class="details">
      <tr><td>Route</td><td>${senderCity} → ${recipientCity}</td></tr>
      <tr><td>Quoted Price</td><td>${formatNaira(amount)}</td></tr>
    </table>

    ${cutoffWarning ? `
    <div style="background:#FFF3E0; border-left:4px solid #E85D04; padding:12px 16px; margin:16px 0; border-radius:4px;">
      <strong style="color:#E85D04;">⚠ Pickup Notice</strong><br>
      <span style="color:#555; font-size:13px;">Your booking was placed after 2:00 PM. The earliest available pickup is the next business day.</span>
    </div>
    ` : ''}

    <p><a href="https://bowago.com/track/${trackingNumber}" class="btn">Track Shipment →</a></p>

    <p style="color:#888; font-size:13px;">
      Your <strong>booking confirmation</strong> and <strong>shipping label</strong> are attached.
      Please print the shipping label and attach it to your package before pickup.
    </p>

    <p style="color:#888; font-size:12px;">
      Need to package your items properly?
      <a href="https://bowago.com/packaging-guide" style="color:#E85D04;">View our packaging guide →</a>
    </p>
  `);

  const attachments = [
    {
      filename: `BowaGO-Confirmation-${trackingNumber}.pdf`,
      content: confirmationPdfBuffer,
      contentType: 'application/pdf',
    },
  ];

  if (labelPdfBuffer) {
    attachments.push({
      filename: `BowaGO-ShippingLabel-${trackingNumber}.pdf`,
      content: labelPdfBuffer,
      contentType: 'application/pdf',
    });
  }

  await transporter.sendMail({
    from: FROM,
    to,
    subject: `BowaGO Booking Confirmed — ${trackingNumber}`,
    html,
    attachments,
  });
}

// ─── Send Payment Success Email ───────────────────────────────────────────────
async function sendPaymentSuccessEmail({ to, firstName, amount, trackingNumber, reference }) {
  const html = emailShell(`
    <h2>Payment Received ✓</h2>
    <p>Hi ${firstName}, we've received your payment. Your shipment is now confirmed.</p>

    <div class="amount-box">
      <div class="label">Amount Paid</div>
      <div class="value">${formatNaira(amount)}</div>
    </div>

    <table class="details">
      <tr><td>Tracking Number</td><td>${trackingNumber}</td></tr>
      <tr><td>Payment Reference</td><td>${reference}</td></tr>
      <tr><td>Status</td><td><span class="status-paid">PAID</span></td></tr>
    </table>

    <p><a href="https://bowago.com/track/${trackingNumber}" class="btn">Track Your Shipment →</a></p>
    <p style="color:#888; font-size:13px;">A full invoice has been sent to your email and is available in your dashboard.</p>
  `);

  await transporter.sendMail({
    from: FROM,
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
