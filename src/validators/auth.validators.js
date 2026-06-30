const Joi = require('joi');

const password = Joi.string().min(12).max(128)
  .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
  .message('Password must be at least 12 characters with uppercase, lowercase, and number');

const registerSchema = Joi.object({
  email: Joi.string().email().lowercase().required(),
  password: password.required(),
  firstName: Joi.string().min(1).max(50).trim().required(),
  lastName: Joi.string().min(1).max(50).trim().required(),
  phone: Joi.string().pattern(/^\+?[0-9]{10,15}$/).optional(),
});

const loginSchema = Joi.object({
  email: Joi.string().email().lowercase().required(),
  password: Joi.string().required(),
});

const verifyEmailSchema = Joi.object({
  email: Joi.string().email().lowercase().required(),
  code: Joi.string().length(6).pattern(/^\d+$/).required(),
});

const resendOtpSchema = Joi.object({
  email: Joi.string().email().lowercase().required(),
  type: Joi.string().valid('EMAIL_VERIFY', 'PASSWORD_RESET', 'LOGIN').default('EMAIL_VERIFY'),
});

const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().lowercase().required(),
});

const resetPasswordSchema = Joi.object({
  email: Joi.string().email().lowercase().required(),
  code: Joi.string().length(6).pattern(/^\d+$/).required(),
  newPassword: password.required(),
});

const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: password.required(),
});

const googleAuthSchema = Joi.object({
  idToken: Joi.string().required(),
});

const appleAuthSchema = Joi.object({
  identityToken: Joi.string().required(),
  user: Joi.object({
    email: Joi.string().email().optional(),
    name: Joi.object({
      firstName: Joi.string().optional(),
      lastName: Joi.string().optional(),
    }).optional(),
  }).optional(),
});

// ─── 2FA — these four were referenced by auth.routes.js but never defined,
// so validateBody(undefined) threw a raw TypeError on every 2FA request,
// which the global error handler masked as a generic "Something went
// wrong" message. This was the actual cause of the 2FA setup error.
const login2FASchema = Joi.object({
  email: Joi.string().email().lowercase().required(),
  otp: Joi.string().length(6).pattern(/^\d+$/).required(),
});

const setup2FASchema = Joi.object({
  method: Joi.string().valid('EMAIL', 'SMS').required(),
});

const verify2FASchema = Joi.object({
  otp: Joi.string().length(6).pattern(/^\d+$/).required(),
  method: Joi.string().valid('EMAIL', 'SMS').optional(),
});

const disable2FASchema = Joi.object({
  password: Joi.string().required(),
});

module.exports = {
  registerSchema,
  loginSchema,
  verifyEmailSchema,
  resendOtpSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
  googleAuthSchema,
  appleAuthSchema,
  login2FASchema,
  setup2FASchema,
  verify2FASchema,
  disable2FASchema,
};
