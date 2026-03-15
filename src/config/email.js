const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const FROM = process.env.EMAIL_FROM || 'BowaGO <noreply@bowago.com>';

async function sendEmail({ to, subject, html, text }) {
  return transporter.sendMail({ from: FROM, to, subject, html, text });
}

async function sendOtpEmail(email, otp, type = 'verify') {
  const subjects = {
    EMAIL_VERIFY: 'Verify your BowaGO account',
    PASSWORD_RESET: 'Reset your BowaGO password',
    LOGIN: 'Your BowaGO login code',
  };

  const subject = subjects[type] || 'Your BowaGO verification code';

  return sendEmail({
    to: email,
    subject,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #E85D04; font-size: 28px; margin: 0;">BowaGO</h1>
          <p style="color: #666; margin: 4px 0 0;">Fast & Reliable Logistics</p>
        </div>
        <div style="background: #f9f9f9; border-radius: 12px; padding: 24px; text-align: center;">
          <h2 style="color: #1a1a1a; margin-top: 0;">${subject}</h2>
          <p style="color: #444; font-size: 15px;">Use the code below. It expires in ${process.env.OTP_EXPIRES_MINUTES || 10} minutes.</p>
          <div style="background: #fff; border: 2px dashed #E85D04; border-radius: 8px; padding: 16px; margin: 20px 0;">
            <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #E85D04;">${otp}</span>
          </div>
          <p style="color: #999; font-size: 13px;">If you didn't request this, please ignore this email.</p>
        </div>
        <p style="text-align: center; color: #bbb; font-size: 12px; margin-top: 24px;">© ${new Date().getFullYear()} BowaGO Logistics. All rights reserved.</p>
      </div>
    `,
  });
}

async function sendShipmentStatusEmail(email, firstName, shipment) {
  const statusLabels = {
    CONFIRMED: 'Confirmed & Processing',
    PICKED_UP: 'Picked Up',
    IN_TRANSIT: 'In Transit',
    OUT_FOR_DELIVERY: 'Out for Delivery',
    DELIVERED: 'Delivered',
    CANCELLED: 'Cancelled',
  };

  const label = statusLabels[shipment.status] || shipment.status;

  return sendEmail({
    to: email,
    subject: `Shipment ${shipment.trackingNumber} – ${label}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
        <h1 style="color: #E85D04;">BowaGO</h1>
        <p>Hi ${firstName},</p>
        <p>Your shipment status has been updated:</p>
        <div style="background: #f4f4f4; border-left: 4px solid #E85D04; padding: 16px; border-radius: 4px;">
          <strong>Tracking #:</strong> ${shipment.trackingNumber}<br/>
          <strong>Status:</strong> ${label}<br/>
          <strong>To:</strong> ${shipment.recipientCity}, ${shipment.recipientState}
        </div>
        <p style="margin-top: 20px;">Track your shipment on the BowaGO app.</p>
      </div>
    `,
  });
}

module.exports = { sendEmail, sendOtpEmail, sendShipmentStatusEmail };
