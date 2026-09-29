// Minimal in-memory stand-in for the Prisma client — just the calls the pricing
// facade makes. It honours the few `where` filters that matter to correctness
// (zone, active flags, names) so facade behaviour is exercised end-to-end.
const F = require("./fixtures");
const path = require("path");

function makeDb(over = {}) {
  const state = {
    cities: [{ id: "c1", name: "Lagos", region: "SW", state: "Lagos" }, { id: "c2", name: "Abuja", region: "NC", state: "FCT" }],
    zoneMatrix: [{ fromCityId: "c1", toCityId: "c2", zone: 3, isActive: true }],
    // cloned so a test that mutates state can never leak into another test
    offerings: structuredClone(F.OFFERINGS), slas: structuredClone(F.SLAS), bands: structuredClone(F.BANDS), surcharges: structuredClone(F.SURCHARGES),
    modeSettings: [], contracts: [], promos: [], adhocRules: [], users: [{ id: "u1", masterId: null }],
    quotes: [], adhocCharges: [], consentLogs: [], auditLogs: [],
    ...over,
  };
  const db = {
    city: { findFirst: async ({ where }) => state.cities.find((c) => c.name.toLowerCase() === where.name.equals.toLowerCase()) || null },
    zoneMatrix: { findFirst: async ({ where }) => state.zoneMatrix.find((z) => z.fromCityId === where.fromCityId && z.toCityId === where.toCityId && z.isActive === where.isActive) || null },
    kmMatrix: { findUnique: async () => ({ distanceKm: 760 }) },
    shipmentModeSetting: {
      findMany: async () => state.modeSettings,
      findUnique: async ({ where }) => state.modeSettings.find((m) => m.mode === where.mode) || null,
    },
    serviceOffering: {
      findMany: async () => state.offerings,
      findUnique: async ({ where }) => {
        if (where.id) return state.offerings.find((o) => o.id === where.id) || null;
        const k = where.shipmentMode_serviceType;
        return state.offerings.find((o) => o.shipmentMode === k.shipmentMode && o.serviceType === k.serviceType) || null;
      },
    },
    deliverySLA: {
      findMany: async ({ where }) => state.slas.filter((s) => Number(s.zone) === Number(where.zone)),
      findUnique: async ({ where }) => {
        const k = where.zone_shipmentMode_serviceType;
        return state.slas.find((s) => Number(s.zone) === Number(k.zone) && s.shipmentMode === k.shipmentMode && s.serviceType === k.serviceType) || null;
      },
    },
    priceBand: { findMany: async ({ where }) => state.bands.filter((b) => b.isActive === where.isActive && (b.zone === null || b.zone === where.OR[0].zone)) },
    surcharge: { findMany: async () => state.surcharges.filter((s) => s.isActive), findFirst: async ({ where }) => state.surcharges.find((s) => s.type === where.type && s.isActive) || null },
    adhocChargeRule: { findMany: async () => state.adhocRules },
    boxDimension: { findUnique: async () => null },
    user: { findUnique: async ({ where }) => state.users.find((u) => u.id === where.id) || null },
    contractRate: { findMany: async ({ where }) => state.contracts.filter((c) => where.userId.in.includes(c.userId) && c.isActive) },
    promoCode: { findFirst: async ({ where }) => state.promos.find((p) => p.code.toLowerCase() === where.code.equals.toLowerCase() && p.isActive) || null },
    promoRedemption: { findFirst: async () => null },
    consentLog: { create: async ({ data }) => { const row = { id: `cl${state.consentLogs.length + 1}`, ...data }; state.consentLogs.push(row); return row; } },
    priceAuditLog: { create: async ({ data }) => { const row = { id: `al${state.auditLogs.length + 1}`, ...data }; state.auditLogs.push(row); return row; } },
    quote: {
      create: async ({ data }) => { state.quotes.push(data); return data; },
      findUnique: async ({ where, include }) => {
        const q = state.quotes.find((x) => x.id === where.id);
        if (!q) return null;
        if (include?.adhocCharges) {
          const w = include.adhocCharges.where;
          const cs = state.adhocCharges.filter((c) => c.quoteId === q.id && (!w?.status?.in || w.status.in.includes(c.status)));
          return { ...q, adhocCharges: cs };
        }
        return { ...q };
      },
      update: async ({ where, data }) => {
        const q = state.quotes.find((x) => x.id === where.id);
        if (!q) throw new Error("quote not found");
        Object.assign(q, data);
        return { ...q };
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const q of state.quotes) {
          if (where.status?.in && !where.status.in.includes(q.status)) continue;
          if (where.expiresAt?.lt && !(new Date(q.expiresAt) < where.expiresAt.lt)) continue;
          Object.assign(q, data); count++;
        }
        return { count };
      },
      findMany: async ({ where } = {}) => state.quotes.filter((q) => {
        if (where?.status?.in && !where.status.in.includes(q.status)) return false;
        return true;
      }).map((q) => ({ ...q })),
    },
    shipmentAdhocCharge: {
      createMany: async ({ data }) => {
        const rows = (Array.isArray(data) ? data : [data]).map((d, i) => ({ id: `ac${state.adhocCharges.length + i + 1}`, ...d }));
        state.adhocCharges.push(...rows);
        return { count: rows.length };
      },
      findMany: async ({ where } = {}) => state.adhocCharges.filter((c) => (!where?.quoteId || c.quoteId === where.quoteId)),
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const c of state.adhocCharges) {
          if (where.quoteId && c.quoteId !== where.quoteId) continue;
          if (where.status?.in && !where.status.in.includes(c.status)) continue;
          Object.assign(c, data); count++;
        }
        return { count };
      },
      update: async ({ where, data }) => {
        const c = state.adhocCharges.find((x) => x.id === where.id);
        if (!c) throw new Error("adhoc charge not found");
        Object.assign(c, data);
        return { ...c };
      },
    },
    $transaction: async (ops) => (Array.isArray(ops) ? Promise.all(ops) : ops()),
  };
  return { db, state };
}

// Install the fake for ../config/db and ./settings.service, then (re)load the facade.
function loadFacade(over) {
  const { db, state } = makeDb(over);
  const src = path.resolve(__dirname, "../src");
  const dbPath = require.resolve(path.join(src, "config/db"));
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: db } };
  const setPath = require.resolve(path.join(src, "services/settings.service"));
  require.cache[setPath] = { id: setPath, filename: setPath, loaded: true, exports: { getNumberSetting: async (k) => ({ "insurance.rate_percent": 2.5, "insurance.min_premium_naira": 100 }[k] ?? 0) } };
  for (const m of ["services/pricing.service", "services/adhocCharge.service", "services/quoteSnapshot"]) {
    delete require.cache[require.resolve(path.join(src, m))];
  }
  return { facade: require(path.join(src, "services/pricing.service")), state };
}

// Loads quote.controller.js against the same fake DB/state, for controller-
// level integration tests. Returns the controller module and the state so
// assertions can inspect exactly what was persisted.
function loadQuoteController(over) {
  const { state } = loadFacade(over);
  const src = path.resolve(__dirname, "../src");
  for (const m of ["controllers/quote.controller"]) delete require.cache[require.resolve(path.join(src, m))];
  return { controller: require(path.join(src, "controllers/quote.controller")), state };
}

// Minimal req/res harness. res.json captures the payload; a thrown ApiError
// propagates like it would through express-async-errors + the error middleware.
function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

module.exports = { loadFacade, loadQuoteController, fakeRes };
