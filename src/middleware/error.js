// src/middleware/error.js
const { ApiError } = require('../utils/ApiError');

function notFound(req, res, next) {
  next(new ApiError(404, `Route ${req.originalUrl} not found`));
}

function errorHandler(err, req, res, next) {
  // Log non-operational errors
  if (!(err instanceof ApiError)) {
    console.error('Unhandled error:', err);
  }

  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    ...(err.errors && { errors: err.errors }),
  });
}

module.exports = { notFound, errorHandler };
