// src/middleware/validate.js
const Joi = require('joi');
const { ApiError } = require('../utils/ApiError');

function validateBody(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) {
      const errors = error.details.map(d => d.message);
      throw new ApiError(422, 'Validation failed', errors);
    }
    req.body = value;
    next();
  };
}

module.exports = { validateBody };
