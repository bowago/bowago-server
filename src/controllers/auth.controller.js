const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const { prisma } = require('../config/db');
const { generateTokenPair, verifyRefreshToken, revokeRefreshToken, revokeAllUserTokens } = require('../config/jwt');
const { sendOtp, verifyOtp } = require('../services/otp.service');
const { ApiError } = require('../utils/ApiError');
const { success } = require('../utils/helpers');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ─── Helper: safe user output ─────────────────────────────────────────────────
function safeUser(user) {
  const { passwordHash, ...safe } = user;
  return safe;
}

// ─── REGISTER ─────────────────────────────────────────────────────────────────
async function register(req, res) {
  const { email, password, firstName, lastName, phone } = req.body;

  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) throw new ApiError(409, 'Email already registered');

  if (phone) {
    const phoneExists = await prisma.user.findUnique({ where: { phone } });
    if (phoneExists) throw new ApiError(409, 'Phone number already registered');
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.create({
    data: { email, passwordHash, firstName, lastName, phone, authProvider: 'EMAIL' },
  });

  // Send email verification OTP
  await sendOtp(user.id, email, 'EMAIL_VERIFY');

  return success(res, { userId: user.id, email }, 'Registration successful. Check your email for verification code.', 201);
}

// ─── VERIFY EMAIL ─────────────────────────────────────────────────────────────
async function verifyEmail(req, res) {
  const { email, code } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new ApiError(404, 'User not found');
  if (user.isEmailVerified) throw new ApiError(400, 'Email already verified');

  await verifyOtp(user.id, code, 'EMAIL_VERIFY');

  await prisma.user.update({
    where: { id: user.id },
    data: { isEmailVerified: true },
  });

  const tokens = await generateTokenPair(user, req.headers['user-agent'], req.ip);

  return success(res, { user: safeUser(user), ...tokens }, 'Email verified successfully');
}

// ─── RESEND OTP ───────────────────────────────────────────────────────────────
async function resendOtp(req, res) {
  const { email, type } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new ApiError(404, 'User not found');

  await sendOtp(user.id, email, type || 'EMAIL_VERIFY');

  return success(res, {}, 'Verification code sent');
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
async function login(req, res) {
  const { email, password } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) throw new ApiError(401, 'Invalid email or password');
  if (!user.isActive) throw new ApiError(403, 'Account suspended. Contact support.');

  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) throw new ApiError(401, 'Invalid email or password');

  if (!user.isEmailVerified) {
    await sendOtp(user.id, email, 'EMAIL_VERIFY');
    throw new ApiError(403, 'Email not verified. A new code has been sent to your email.');
  }

  const tokens = await generateTokenPair(user, req.headers['user-agent'], req.ip);

  return success(res, { user: safeUser(user), ...tokens }, 'Login successful');
}

// ─── GOOGLE OAUTH ─────────────────────────────────────────────────────────────
async function googleAuth(req, res) {
  const { idToken } = req.body;

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (err) {
    throw new ApiError(401, 'Invalid Google token');
  }

  const { sub: googleId, email, given_name: firstName, family_name: lastName, picture: avatar } = payload;

  let user = await prisma.user.findFirst({
    where: { OR: [{ googleId }, { email }] },
  });

  if (user) {
    // Link Google account if not already linked
    if (!user.googleId) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { googleId, isEmailVerified: true, ...(avatar && !user.avatar ? { avatar } : {}) },
      });
    }
  } else {
    // Create new user
    user = await prisma.user.create({
      data: {
        email,
        firstName: firstName || 'User',
        lastName: lastName || '',
        googleId,
        avatar,
        authProvider: 'GOOGLE',
        isEmailVerified: true,
      },
    });
  }

  if (!user.isActive) throw new ApiError(403, 'Account suspended');

  const tokens = await generateTokenPair(user, req.headers['user-agent'], req.ip);

  return success(res, { user: safeUser(user), ...tokens }, 'Google authentication successful');
}

// ─── APPLE OAUTH ──────────────────────────────────────────────────────────────
async function appleAuth(req, res) {
  const { identityToken, user: appleUser } = req.body;

  // Verify Apple token (simplified — use apple-signin-auth in production)
  // The identity token is a JWT signed by Apple. Here we decode to get sub.
  let appleId, email, firstName, lastName;
  try {
    // Decode without verifying signature (Apple keys need fetching; use library in prod)
    const base64Payload = identityToken.split('.')[1];
    const decoded = JSON.parse(Buffer.from(base64Payload, 'base64').toString('utf8'));
    appleId = decoded.sub;
    email = decoded.email || appleUser?.email;
  } catch (err) {
    throw new ApiError(401, 'Invalid Apple token');
  }

  if (appleUser?.name) {
    firstName = appleUser.name.firstName;
    lastName = appleUser.name.lastName;
  }

  let user = await prisma.user.findFirst({
    where: { OR: [{ appleId }, ...(email ? [{ email }] : [])] },
  });

  if (user) {
    if (!user.appleId) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { appleId, isEmailVerified: true },
      });
    }
  } else {
    user = await prisma.user.create({
      data: {
        email: email || `apple_${appleId}@bowago.internal`,
        firstName: firstName || 'User',
        lastName: lastName || '',
        appleId,
        authProvider: 'APPLE',
        isEmailVerified: true,
      },
    });
  }

  if (!user.isActive) throw new ApiError(403, 'Account suspended');

  const tokens = await generateTokenPair(user, req.headers['user-agent'], req.ip);

  return success(res, { user: safeUser(user), ...tokens }, 'Apple authentication successful');
}

// ─── REFRESH TOKEN ────────────────────────────────────────────────────────────
async function refreshToken(req, res) {
  const { refreshToken: token } = req.body;
  if (!token) throw new ApiError(400, 'Refresh token required');

  let decoded;
  try {
    decoded = verifyRefreshToken(token);
  } catch (err) {
    throw new ApiError(401, 'Invalid or expired refresh token');
  }

  const storedToken = await prisma.refreshToken.findUnique({ where: { token } });
  if (!storedToken || storedToken.revokedAt || storedToken.expiresAt < new Date()) {
    throw new ApiError(401, 'Refresh token revoked or expired');
  }

  const user = await prisma.user.findUnique({ where: { id: decoded.sub } });
  if (!user || !user.isActive) throw new ApiError(401, 'User not found or suspended');

  // Rotate: revoke old, issue new pair
  await revokeRefreshToken(token);
  const tokens = await generateTokenPair(user, req.headers['user-agent'], req.ip);

  return success(res, tokens, 'Token refreshed');
}

// ─── FORGOT PASSWORD ──────────────────────────────────────────────────────────
async function forgotPassword(req, res) {
  const { email } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });
  // Don't reveal if user exists
  if (user) {
    await sendOtp(user.id, email, 'PASSWORD_RESET');
  }

  return success(res, {}, 'If that email is registered, you will receive a reset code.');
}

// ─── RESET PASSWORD ───────────────────────────────────────────────────────────
async function resetPassword(req, res) {
  const { email, code, newPassword } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new ApiError(404, 'User not found');

  await verifyOtp(user.id, code, 'PASSWORD_RESET');

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

  // Revoke all sessions after password reset
  await revokeAllUserTokens(user.id);

  return success(res, {}, 'Password reset successfully. Please log in again.');
}

// ─── CHANGE PASSWORD ──────────────────────────────────────────────────────────
async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  const userId = req.user.id;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user.passwordHash) throw new ApiError(400, 'Cannot change password for social login accounts');

  const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!isValid) throw new ApiError(400, 'Current password is incorrect');

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });

  return success(res, {}, 'Password changed successfully');
}

// ─── LOGOUT ───────────────────────────────────────────────────────────────────
async function logout(req, res) {
  const { refreshToken: token } = req.body;
  if (token) await revokeRefreshToken(token);
  return success(res, {}, 'Logged out successfully');
}

// ─── LOGOUT ALL DEVICES ───────────────────────────────────────────────────────
async function logoutAll(req, res) {
  await revokeAllUserTokens(req.user.id);
  return success(res, {}, 'Logged out from all devices');
}

module.exports = {
  register,
  verifyEmail,
  resendOtp,
  login,
  googleAuth,
  appleAuth,
  refreshToken,
  forgotPassword,
  resetPassword,
  changePassword,
  logout,
  logoutAll,
};
