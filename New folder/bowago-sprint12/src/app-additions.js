// ─── ADD THESE 3 IMPORTS to the top of src/app.js ────────────────────────────
const contractRateRoutes = require('./routes/contractRate.routes');
const promoCodeRoutes    = require('./routes/promoCode.routes');
const policyRoutes       = require('./routes/policy.routes');

// ─── ADD THESE 3 LINES to the routes section of src/app.js ───────────────────
// Place them after the existing surchargeRoutes line:
//   app.use('/api/v1/surcharges', surchargeRoutes);

app.use('/api/v1/contract-rates', contractRateRoutes);
app.use('/api/v1/promo-codes',    promoCodeRoutes);
app.use('/api/v1/policies',       policyRoutes);

// NOTE: policyRoutes also handles /packaging-guides via the same router
// so GET /api/v1/policies/packaging-guides will work automatically

// ─── ALSO: Replace src/routes/pricing.routes.js with the new version ─────────
// The new pricing.routes.js adds:
//   - POST /pricing/quote now reads req.user?.id (optional auth) for contract rate lookup
//   - POST /pricing/price-bands/rollback/:auditLogId  (Super Admin, Sprint 8)
//   - Audit logging on createPriceBand and updatePriceBand
