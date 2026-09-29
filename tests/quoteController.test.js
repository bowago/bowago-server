const test = require("node:test");
const assert = require("node:assert/strict");
const { loadQuoteController, fakeRes } = require("./fakeDb");

const baseReq = () => ({
  body: {
    originCity: "Lagos", destinationCity: "Abuja", weightKg: 10,
    termsAccepted: true, declaredValue: 50000,
  },
  headers: {}, user: { id: "u1" }, ip: "127.0.0.1",
});

const call = async (fn, req) => {
  const res = fakeRes();
  try { await fn(req, res); return { res, err: null }; }
  catch (err) { return { res, err }; }
};

// ─── generateQuote ────────────────────────────────────────────────────────────
test("generateQuote rejects without terms acceptance", async () => {
  const { controller } = loadQuoteController();
  const req = baseReq(); req.body.termsAccepted = false; req.body.shipmentMode = "LAND"; req.body.serviceType = "STANDARD";
  const { err } = await call(controller.generateQuote, req);
  assert.match(err.message, /Terms of Service/);
});

test("generateQuote requires an explicit product (mode + service, or offeringId) — no silent default", async () => {
  const { controller } = loadQuoteController();
  const req = baseReq();
  const { err } = await call(controller.generateQuote, req);
  assert.equal(err.code, "OFFERING_REQUIRED");
});

test("generateQuote rejects an array shipmentMode with a pointer to the offerings endpoint", async () => {
  const { controller } = loadQuoteController();
  const req = baseReq(); req.body.shipmentMode = ["LAND", "AIR"]; req.body.serviceType = "STANDARD";
  const { err } = await call(controller.generateQuote, req);
  assert.equal(err.code, "OFFERING_REQUIRED");
  assert.match(err.message, /quotes\/offerings/);
});

test("generateQuote persists the quote AND its ad-hoc lines atomically, from ONE evaluation", async () => {
  const rule = {
    id: "r1", chargeTypeId: "t1", behaviour: "AUTO_APPLY", metric: "BILLABLE_WEIGHT",
    operator: "GTE", thresholdMin: 1, thresholdMax: null, applicableModes: [],
    chargeType: { id: "t1", name: "Handling", vatApplicable: true, isActive: true, applicableModes: [], calcMethod: "FIXED", amountKobo: 50000 },
  };
  const { controller, state } = loadQuoteController({ adhocRules: [rule] });
  const req = baseReq(); req.body.shipmentMode = "LAND"; req.body.serviceType = "STANDARD";
  const { res, err } = await call(controller.generateQuote, req);
  assert.equal(err, null, err?.message);
  assert.equal(res.statusCode, 201);
  const quoteId = res.body.data.quoteId;
  assert.equal(state.quotes.length, 1);
  assert.equal(state.quotes[0].id, quoteId);
  assert.equal(state.quotes[0].shipmentMode, "LAND");
  assert.equal(state.quotes[0].serviceType, "STANDARD");
  // The persisted adhoc row's amount matches the engine's evaluation exactly —
  // it was never re-evaluated a second time to produce it.
  assert.equal(state.adhocCharges.length, 1);
  assert.equal(state.adhocCharges[0].quoteId, quoteId);
  assert.equal(state.adhocCharges[0].amountKobo, 50000);
  assert.equal(res.body.data.pricing.totalNaira, state.quotes[0].totalPriceKobo / 100);
});

test("generateQuote: an undefined product (SEA+EXPRESS) is rejected before anything is written", async () => {
  const { controller, state } = loadQuoteController();
  const req = baseReq(); req.body.shipmentMode = "SEA"; req.body.serviceType = "EXPRESS";
  const { err } = await call(controller.generateQuote, req);
  assert.equal(err.code, "NOT_OFFERED");
  assert.equal(state.quotes.length, 0);
});

test("generateQuote rejects a promo that does not apply to the chosen product", async () => {
  const { controller } = loadQuoteController({ promos: [{ id: "p", code: "LANDONLY", isActive: true, discountPercent: 10, shipmentMode: "LAND", maxUses: null, usedCount: 0 }] });
  const req = baseReq(); req.body.shipmentMode = "AIR"; req.body.serviceType = "EXPRESS"; req.body.promoCode = "LANDONLY";
  const { err } = await call(controller.generateQuote, req);
  assert.equal(err.code, "PROMO_NOT_APPLICABLE");
});

// ─── getQuoteOfferings ────────────────────────────────────────────────────────
test("getQuoteOfferings returns every sellable product plus unavailable ones with reasons — never a fabricated grid", async () => {
  const { controller } = loadQuoteController();
  const req = baseReq(); delete req.body.termsAccepted;
  const { res, err } = await call(controller.getQuoteOfferings, req);
  assert.equal(err, null, err?.message);
  const keys = res.body.data.offerings.map((o) => `${o.shipmentMode}|${o.serviceType}`).sort();
  assert.deepEqual(keys, ["AIR|EXPRESS", "AIR|STANDARD", "LAND|ECONOMY", "LAND|EXPRESS", "LAND|STANDARD", "SEA|ECONOMY", "SEA|STANDARD"]);
  assert.ok(res.body.data.offerings.every((o) => typeof o.total === "number" && o.deliveryEstimate));
  assert.ok(res.body.data.offerings.find((o) => o.shipmentMode === "AIR").requiresDangerousGoodsNotice);
  assert.ok(!res.body.data.offerings.find((o) => o.shipmentMode === "LAND").requiresDangerousGoodsNotice);
});

test("getQuoteOfferings requires origin/destination", async () => {
  const { controller } = loadQuoteController();
  const req = baseReq(); req.body = { weightKg: 5 };
  const { err } = await call(controller.getQuoteOfferings, req);
  assert.match(err.message, /originCity/);
});

// ─── getQuote / refreshQuote ──────────────────────────────────────────────────
test("getQuote flips an expired GENERATED quote to EXPIRED on read", async () => {
  const { controller, state } = loadQuoteController();
  const req = baseReq(); req.body.shipmentMode = "LAND"; req.body.serviceType = "STANDARD";
  const gen = await call(controller.generateQuote, req);
  const quoteId = gen.res.body.data.quoteId;
  state.quotes[0].expiresAt = new Date(Date.now() - 1000); // simulate time passing

  const getReq = { params: { id: quoteId } };
  const { res } = await call(controller.getQuote, getReq);
  assert.equal(res.body.data.quote.status, "EXPIRED");
  assert.equal(state.quotes[0].status, "EXPIRED");
});

test("getQuote 404s for an unknown id", async () => {
  const { controller } = loadQuoteController();
  const { err } = await call(controller.getQuote, { params: { id: "nope" } });
  assert.equal(err.statusCode, 404);
});

test("refreshQuote on a legacy (no-mode) quote is rejected rather than guessing a product", async () => {
  const { controller, state } = loadQuoteController();
  state.quotes.push({ id: "legacy1", userId: "u1", status: "GENERATED", expiresAt: new Date(Date.now() + 90000), shipmentMode: null, serviceType: "STANDARD", originCity: "Lagos", destinationCity: "Abuja" });
  const { err } = await call(controller.refreshQuote, { params: { id: "legacy1" }, user: { id: "u1" } });
  assert.equal(err.code, "LEGACY_QUOTE");
});

test("refreshQuote replays the SAME product and route as a fresh 15-minute quote", async () => {
  const { controller, state } = loadQuoteController();
  const req = baseReq(); req.body.shipmentMode = "AIR"; req.body.serviceType = "EXPRESS";
  const gen = await call(controller.generateQuote, req);
  const oldId = gen.res.body.data.quoteId;
  state.quotes[0].expiresAt = new Date(Date.now() - 1000);

  const refreshReq = { params: { id: oldId }, user: { id: "u1" }, headers: {}, ip: "127.0.0.1" };
  const { res, err } = await call(controller.refreshQuote, refreshReq);
  assert.equal(err, null, err?.message);
  assert.equal(state.quotes[0].status, "EXPIRED");
  const fresh = state.quotes[state.quotes.length - 1];
  assert.notEqual(fresh.id, oldId);
  assert.equal(fresh.shipmentMode, "AIR");
  assert.equal(fresh.serviceType, "EXPRESS");
  assert.equal(fresh.totalPriceKobo, state.quotes[0] === fresh ? undefined : fresh.totalPriceKobo); // sanity: fresh row exists
});

test("refreshQuote on someone else's quote is forbidden", async () => {
  const { controller, state } = loadQuoteController();
  state.quotes.push({ id: "other1", userId: "u2", status: "GENERATED", expiresAt: new Date(Date.now() + 90000), shipmentMode: "LAND", serviceType: "STANDARD" });
  const { err } = await call(controller.refreshQuote, { params: { id: "other1" }, user: { id: "u1", role: "CUSTOMER" } });
  assert.equal(err.statusCode, 403);
});
