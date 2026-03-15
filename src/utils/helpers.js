// Standardized API response
function success(res, data = {}, message = 'Success', statusCode = 200) {
  return res.status(statusCode).json({ success: true, message, data });
}

function created(res, data = {}, message = 'Created successfully') {
  return success(res, data, message, 201);
}

function paginate(res, data, meta, message = 'Success') {
  return res.status(200).json({ success: true, message, data, meta });
}

// Generate tracking number: BG-YYYYMMDD-XXXXX
function generateTrackingNumber() {
  const date = new Date();
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `BG-${ymd}-${rand}`;
}

// Generate numeric OTP
function generateOtp(length = 6) {
  const digits = '0123456789';
  let otp = '';
  for (let i = 0; i < length; i++) {
    otp += digits[Math.floor(Math.random() * 10)];
  }
  return otp;
}

// Parse pagination params from query
function getPagination(query) {
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

// Build meta object for pagination
function buildMeta(total, page, limit) {
  return {
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    hasNext: page * limit < total,
    hasPrev: page > 1,
  };
}

module.exports = {
  success,
  created,
  paginate,
  generateTrackingNumber,
  generateOtp,
  getPagination,
  buildMeta,
};
