const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const authController = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth');
const { validateBody } = require('../middleware/validate');
const {
  registerSchema,
  loginSchema,
  verifyEmailSchema,
  resendOtpSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
  googleAuthSchema,
  appleAuthSchema,
} = require('../validators/auth.validators');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many auth attempts. Try again in 15 minutes.' },
});

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: Register, login, social OAuth, OTP verification, token refresh, password management
 */

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register a new customer account
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, firstName, lastName]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: chidi@example.com
 *               password:
 *                 type: string
 *                 example: SecurePass1
 *                 description: Min 8 chars — must include uppercase, lowercase, and a number
 *               firstName:
 *                 type: string
 *                 example: Chidi
 *               lastName:
 *                 type: string
 *                 example: Okafor
 *               phone:
 *                 type: string
 *                 example: "+2348012345678"
 *     responses:
 *       201:
 *         description: Registration successful. A 6-digit OTP is sent to the email.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "Registration successful. Check your email for verification code." }
 *                 data:
 *                   type: object
 *                   properties:
 *                     userId: { type: string, format: uuid }
 *                     email: { type: string, example: chidi@example.com }
 *       409:
 *         description: Email or phone already registered
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       422:
 *         description: Validation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/register', authLimiter, validateBody(registerSchema), authController.register);

/**
 * @swagger
 * /auth/verify-email:
 *   post:
 *     summary: Verify email with 6-digit OTP
 *     tags: [Auth]
 *     security: []
 *     description: Verifies the OTP sent after registration. Returns a token pair on success. OTP expires in 10 minutes and allows max 5 attempts.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, code]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: chidi@example.com
 *               code:
 *                 type: string
 *                 example: "847291"
 *     responses:
 *       200:
 *         description: Email verified. Returns user and token pair.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *                     accessToken: { type: string }
 *                     refreshToken: { type: string }
 *       400:
 *         description: Invalid or expired OTP
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/verify-email', validateBody(verifyEmailSchema), authController.verifyEmail);

/**
 * @swagger
 * /auth/resend-otp:
 *   post:
 *     summary: Resend OTP code
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: chidi@example.com
 *               type:
 *                 type: string
 *                 enum: [EMAIL_VERIFY, PASSWORD_RESET, LOGIN]
 *                 default: EMAIL_VERIFY
 *     responses:
 *       200:
 *         description: OTP resent
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       404:
 *         description: User not found
 */
router.post('/resend-otp', authLimiter, validateBody(resendOtpSchema), authController.resendOtp);

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Login with email and password
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: chidi@example.com
 *               password:
 *                 type: string
 *                 example: SecurePass1
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *                     accessToken: { type: string }
 *                     refreshToken: { type: string }
 *       401:
 *         description: Invalid email or password
 *       403:
 *         description: Email not verified — a new OTP has been sent
 */
router.post('/login', authLimiter, validateBody(loginSchema), authController.login);

/**
 * @swagger
 * /auth/google:
 *   post:
 *     summary: Login or register with Google OAuth
 *     tags: [Auth]
 *     security: []
 *     description: Pass the Google ID token from the client-side Google Sign-In SDK. Creates an account automatically if the email is new.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [idToken]
 *             properties:
 *               idToken:
 *                 type: string
 *                 description: Google ID token obtained from Google Sign-In SDK
 *     responses:
 *       200:
 *         description: Google authentication successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *                     accessToken: { type: string }
 *                     refreshToken: { type: string }
 *       401:
 *         description: Invalid Google token
 */
router.post('/google', validateBody(googleAuthSchema), authController.googleAuth);

/**
 * @swagger
 * /auth/apple:
 *   post:
 *     summary: Login or register with Apple Sign-In
 *     tags: [Auth]
 *     security: []
 *     description: Pass the Apple identity token from the Apple Sign-In SDK. Apple only provides the user's name and email on the FIRST login — store them immediately.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [identityToken]
 *             properties:
 *               identityToken:
 *                 type: string
 *                 description: Identity token from Apple Sign-In SDK
 *               user:
 *                 type: object
 *                 description: Only present on first Apple login
 *                 properties:
 *                   email: { type: string, format: email }
 *                   name:
 *                     type: object
 *                     properties:
 *                       firstName: { type: string }
 *                       lastName: { type: string }
 *     responses:
 *       200:
 *         description: Apple authentication successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *                     accessToken: { type: string }
 *                     refreshToken: { type: string }
 *       401:
 *         description: Invalid Apple token
 */
router.post('/apple', validateBody(appleAuthSchema), authController.appleAuth);

/**
 * @swagger
 * /auth/refresh:
 *   post:
 *     summary: Refresh access token
 *     tags: [Auth]
 *     security: []
 *     description: Exchange a valid refresh token for a new token pair. The old refresh token is immediately revoked (rotation strategy).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       200:
 *         description: New token pair issued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   $ref: '#/components/schemas/TokenPair'
 *       401:
 *         description: Invalid, expired, or already revoked refresh token
 */
router.post('/refresh', authController.refreshToken);

/**
 * @swagger
 * /auth/forgot-password:
 *   post:
 *     summary: Request a password reset OTP
 *     tags: [Auth]
 *     security: []
 *     description: Sends a 6-digit reset OTP to the email if it exists. Always returns 200 to prevent email enumeration.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: chidi@example.com
 *     responses:
 *       200:
 *         description: If the email is registered, a reset code has been sent
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 */
router.post('/forgot-password', authLimiter, validateBody(forgotPasswordSchema), authController.forgotPassword);

/**
 * @swagger
 * /auth/reset-password:
 *   post:
 *     summary: Reset password using OTP
 *     tags: [Auth]
 *     security: []
 *     description: Verifies the OTP and sets a new password. All existing sessions are revoked after a successful reset.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, code, newPassword]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: chidi@example.com
 *               code:
 *                 type: string
 *                 example: "391847"
 *               newPassword:
 *                 type: string
 *                 example: NewSecurePass1
 *     responses:
 *       200:
 *         description: Password reset successfully
 *       400:
 *         description: Invalid or expired OTP
 *       404:
 *         description: User not found
 */
router.post('/reset-password', validateBody(resetPasswordSchema), authController.resetPassword);

/**
 * @swagger
 * /auth/change-password:
 *   post:
 *     summary: Change password while logged in
 *     tags: [Auth]
 *     description: Requires the current password. Not available for Google/Apple-only accounts.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, newPassword]
 *             properties:
 *               currentPassword:
 *                 type: string
 *                 example: OldPass1
 *               newPassword:
 *                 type: string
 *                 example: NewSecurePass1
 *     responses:
 *       200:
 *         description: Password changed successfully
 *       400:
 *         description: Current password is incorrect
 *       401:
 *         description: Unauthorized
 */
router.post('/change-password', authenticate, validateBody(changePasswordSchema), authController.changePassword);

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: Logout and revoke refresh token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       200:
 *         description: Logged out successfully
 *       401:
 *         description: Unauthorized
 */
router.post('/logout', authenticate, authController.logout);

/**
 * @swagger
 * /auth/logout-all:
 *   post:
 *     summary: Logout from all devices
 *     tags: [Auth]
 *     description: Revokes all active refresh tokens for the current user across every device.
 *     responses:
 *       200:
 *         description: Logged out from all devices
 *       401:
 *         description: Unauthorized
 */
router.post('/logout-all', authenticate, authController.logoutAll);

module.exports = router;
