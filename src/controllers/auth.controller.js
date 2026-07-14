const bcrypt = require("bcryptjs");
const { OAuth2Client } = require("google-auth-library");
const { prisma } = require("../config/db");
const {
  generateTokenPair,
  verifyRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
} = require("../config/jwt");
const { sendOtp, verifyOtp } = require("../services/otp.service");
const { isConfigured: isSmsConfigured } = require("../services/sms.service");
const { ApiError } = require("../utils/ApiError");
const { success } = require("../utils/helpers");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ─── Helper: safe user output ─────────────────────────────────────────────────
function safeUser(user) {
  const { passwordHash, ...safe } = user;
  return safe;
}

// Mask a phone number for display, e.g. "08012345678" -> "***45678"
function maskPhone(phone) {
  const digits = String(phone);
  if (digits.length <= 4) return digits;
  return "***" + digits.slice(-4);
}

// ─── REGISTER ─────────────────────────────────────────────────────────────────
async function register(req, res) {
  const { email, password, firstName, lastName, phone } = req.body;

  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) throw new ApiError(409, "Email already registered");

  if (phone) {
    const phoneExists = await prisma.user.findUnique({ where: { phone } });
    if (phoneExists) throw new ApiError(409, "Phone number already registered");
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      firstName,
      lastName,
      phone,
      authProvider: "EMAIL",
    },
  });

  // Send email verification OTP — delivery failures no longer throw (see
  // otp.service.js), so a downstream SMTP outage can't turn a successful
  // account creation into a 500 that makes it look like registration itself
  // failed. The response reflects what actually happened instead.
  const otpResult = await sendOtp(user.id, email, "EMAIL_VERIFY");

  return success(
    res,
    { userId: user.id, email, emailDelivered: otpResult.delivered },
    otpResult.delivered
      ? "Registration successful. Check your email for verification code."
      : 'Registration successful, but the verification email failed to send. Use "Resend code" in a moment, or contact support.',
    201,
  );
}

// ─── VERIFY EMAIL ─────────────────────────────────────────────────────────────
async function verifyEmail(req, res) {
  const { email, code } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new ApiError(404, "User not found");
  if (user.isEmailVerified) throw new ApiError(400, "Email already verified");

  await verifyOtp(user.id, code, "EMAIL_VERIFY");

  await prisma.user.update({
    where: { id: user.id },
    data: { isEmailVerified: true },
  });

  const tokens = await generateTokenPair(
    user,
    req.headers["user-agent"],
    req.ip,
  );

  return success(
    res,
    { user: safeUser(user), ...tokens },
    "Email verified successfully",
  );
}

// ─── RESEND OTP ───────────────────────────────────────────────────────────────
async function resendOtp(req, res) {
  const { email, type } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new ApiError(404, "User not found");

  await sendOtp(user.id, email, type || "EMAIL_VERIFY");

  return success(res, {}, "Verification code sent");
}

// ─── LOGIN LOCKOUT HELPERS ────────────────────────────────────────────────────
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

async function checkLoginLockout(email) {
  const record = await prisma.loginAttempt.findUnique({ where: { email } });
  if (!record) return; // no failures yet
  if (record.lockedUntil && new Date() < record.lockedUntil) {
    const remainingMs = record.lockedUntil - new Date();
    const remainingMin = Math.ceil(remainingMs / 60000);
    throw new ApiError(
      429,
      `Account temporarily locked due to too many failed attempts. Try again in ${remainingMin} minute${remainingMin === 1 ? "" : "s"}.`,
    );
  }
}

async function recordFailedLogin(email) {
  const record = await prisma.loginAttempt.upsert({
    where: { email },
    create: { email, failedCount: 1, lastAttemptAt: new Date() },
    update: { failedCount: { increment: 1 }, lastAttemptAt: new Date() },
  });
  // Lock after MAX_FAILED_ATTEMPTS
  if (record.failedCount >= MAX_FAILED_ATTEMPTS) {
    await prisma.loginAttempt.update({
      where: { email },
      data: { lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS) },
    });
  }
}

async function clearLoginAttempts(email) {
  await prisma.loginAttempt.deleteMany({ where: { email } });
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
async function login(req, res) {
  const { email, password } = req.body;

  // ─── PRD Sprint 2: Check lockout before any DB user lookup ──────────────
  await checkLoginLockout(email);

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) {
    // Still record the failed attempt even for unknown emails (prevents enumeration timing)
    await recordFailedLogin(email);
    throw new ApiError(401, "Invalid email or password");
  }
  if (!user.isActive)
    throw new ApiError(403, "Account suspended. Contact support.");

  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) {
    await recordFailedLogin(email);
    throw new ApiError(401, "Invalid email or password");
  }
  // Successful password check — clear lockout
  await clearLoginAttempts(email);

  if (!user.isEmailVerified) {
    await sendOtp(user.id, email, "EMAIL_VERIFY");
    throw new ApiError(
      403,
      "Email not verified. A new code has been sent to your email.",
    );
  }

  // ─── 2FA challenge ──────────────────────────────────────────────────────
  // PRD Sprint 2: "SMS fails → Email fallback automatically. Both fail → 503"
  if (user.twoFactorEnabled) {
    let deliveryChannel = "EMAIL";
    if (user.twoFactorMethod === "SMS" && user.phone) {
      try {
        await sendOtp(user.id, user.phone, "TWO_FACTOR_LOGIN", "SMS");
        deliveryChannel = "SMS";
      } catch (smsErr) {
        // SMS failed — auto-fallback to email per PRD
        try {
          await sendOtp(user.id, email, "TWO_FACTOR_LOGIN", "EMAIL");
          deliveryChannel = "EMAIL";
        } catch (emailErr) {
          throw new ApiError(
            503,
            "Unable to send verification code. Please try again later.",
          );
        }
      }
    } else {
      await sendOtp(user.id, email, "TWO_FACTOR_LOGIN", "EMAIL");
    }
    return success(
      res,
      {
        requires2FA: true,
        email: user.email,
        deliveryChannel,
      },
      `Verification code sent via ${deliveryChannel === "SMS" ? "SMS" : "email"}. Enter it to complete login.`,
    );
  }

  const tokens = await generateTokenPair(
    user,
    req.headers["user-agent"],
    req.ip,
  );

  return success(res, { user: safeUser(user), ...tokens }, "Login successful");
}

// ─── COMPLETE LOGIN WITH 2FA CODE ──────────────────────────────────────────────
async function verifyLogin2FA(req, res) {
  const { email, otp } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new ApiError(401, "Invalid email or code");
  if (!user.isActive)
    throw new ApiError(403, "Account suspended. Contact support.");

  await verifyOtp(user.id, otp, "TWO_FACTOR_LOGIN");

  const tokens = await generateTokenPair(
    user,
    req.headers["user-agent"],
    req.ip,
    new Date(),
  );
  return success(res, { user: safeUser(user), ...tokens }, "Login successful");
}

// ─── 2FA SETUP — send confirmation code to chosen channel ─────────────────────
async function setup2FA(req, res) {
  const { method } = req.body; // 'EMAIL' | 'SMS'

  if (!["EMAIL", "SMS"].includes(method)) {
    throw new ApiError(400, 'method must be "EMAIL" or "SMS"');
  }

  const user = req.user;
  // FIX: this used to short-circuit here with NO OTP sent whenever
  // twoFactorEnabled was already true — including for users whose current
  // session token has no (or an expired) mfaVerifiedAt claim. That left them
  // with no way to refresh their MFA session and pass requireRecentMFA on
  // pages like Invoices, short of disabling and re-enabling 2FA entirely.
  // Now: still send a fresh OTP and let it flow through to verify2FA, which
  // mints a new token with mfaVerifiedAt set. `alreadyEnabled` is still
  // returned so the frontend can show "Verify to continue" copy instead of
  // "Enable 2FA" copy.
  const alreadyEnabled = !!user.twoFactorEnabled;
  const effectiveMethod = alreadyEnabled
    ? user.twoFactorMethod || method
    : method;

  if (effectiveMethod === "SMS") {
    if (!isSmsConfigured()) {
      throw new ApiError(
        400,
        "SMS 2FA is not available yet. Please use EMAIL.",
      );
    }
    if (!user.phone) {
      throw new ApiError(
        400,
        "Add a phone number to your profile before enabling SMS 2FA.",
      );
    }
    try {
      await sendOtp(user.id, user.phone, "TWO_FACTOR_SETUP", "SMS");
      return success(
        res,
        { method: "SMS", deliveryChannel: "SMS", alreadyEnabled },
        `Verification code sent to ${maskPhone(user.phone)}. Enter it to ${alreadyEnabled ? "verify your session" : "confirm 2FA setup"}.`,
      );
    } catch (smsErr) {
      // SMS failed — auto-fallback to email per PRD Sprint 2
      try {
        await sendOtp(user.id, user.email, "TWO_FACTOR_SETUP", "EMAIL");
        return success(
          res,
          {
            method: "SMS",
            deliveryChannel: "EMAIL",
            smsFallback: true,
            alreadyEnabled,
          },
          "SMS unavailable — verification code sent to your email instead. Enter it to confirm 2FA setup.",
        );
      } catch (emailErr) {
        throw new ApiError(
          503,
          "Unable to send verification code. Please try again later.",
        );
      }
    }
  }

  await sendOtp(user.id, user.email, "TWO_FACTOR_SETUP", "EMAIL");
  return success(
    res,
    { method: "EMAIL", deliveryChannel: "EMAIL", alreadyEnabled },
    `Verification code sent to your email. Enter it to ${alreadyEnabled ? "verify your session" : "confirm 2FA setup"}.`,
  );
}

// ─── 2FA VERIFY — confirm setup with the code just sent ────────────────────────
async function verify2FA(req, res) {
  const { otp, method } = req.body;
  if (!otp) throw new ApiError(400, "otp is required");

  await verifyOtp(req.user.id, otp, "TWO_FACTOR_SETUP");

  const updatedUser = await prisma.user.update({
    where: { id: req.user.id },
    data: {
      twoFactorEnabled: true,
      twoFactorMethod: method === "SMS" ? "SMS" : "EMAIL",
    },
  });

  // FIX: requireRecentMFA() (used to gate the Invoices page) checks for an
  // `mfaVerifiedAt` claim on the JWT itself, not just the DB flag. The old
  // code never reissued the user's token after enabling 2FA, so their
  // existing session token had no mfaVerifiedAt claim and the Invoices page
  // kept demanding 2FA even though it had just been enabled. Also returning
  // the updated user object so the frontend can sync redux state immediately
  // instead of relying on a stale value until next login/profile refetch.
  const tokens = await generateTokenPair(
    updatedUser,
    req.headers["user-agent"],
    req.ip,
    new Date(),
  );

  return success(
    res,
    { user: safeUser(updatedUser), ...tokens, twoFactorEnabled: true },
    "Two-factor authentication enabled successfully",
  );
}

// ─── 2FA DISABLE — requires current password ───────────────────────────────────
async function disable2FA(req, res) {
  const { password } = req.body;
  if (!password) throw new ApiError(400, "password is required to disable 2FA");

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) throw new ApiError(401, "Incorrect password");

  const updatedUser = await prisma.user.update({
    where: { id: req.user.id },
    data: { twoFactorEnabled: false },
  });

  return success(
    res,
    { user: safeUser(updatedUser), twoFactorEnabled: false },
    "Two-factor authentication disabled",
  );
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
    throw new ApiError(401, "Invalid Google token");
  }

  const {
    sub: googleId,
    email,
    given_name: firstName,
    family_name: lastName,
    picture: avatar,
  } = payload;

  let user = await prisma.user.findFirst({
    where: { OR: [{ googleId }, { email }] },
  });

  if (user) {
    // Link Google account if not already linked
    if (!user.googleId) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          googleId,
          isEmailVerified: true,
          ...(avatar && !user.avatar ? { avatar } : {}),
        },
      });
    }
  } else {
    // Create new user
    user = await prisma.user.create({
      data: {
        email,
        firstName: firstName || "User",
        lastName: lastName || "",
        googleId,
        avatar,
        authProvider: "GOOGLE",
        isEmailVerified: true,
      },
    });
  }

  if (!user.isActive) throw new ApiError(403, "Account suspended");

  // ─── 2FA Challenge ────────────────────────────────────────────────────────
  // If the user has enabled 2FA, Google authentication is not sufficient on
  // its own — we must still verify the second factor before issuing tokens,
  // so that requireRecentMFA (used on the Invoices page) is satisfied.
  // The same OTP type (TWO_FACTOR_LOGIN) is used as for email/password login,
  // so the existing POST /auth/login-2fa endpoint handles completion.
  if (user.twoFactorEnabled) {
    let deliveryChannel = "EMAIL";
    if (user.twoFactorMethod === "SMS" && user.phone) {
      try {
        await sendOtp(user.id, user.phone, "TWO_FACTOR_LOGIN", "SMS");
        deliveryChannel = "SMS";
      } catch {
        // SMS failed — fall back to email
        await sendOtp(user.id, user.email, "TWO_FACTOR_LOGIN", "EMAIL");
        deliveryChannel = "EMAIL";
      }
    } else {
      await sendOtp(user.id, user.email, "TWO_FACTOR_LOGIN", "EMAIL");
    }
    return success(
      res,
      {
        requires2FA: true,
        email: user.email,
        deliveryChannel,
      },
      `Verification code sent via ${deliveryChannel === "SMS" ? "SMS" : "email"}. Enter it to complete sign-in.`,
    );
  }

  const tokens = await generateTokenPair(
    user,
    req.headers["user-agent"],
    req.ip,
  );

  return success(
    res,
    { user: safeUser(user), ...tokens },
    "Google authentication successful",
  );
}

// ─── APPLE OAUTH ──────────────────────────────────────────────────────────────
async function appleAuth(req, res) {
  const { identityToken, user: appleUser } = req.body;

  // Verify Apple token (simplified — use apple-signin-auth in production)
  // The identity token is a JWT signed by Apple. Here we decode to get sub.
  let appleId, email, firstName, lastName;
  try {
    // Decode without verifying signature (Apple keys need fetching; use library in prod)
    const base64Payload = identityToken.split(".")[1];
    const decoded = JSON.parse(
      Buffer.from(base64Payload, "base64").toString("utf8"),
    );
    appleId = decoded.sub;
    email = decoded.email || appleUser?.email;
  } catch (err) {
    throw new ApiError(401, "Invalid Apple token");
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
        firstName: firstName || "User",
        lastName: lastName || "",
        appleId,
        authProvider: "APPLE",
        isEmailVerified: true,
      },
    });
  }

  if (!user.isActive) throw new ApiError(403, "Account suspended");

  const tokens = await generateTokenPair(
    user,
    req.headers["user-agent"],
    req.ip,
  );

  return success(
    res,
    { user: safeUser(user), ...tokens },
    "Apple authentication successful",
  );
}

// ─── REFRESH TOKEN ────────────────────────────────────────────────────────────
async function refreshToken(req, res) {
  const { refreshToken: token } = req.body;
  if (!token) throw new ApiError(400, "Refresh token required");

  let decoded;
  try {
    decoded = verifyRefreshToken(token);
  } catch (err) {
    throw new ApiError(401, "Invalid or expired refresh token");
  }

  const storedToken = await prisma.refreshToken.findUnique({
    where: { token },
  });
  if (
    !storedToken ||
    storedToken.revokedAt ||
    storedToken.expiresAt < new Date()
  ) {
    throw new ApiError(401, "Refresh token revoked or expired");
  }

  const user = await prisma.user.findUnique({ where: { id: decoded.sub } });
  if (!user || !user.isActive)
    throw new ApiError(401, "User not found or suspended");

  // Rotate: revoke old, issue new pair
  await revokeRefreshToken(token);
  const tokens = await generateTokenPair(
    user,
    req.headers["user-agent"],
    req.ip,
  );

  return success(res, tokens, "Token refreshed");
}

// ─── FORGOT PASSWORD ──────────────────────────────────────────────────────────
async function forgotPassword(req, res) {
  const { email } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });
  // Don't reveal if user exists
  if (user) {
    await sendOtp(user.id, email, "PASSWORD_RESET");
  }

  return success(
    res,
    {},
    "If that email is registered, you will receive a reset code.",
  );
}

// ─── RESET PASSWORD ───────────────────────────────────────────────────────────
async function resetPassword(req, res) {
  const { email, code, newPassword } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new ApiError(404, "User not found");

  await verifyOtp(user.id, code, "PASSWORD_RESET");

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

  // Revoke all sessions after password reset
  await revokeAllUserTokens(user.id);

  return success(res, {}, "Password reset successfully. Please log in again.");
}

// ─── CHANGE PASSWORD ──────────────────────────────────────────────────────────
async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  const userId = req.user.id;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user.passwordHash)
    throw new ApiError(400, "Cannot change password for social login accounts");

  const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!isValid) throw new ApiError(400, "Current password is incorrect");

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });

  return success(res, {}, "Password changed successfully");
}

// ─── LOGOUT ───────────────────────────────────────────────────────────────────
async function logout(req, res) {
  const { refreshToken: token } = req.body;
  if (token) await revokeRefreshToken(token);
  return success(res, {}, "Logged out successfully");
}

// ─── LOGOUT ALL DEVICES ───────────────────────────────────────────────────────
async function logoutAll(req, res) {
  await revokeAllUserTokens(req.user.id);
  return success(res, {}, "Logged out from all devices");
}

module.exports = {
  register,
  verifyEmail,
  resendOtp,
  login,
  verifyLogin2FA,
  setup2FA,
  verify2FA,
  disable2FA,
  googleAuth,
  appleAuth,
  refreshToken,
  forgotPassword,
  resetPassword,
  changePassword,
  logout,
  logoutAll,
};
