// Vercel serverless entry point.
// Vercel expects a handler in the /api directory.
// We simply re-export the Express app from src/server.js — the app already
// handles the VERCEL env check and skips app.listen() when on Vercel.
module.exports = require("../src/server");
