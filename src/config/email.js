/**
 * BowaGO Email Service
 *
 * Single source of truth for all transactional emails.
 * All templates share one branded shell:
 *   - Light emails (OTP, invite, status): white bg + red header with bowago-logo.svg
 *   - Dark emails (invoice): use the same shell; amounts in dark accent boxes
 *
 * Logo: served from FRONTEND_URL/bowago-logo.svg (white variant for red header)
 *       and FRONTEND_URL/bowago-dark-logo.svg (dark variant for white bg)
 */

const nodemailer = require("nodemailer");

// ─── Provider selection ─────────────────────────────────────────────────────
// Three supported configurations, checked in this priority order:
//
//   1. RESEND_API_KEY (recommended if SMTP ports are blocked on your
//      network) — sends over Resend's HTTPS API instead of SMTP entirely.
//      This sidesteps outbound-port blocking completely: HTTPS/443 is
//      essentially never blocked the way SMTP ports 587/465/25 commonly
//      are on residential ISPs, school/corporate networks, and some cloud
//      providers. Sign up free at resend.com, verify a sending domain (or
//      use their shared onboarding domain for testing), grab an API key.
//   2. EMAIL_SERVICE=gmail (or another nodemailer well-known service) — the
//      SMTP path. Uses Google's own correct host/port/TLS settings
//      internally, so "wrong host/port" isn't a possible failure mode, but
//      it's still SMTP and still subject to your network blocking those
//      ports outbound. Use a Gmail App Password for SMTP_PASS, not your
//      normal password: myaccount.google.com/apppasswords
//   3. SMTP_HOST/SMTP_PORT (manual) — a custom/self-hosted SMTP server, or
//      a provider nodemailer doesn't have a shortcut for.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_SERVICE = process.env.EMAIL_SERVICE; // e.g. "gmail"

let resendClient = null;
if (RESEND_API_KEY) {
  const { Resend } = require("resend");
  resendClient = new Resend(RESEND_API_KEY);
}

const SMTP_CONFIGURED = !!(
  process.env.SMTP_USER &&
  process.env.SMTP_PASS &&
  (EMAIL_SERVICE || process.env.SMTP_HOST)
);
const EMAIL_CONFIGURED = !!RESEND_API_KEY || SMTP_CONFIGURED;

if (!EMAIL_CONFIGURED) {
  console.error(
    "\n[email.js] ⚠️  Email is NOT configured — every send (invites, OTPs, " +
      "invoices, notifications) will fail until this is set up.\n" +
      `  RESEND_API_KEY: ${RESEND_API_KEY ? "set" : "not set"}\n` +
      `  EMAIL_SERVICE: ${EMAIL_SERVICE || "not set"}\n` +
      `  SMTP_HOST: ${process.env.SMTP_HOST ? "set" : "not set"}\n` +
      `  SMTP_USER: ${process.env.SMTP_USER ? "set" : "MISSING"}\n` +
      `  SMTP_PASS: ${process.env.SMTP_PASS ? "set" : "MISSING"}\n\n` +
      "  Recommended if SMTP ports are blocked on your network: sign up " +
      "free at resend.com and set RESEND_API_KEY — sends over HTTPS, not " +
      "SMTP, so outbound port blocking can't affect it.\n" +
      "  Otherwise: EMAIL_SERVICE=gmail + SMTP_USER=<your gmail> + " +
      "SMTP_PASS=<16-char App Password from myaccount.google.com/apppasswords>\n",
  );
} else if (RESEND_API_KEY) {
  console.log("[email.js] Email configured via Resend HTTP API.");
} else if (EMAIL_SERVICE) {
  console.log(
    `[email.js] Email configured via SMTP service shortcut: ${EMAIL_SERVICE} as ${process.env.SMTP_USER}`,
  );
} else {
  console.log(
    `[email.js] Email configured via manual SMTP: ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587} as ${process.env.SMTP_USER}`,
  );
}

// Only construct the SMTP transporter if we're actually going to use it —
// no point paying nodemailer's setup cost (or triggering its own internal
// checks) when Resend is configured and will be used for every send instead.
const transporter =
  !RESEND_API_KEY && SMTP_CONFIGURED
    ? EMAIL_SERVICE
      ? nodemailer.createTransport({
          service: EMAIL_SERVICE,
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          },
        })
      : nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT) || 587,
          secure: process.env.SMTP_PORT === "465",
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          },
        })
    : null;

// One-time connection check at startup (SMTP path only — Resend's HTTPS
// API doesn't need this, failures there show up per-request instead).
// Verifies the transporter can actually authenticate with the SMTP server
// (catches wrong password, IP not whitelisted, etc.) rather than only
// finding out on the first real send attempt, potentially days after deploy.
if (transporter) {
  transporter.verify((err) => {
    if (err) {
      console.error(
        `[email.js] ⚠️  SMTP connection verification FAILED: ${err.message}\n` +
          (err.code === "ETIMEDOUT" || err.code === "ECONNREFUSED"
            ? "  This is a NETWORK problem, not a credentials problem — the " +
              "connection to the mail server never completed. Your network/" +
              "ISP/firewall is very likely blocking outbound SMTP ports " +
              "(587/465/25), which some ISPs and corporate/school networks " +
              "do by default.\n" +
              "  Fix: set RESEND_API_KEY instead — see the note at the top " +
              "of this file. It sends over HTTPS, which this kind of block " +
              "doesn't affect."
            : "  This usually means wrong credentials — for Gmail, make sure " +
              "SMTP_PASS is a 16-character App Password from " +
              "myaccount.google.com/apppasswords, not your normal account " +
              "password (Google rejects plain-password SMTP auth entirely)."),
      );
    } else {
      console.log("[email.js] ✓ SMTP connection verified successfully.");
    }
  });
}

const FROM = process.env.EMAIL_FROM || "BowaGO <noreply@bowago.ng>";
const FRONTEND = process.env.FRONTEND_URL || "https://bowago.vercel.app";

// ─── Shared branded shell ─────────────────────────────────────────────────────
// Uses the hosted SVG logo from the frontend's /public folder.
// The white logo (bowago-logo.svg) sits on the red header.
// Email clients that block external images will fall back to the alt text "BowaGO".
function emailShell(bodyHtml, { preheader = "" } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <meta http-equiv="X-UA-Compatible" content="IE=edge"/>
  <!--[if mso]><xml><o:OfficeDocumentSettings><o:AllowPNG/></o:OfficeDocumentSettings></xml><![endif]-->
  <title>BowaGO</title>
  <style>
    body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
    table,td{mso-table-lspace:0;mso-table-rspace:0}
    img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none}
    body{margin:0;padding:0;background:#F2F4F7;font-family:Arial,Helvetica,sans-serif}
    .wrapper{max-width:600px;margin:0 auto}
    .header{background:#CC0000;padding:28px 40px 24px}
    .logo-img{height:36px;width:auto;display:block}
    .tagline{color:rgba(255,255,255,0.75);font-size:11px;margin:4px 0 0;letter-spacing:0.4px}
    .body-cell{background:#ffffff;padding:36px 40px 32px}
    .body-cell h2{color:#111111;font-size:20px;font-weight:700;margin:0 0 14px;line-height:1.3}
    .body-cell p{color:#555555;font-size:14px;line-height:1.7;margin:0 0 14px}
    .info-box{background:#F8F9FA;border-left:4px solid #CC0000;border-radius:4px;padding:14px 20px;margin:20px 0}
    .info-box .lbl{color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 3px}
    .info-box .val{color:#111;font-size:22px;font-weight:700;margin:0;letter-spacing:-0.3px}
    .amount-box{background:#1A1A2E;border-radius:6px;padding:18px 20px;margin:20px 0;text-align:center}
    .amount-box .lbl{color:rgba(255,255,255,0.55);font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 4px}
    .amount-box .val{color:#CC0000;font-size:30px;font-weight:700;margin:0}
    .btn{display:inline-block;background:#CC0000;color:#ffffff !important;text-decoration:none;padding:13px 32px;border-radius:8px;font-weight:700;font-size:14px;margin:6px 0}
    .details-table{width:100%;border-collapse:collapse;margin:16px 0;font-size:13px}
    .details-table td{padding:9px 0;border-bottom:1px solid #EEEEEE;color:#444}
    .details-table td:last-child{text-align:right;font-weight:600;color:#111}
    .otp-box{background:#fff;border:2px dashed #CC0000;border-radius:10px;padding:18px;margin:22px 0;text-align:center}
    .otp-code{font-size:38px;font-weight:700;letter-spacing:10px;color:#CC0000;display:block}
    .status-badge{display:inline-block;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:600}
    .status-ok{background:#E8F8F5;color:#27AE60}
    .notice-box{background:#FFF8E7;border-left:4px solid #F0A500;border-radius:4px;padding:12px 16px;margin:16px 0;font-size:13px;color:#7A5200}
    .footer-cell{background:#F8F9FA;padding:20px 40px;border-top:1px solid #EEEEEE;text-align:center}
    .footer-cell p{color:#AAAAAA;font-size:11px;margin:3px 0;line-height:1.6}
    .footer-cell a{color:#CC0000;text-decoration:none}
    .link-fallback{color:#CC0000;font-size:12px;word-break:break-all}
    @media only screen and (max-width:620px){
      .body-cell{padding:28px 24px 24px}
      .header{padding:22px 24px 20px}
      .footer-cell{padding:16px 24px}
      .otp-code{font-size:30px;letter-spacing:6px}
      .amount-box .val{font-size:24px}
    }
  </style>
</head>
<body>
  ${preheader ? `<div style="display:none;font-size:1px;color:#F2F4F7;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}</div>` : ""}
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F2F4F7;padding:24px 0">
    <tr><td align="center">
      <table class="wrapper" width="600" cellpadding="0" cellspacing="0" border="0">
        <!-- HEADER -->
        <tr>
          <td class="header">
            <img src="${FRONTEND}/bowago-logo.svg" alt="BowaGO" class="logo-img" />
            <p class="tagline">Fast &amp; Reliable Nigerian Logistics</p>
          </td>
        </tr>
        <!-- BODY -->
        <tr><td class="body-cell">${bodyHtml}</td></tr>
        <!-- FOOTER -->
        <tr>
          <td class="footer-cell">
            <p>© ${new Date().getFullYear()} Bowagate Global LTD. All rights reserved.</p>
            <p>You received this email because you have an account on BowaGO.</p>
            <p><a href="${FRONTEND}">bowago.ng</a> &nbsp;·&nbsp; support@bowago.ng</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Generic send ─────────────────────────────────────────────────────────────

async function sendEmail({ to, subject, html, text }) {
  if (!EMAIL_CONFIGURED) {
    console.error(
      `[email.js] ✗ Skipped sending "${subject}" to ${to} — email is not configured (see startup warning above).`,
    );
    throw new Error("Email is not configured on this server");
  }

  // Resend takes priority when configured — sends over HTTPS, so it isn't
  // subject to the outbound-SMTP-port blocking that SMTP (via transporter
  // below) can run into on some networks.
  if (resendClient) {
    try {
      const { data, error } = await resendClient.emails.send({
        from: FROM,
        to,
        subject,
        html,
        text,
      });
      if (error) {
        console.error(
          `[email.js] ✗ Resend failed to send "${subject}" to ${to}: ${error.message}`,
        );
        throw new Error(error.message);
      }
      console.log(
        `[email.js] ✓ Sent "${subject}" to ${to} via Resend (id: ${data?.id})`,
      );
      return data;
    } catch (err) {
      console.error(
        `[email.js] ✗ Failed to send "${subject}" to ${to} via Resend: ${err.message}`,
      );
      throw err;
    }
  }

  try {
    const info = await transporter.sendMail({
      from: FROM,
      to,
      subject,
      html,
      text,
    });
    console.log(
      `[email.js] ✓ Sent "${subject}" to ${to} via SMTP (messageId: ${info.messageId}${info.accepted?.length ? `, accepted: ${info.accepted.join(",")}` : ""}${info.rejected?.length ? `, REJECTED: ${info.rejected.join(",")}` : ""})`,
    );
    return info;
  } catch (err) {
    console.error(
      `[email.js] ✗ Failed to send "${subject}" to ${to} via SMTP: ${err.message}`,
    );
    throw err;
  }
}

// ─── OTP / Verification ───────────────────────────────────────────────────────

async function sendOtpEmail(email, otp, type = "EMAIL_VERIFY") {
  const configs = {
    EMAIL_VERIFY: {
      subject: "Verify your BowaGO account",
      heading: "Confirm your email address",
      note: "Enter this code to complete your registration.",
    },
    PASSWORD_RESET: {
      subject: "Reset your BowaGO password",
      heading: "Password reset code",
      note: "Use this code to reset your password. Don't share it with anyone.",
    },
    LOGIN: {
      subject: "Your BowaGO login code",
      heading: "Two-factor login code",
      note: "Use this code to complete your sign-in.",
    },
  };

  const { subject, heading, note } = configs[type] || configs.EMAIL_VERIFY;
  const expiryMin = process.env.OTP_EXPIRES_MINUTES || 10;

  const html = emailShell(
    `
    <h2>${heading}</h2>
    <p>${note} It expires in <strong>${expiryMin} minutes</strong>.</p>
    <div class="otp-box">
      <span class="otp-code">${otp}</span>
    </div>
    <p style="color:#999;font-size:13px;">If you didn't request this, you can safely ignore this email. Your account remains secure.</p>
  `,
    { preheader: `Your BowaGO verification code: ${otp}` },
  );

  return sendEmail({ to: email, subject, html });
}

// ─── Shipment Status Update ───────────────────────────────────────────────────

async function sendShipmentStatusEmail(email, firstName, shipment) {
  const statusLabels = {
    CONFIRMED: "Confirmed & Processing",
    PICKED_UP: "Picked Up",
    IN_TRANSIT: "In Transit",
    OUT_FOR_DELIVERY: "Out for Delivery",
    DELIVERED: "Delivered",
    CANCELLED: "Cancelled",
    DELAY_ALERT: "Delay Alert",
  };

  const label = statusLabels[shipment.status] || shipment.status;
  const trackingUrl = `${FRONTEND}/track?q=${shipment.trackingNumber}`;
  const isDelivered = shipment.status === "DELIVERED";
  const isCancelled = shipment.status === "CANCELLED";
  const isDelay = shipment.status === "DELAY_ALERT";

  const html = emailShell(
    `
    <h2>Shipment Update</h2>
    <p>Hi ${firstName},</p>
    <p>Your shipment status has been updated.</p>

    <div class="info-box">
      <p class="lbl">Tracking Number</p>
      <p class="val" style="font-size:18px;color:#CC0000;">${shipment.trackingNumber}</p>
    </div>

    <table class="details-table">
      <tr><td>Status</td><td>${label}</td></tr>
      <tr><td>Destination</td><td>${shipment.recipientCity}, ${shipment.recipientState}</td></tr>
      ${shipment.estimatedDelivery ? `<tr><td>Est. Delivery</td><td>${new Date(shipment.estimatedDelivery).toLocaleDateString("en-NG", { dateStyle: "medium" })}</td></tr>` : ""}
    </table>

    ${isDelay ? '<div class="notice-box"><strong>Notice:</strong> Your shipment has experienced a delay. Our team is working to resolve this. You will receive an update shortly.</div>' : ""}
    ${isDelivered ? "<p>Your package has been delivered! We hope it arrived in perfect condition.</p>" : ""}
    ${isCancelled ? `<p>Your shipment has been cancelled. If this was unexpected, please contact our support team.</p>` : ""}

    <p><a href="${trackingUrl}" class="btn">Track Your Shipment →</a></p>
    <p style="color:#AAAAAA;font-size:12px;">If the button doesn't work, copy this link:<br/>
      <a href="${trackingUrl}" class="link-fallback">${trackingUrl}</a>
    </p>
  `,
    { preheader: `Shipment ${shipment.trackingNumber} — ${label}` },
  );

  return sendEmail({
    to: email,
    subject: `Shipment ${shipment.trackingNumber} — ${label}`,
    html,
  });
}

// ─── Team Invite ──────────────────────────────────────────────────────────────

async function sendInviteEmail({
  toEmail,
  inviterName,
  role,
  inviteUrl,
  expiryDays = 7,
  accessLabel = null,
}) {
  const roleLabel = role.replace(/^ROLE_/, "").replace(/_/g, " ");
  const accessNote = accessLabel
    ? `<p>Access level: <strong>${accessLabel}</strong></p>`
    : "";

  const html = emailShell(
    `
    <h2>You've been invited to BowaGO!</h2>
    <p><strong>${inviterName}</strong> has invited you to join the BowaGO logistics platform as a <strong>${roleLabel}</strong>.</p>
    ${accessNote}
    <p>Click the button below to accept your invite and set your password. This link expires in <strong>${expiryDays} days</strong>.</p>
    <p><a href="${inviteUrl}" class="btn">Accept Invite →</a></p>
    <p style="color:#AAAAAA;font-size:12px;margin-top:16px;">Or copy this link into your browser:<br/>
      <a href="${inviteUrl}" class="link-fallback">${inviteUrl}</a>
    </p>
    <p style="color:#AAAAAA;font-size:12px;margin-top:16px;">If you did not expect this invite, you can safely ignore this email.</p>
  `,
    { preheader: `${inviterName} invited you to join BowaGO` },
  );

  return sendEmail({
    to: toEmail,
    subject: "You've been invited to join BowaGO",
    html,
  });
}

// ─── Password Reset (convenience alias) ───────────────────────────────────────

async function sendPasswordResetEmail(email, otp) {
  return sendOtpEmail(email, otp, "PASSWORD_RESET");
}

module.exports = {
  sendEmail,
  sendOtpEmail,
  sendShipmentStatusEmail,
  sendInviteEmail,
  sendPasswordResetEmail,
  transporter,
  emailShell, // exported for invoiceEmail.service.js
  FRONTEND,
};
