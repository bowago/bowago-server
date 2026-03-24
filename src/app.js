const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const swaggerUi = require("swagger-ui-express");
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
app.use(helmet());
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  process.env.CLIENT_URL,
].filter(Boolean);
app.use(
  cors({
    origin: (origin, callback) => {
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

// ─── Swagger UI ───────────────────────────────────────────────────────────────
app.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    customSiteTitle: "BowaGO API Docs",
    customCss: ".swagger-ui .topbar { background-color: #E85D04; }",
  }),
);

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

app.get("/", (req, res) => res.redirect("/api-docs"));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
