const { prisma } = require('../config/db');
const { sendOtpEmail } = require('../config/email');
const { generateOtp } = require('../utils/helpers');
const { ApiError } = require('../utils/ApiError');

const OTP_EXPIRES_MINUTES = parseInt(process.env.OTP_EXPIRES_MINUTES) || 10;
const MAX_ATTEMPTS = parseInt(process.env.OTP_MAX_ATTEMPTS) || 5;

async function sendOtp(userId, email, type) {
  // Invalidate any existing unused OTPs of same type
  await prisma.otpCode.updateMany({
    where: { userId, type, usedAt: null },
    data: { usedAt: new Date() }, // Mark as used/expired
  });

  const code = generateOtp(6);
  const expiresAt = new Date(Date.now() + OTP_EXPIRES_MINUTES * 60 * 1000);

  await prisma.otpCode.create({
    data: { userId, code, type, expiresAt },
  });

  await sendOtpEmail(email, code, type);
  return code;
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

  // Increment attempts
  await prisma.otpCode.update({
    where: { id: otp.id },
    data: { attempts: { increment: 1 } },
  });

  if (otp.attempts >= MAX_ATTEMPTS) {
    throw new ApiError(400, 'Too many failed attempts. Please request a new code.');
  }

  if (otp.code !== code) {
    throw new ApiError(400, 'Invalid verification code');
  }

  // Mark as used
  await prisma.otpCode.update({
    where: { id: otp.id },
    data: { usedAt: new Date() },
  });

  return true;
}

module.exports = { sendOtp, verifyOtp };
