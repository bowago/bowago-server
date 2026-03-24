const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const swaggerSpec = require("./config/swagger");
const { errorHandler, notFound } = require("./middleware/error");

// ─── Route imports ────────────────────────────────────────────────────────────
const authRoutes = require("./routes/auth.routes");
const userRoutes = require("./routes/user.routes");
const shipmentRoutes = require("./routes/shipment.routes");
const pricingRoutes = require("./routes/pricing.routes");
const adminRoutes = require("./routes/admin.routes");
const notificationRoutes = require("./routes/notification.routes");
const uploadRoutes = require("./routes/upload.routes");
const paymentRoutes = require("./routes/payment.routes");
const surchargeRoutes = require("./routes/surcharge.routes");
const addressChangeRoutes = require("./routes/addressChange.routes");
const priceAdjRoutes = require("./routes/priceAdjustment.routes");
const claimsRoutes = require("./routes/claims.routes");
const supportRoutes = require("./routes/support.routes");
const faqRoutes = require("./routes/faq.routes");
const delayAlertRoutes = require("./routes/delayAlert.routes");
const invoiceRoutes = require("./routes/invoice.routes");
const contractRateRoutes = require("./routes/contractRate.routes");
const promoRateRoutes = require("./routes/promoRate.routes");

const app = express();

// ─── Security & Utilities ─────────────────────────────────────────────────────
// Helmet is applied globally with a strict CSP, but /api-docs gets its own
// relaxed CSP so it can load Swagger UI assets from the unpkg CDN.
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://unpkg.com"],
      scriptSrcElem: ["'self'", "https://unpkg.com", "'unsafe-inline'"],
      styleSrc: ["'self'", "https://unpkg.com", "'unsafe-inline'"],
      styleSrcElem: ["'self'", "https://unpkg.com", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https://unpkg.com"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "https://unpkg.com"],
      workerSrc: ["blob:"],
    },
  },
});
app.use(helmetMiddleware);

// CLIENT_URL may be a comma-separated list of origins, e.g.:
//   CLIENT_URL=https://bowagate-frontend.vercel.app,https://www.bowago.com
const rawOrigins = (process.env.CLIENT_URL || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  ...rawOrigins,
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow server-to-server / curl requests (no origin header)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS blocked: ${origin}`));
      }
    },
    credentials: true,
  }),
);

app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// ─── Raw body for Paystack webhook — MUST come before express.json() ─────────
app.use(
  "/api/v1/payments/webhook",
  express.raw({ type: "application/json" }),
  (req, res, next) => {
    if (Buffer.isBuffer(req.body)) {
      req.rawBody = req.body;
      req.body = JSON.parse(req.body.toString());
    }
    next();
  },
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ─── Swagger UI (CDN-based — works on Vercel, no static asset MIME issues) ────
app.get("/api-docs/swagger.json", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.send(swaggerSpec);
});

app.get("/api-docs", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>BowaGO API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css" />
  <style>
    body { margin: 0; }
    .swagger-ui .topbar { background-color: #E85D04 !important; }
    .swagger-ui .topbar .download-url-wrapper { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function () {
      SwaggerUIBundle({
        url: "/api-docs/swagger.json",
        dom_id: "#swagger-ui",
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: "StandaloneLayout",
        deepLinking: true,
        persistAuthorization: true,
      });
    };
  </script>
</body>
</html>`);
});

// ─── Rate Limiting ────────────────────────────────────────────────────────────
app.use(
  "/api",
  rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
    message: {
      success: false,
      message: "Too many requests, please try again later.",
    },
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/health", async (req, res) => {
  const { prisma } = require("./config/db");
  let dbStatus = "ok";
  let dbLatencyMs = null;
  try {
    const t = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Date.now() - t;
  } catch {
    dbStatus = "error";
  }

  res.status(dbStatus === "ok" ? 200 : 503).json({
    status: dbStatus === "ok" ? "healthy" : "degraded",
    service: "BowaGO API",
    version: "1.0.0",
    environment: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString(),
    uptime: `${Math.floor(process.uptime())}s`,
    database: { status: dbStatus, latencyMs: dbLatencyMs },
    cors: { allowedOrigins: rawOrigins.length > 0 ? rawOrigins : ["*"] },
    checks: {
      paystack: !!process.env.PAYSTACK_SECRET_KEY ? "configured" : "missing",
      cloudinary: !!process.env.CLOUDINARY_CLOUD_NAME
        ? "configured"
        : "missing",
      email: !!process.env.SMTP_USER ? "configured" : "missing",
      jwt: !!process.env.JWT_SECRET ? "configured" : "missing",
      clientUrl: rawOrigins.length > 0 ? rawOrigins.join(", ") : "open (*)",
    },
  });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/shipments", shipmentRoutes);
app.use("/api/v1/pricing", pricingRoutes);
app.use("/api/v1/admin", adminRoutes);
app.use("/api/v1/notifications", notificationRoutes);
app.use("/api/v1/uploads", uploadRoutes);
app.use("/api/v1/payments", paymentRoutes);
app.use("/api/v1/surcharges", surchargeRoutes);
app.use("/api/v1/address-changes", addressChangeRoutes);
app.use("/api/v1/price-adjustments", priceAdjRoutes);
app.use("/api/v1/claims", claimsRoutes);
app.use("/api/v1/support", supportRoutes);
app.use("/api/v1/faq", faqRoutes);
app.use("/api/v1/delay-alerts", delayAlertRoutes);
app.use("/api/v1/invoices", invoiceRoutes);
app.use("/api/v1/contract-rates", contractRateRoutes);
app.use("/api/v1/promo-rates", promoRateRoutes);

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    service: "BowaGO API",
    version: "1.0.0",
    status: "running",
    environment: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString(),
    docs: "/api-docs",
    health: "/health",
  });
});

app.use(notFound);
app.use(errorHandler);

module.exports = app;
