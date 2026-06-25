const bcrypt = require('bcryptjs');
const { prisma } = require('../config/db');
const { sendOtpEmail } = require('../config/email');
const { sendOtpSms } = require('./sms.service');
const { generateOtp } = require('../utils/helpers');
const { ApiError } = require('../utils/ApiError');

const OTP_EXPIRES_MINUTES = parseInt(process.env.OTP_EXPIRES_MINUTES) || 10;
const MAX_ATTEMPTS = parseInt(process.env.OTP_MAX_ATTEMPTS) || 3;
const BCRYPT_ROUNDS = 8; // fast enough for OTPs, strong enough for storage

/**
 * @param {string} userId
 * @param {string} destination - email address (channel='EMAIL') or phone number (channel='SMS')
 * @param {string} type - OTP purpose, e.g. 'EMAIL_VERIFY', 'TWO_FACTOR_LOGIN'
 * @param {'EMAIL'|'SMS'} channel - delivery channel, defaults to EMAIL
 */
async function sendOtp(userId, destination, type, channel = 'EMAIL') {
  // Invalidate any existing unused OTPs of same type
  await prisma.otpCode.updateMany({
    where: { userId, type, usedAt: null },
    data: { usedAt: new Date() },
  });

  const code = generateOtp(6);
  const hashedCode = await bcrypt.hash(code, BCRYPT_ROUNDS); // Gap 4: store hash, never plaintext
  const expiresAt = new Date(Date.now() + OTP_EXPIRES_MINUTES * 60 * 1000);

  await prisma.otpCode.create({
    data: { userId, code: hashedCode, type, expiresAt },
  });

  if (channel === 'SMS') {
    await sendOtpSms(destination, code); // send plaintext code to user
  } else {
    await sendOtpEmail(destination, code, type);
  }

  return code; // only returned internally (for tests); never persisted in plain form
}

async function verifyOtp(userId, code, type) {
  const otp = await prisma.otpCode.findFirst({
    where: {
      userId,
      type,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!otp) throw new ApiError(400, 'Invalid or expired verification code');

  // Reject if the attempt limit was already reached on a previous try
  if (otp.attempts >= MAX_ATTEMPTS) {
    throw new ApiError(400, 'Too many failed attempts. Please request a new code.');
  }

  // Increment attempts before comparing — prevents brute-force even on slow bcrypt
  await prisma.otpCode.update({
    where: { id: otp.id },
    data: { attempts: { increment: 1 } },
  });

  // Gap 4: bcrypt compare instead of plaintext equality
  const isMatch = await bcrypt.compare(String(code), otp.code);
  if (!isMatch) {
    throw new ApiError(400, 'Invalid verification code');
  }

  // Mark as used — deleted by nightly cleanup or next sendOtp call for same type
  await prisma.otpCode.update({
    where: { id: otp.id },
    data: { usedAt: new Date() },
  });

  return true;
}

module.exports = { sendOtp, verifyOtp };
