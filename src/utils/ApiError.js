class ApiError extends Error {
  // `code` is an optional machine-readable reason (e.g. "NO_RATE") so clients
  // can react without parsing the message.
  constructor(statusCode, message, errors = null, code = null) {
    super(message);
    this.statusCode = statusCode;
    this.errors = errors;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = { ApiError };
