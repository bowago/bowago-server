// src/middleware/error.js
const { ApiError } = require("../utils/ApiError");

function notFound(req, res, next) {
  next(new ApiError(404, `Route ${req.originalUrl} not found`));
}

// Generic, user-safe message shown for any error we don't explicitly
// recognize below. Never leaks hostnames, file paths, stack traces, or
// raw Prisma/driver error text to the client.
const GENERIC_MESSAGE =
  "Something went wrong on our end. Please try again in a moment.";

/**
 * Maps known Prisma error classes/codes to a safe (statusCode, message)
 * pair. Returns null if the error isn't a recognized Prisma error, so the
 * caller can fall back to the generic message.
 */
function mapPrismaError(err) {
  const name = err?.constructor?.name || err?.name || "";

  // Database unreachable / connection issues (Neon cold start, network,
  // wrong credentials, etc.) — exactly the case in the screenshot.
  if (name === "PrismaClientInitializationError") {
    return {
      statusCode: 503,
      message:
        "We are unable to reach the database right now. Please try again shortly.",
    };
  }

  if (name === "PrismaClientRustPanicError") {
    return { statusCode: 500, message: GENERIC_MESSAGE };
  }

  // Malformed query (usually a developer bug, e.g. wrong field name) —
  // never useful to an end user.
  if (name === "PrismaClientValidationError") {
    return { statusCode: 500, message: GENERIC_MESSAGE };
  }

  if (name === "PrismaClientUnknownRequestError") {
    return { statusCode: 500, message: GENERIC_MESSAGE };
  }

  // Known request errors have a `code` like P2002 (unique constraint),
  // P2025 (record not found), P2003 (FK constraint), etc.
  if (name === "PrismaClientKnownRequestError") {
    switch (err.code) {
      case "P2002": {
        const fields = err.meta?.target;
        const fieldName = Array.isArray(fields) ? fields.join(", ") : fields;
        return {
          statusCode: 409,
          message: fieldName
            ? `A record with this ${fieldName} already exists.`
            : "A record with these details already exists.",
        };
      }
      case "P2025":
        return {
          statusCode: 404,
          message: "The requested record was not found.",
        };
      case "P2003":
        return {
          statusCode: 409,
          message:
            "This action conflicts with related data and cannot be completed.",
        };
      default:
        return { statusCode: 500, message: GENERIC_MESSAGE };
    }
  }

  return null;
}

function errorHandler(err, req, res, next) {
  // ApiError: deliberately thrown by our own code with a safe,
  // user-facing message — pass through as-is.
  if (err instanceof ApiError) {
    const statusCode = err.statusCode || 500;
    return res.status(statusCode).json({
      success: false,
      message: err.message || "Internal Server Error",
      ...(err.errors && { errors: err.errors }),
    });
  }

  console.error("Unhandled error:", err);

  const prismaMapping = mapPrismaError(err);
  const statusCode = prismaMapping?.statusCode ?? 500;
  const message = prismaMapping?.message ?? GENERIC_MESSAGE;

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === "development" && {
      devDetail: err.message,
      stack: err.stack,
    }),
  });
}

module.exports = { notFound, errorHandler };
