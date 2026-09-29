const test = require("node:test");
const assert = require("node:assert/strict");
const { loadFacade } = require("./fakeDb");
const F = require("./fixtures");

const req = { fromCity: "Lagos", toCity: "Abuja", weightKg: 10 };
const code = async (p) => { try { await p; return null; } catch (e) { return e.code || e.message; } };

test("calculateShippingCost requires BOTH mode and service (no silent defaults)", async () => {
  const { facade } = loadFacade();
  assert.equal(await code(facade.calculateShippingCost({ ...req })), "OFFERING_REQUIRED");
  assert.equal(await code(facade.calculateShippingCost({ ...req, shipmentMode: "LAND" })), "OFFERING_REQUIRED");
  assert.equal(await code(facade.calculateShippingCost({ ...req, serviceType: "STANDARD" })), "OFFERING_REQUIRED");
});

test("invalid mode / service values are rejected with a code", async () => {
  const { facade } = loadFacade();
  assert.equal(await code(facade.calculateShippingCost({ ...req, shipmentMode: "RAIL", serviceType: "STANDARD" })), "INVALID_MODE");
  assert.equal(await code(facade.calculateShippingCost({ ...req, shipmentMode: "LAND", serviceType: "TURBO" })), "INVALID_SERVICE");
});

test("undefined combinations (SEA+EXPRESS, AIR+ECONOMY) are NOT_OFFERED", async () => {
  const { facade } = loadFacade();
  assert.equal(await code(facade.calculateShippingCost({ ...req, shipmentMode: "SEA", serviceType: "EXPRESS" })), "NOT_OFFERED");
  assert.equal(await code(facade.calculateShippingCost({ ...req, shipmentMode: "AIR", serviceType: "ECONOMY" })), "NOT_OFFERED");
});

test("a defined product prices with explicit components and a hidden adhocEvaluation", async () => {
  const { facade } = loadFacade();
  const r = await facade.calculateShippingCost({ ...req, shipmentMode: "LAND", serviceType: "STANDARD" });
  assert.equal(r.finalBasePrice, 4000);
  assert.equal(r.total, 5053);
  assert.equal(r.offeringId, "o-LAND-STANDARD");
  assert.equal(r.deliveryEstimate.maxDays, 5);
  assert.ok(r.adhocEvaluation, "raw evaluation available for persistence");
  assert.equal(JSON.parse(JSON.stringify(r)).adhocEvaluation, undefined, "but never serialised to clients");
  assert.equal(r.weightKg, r.billableWeightKg); // deprecated alias
});

test("unpriced / SLA-less products fail with specific reason codes (never a fallback)", async () => {
  const noRate = loadFacade({ bands: F.BANDS.filter((b) => !(b.shipmentMode === "LAND" && b.serviceType === "EXPRESS")) }).facade;
  assert.equal(await code(noRate.calculateShippingCost({ ...req, shipmentMode: "LAND", serviceType: "EXPRESS" })), "NO_RATE");
  const noSla = loadFacade({ slas: F.SLAS.filter((s) => !(s.shipmentMode === "AIR" && s.serviceType === "EXPRESS")) }).facade;
  assert.equal(await code(noSla.calculateShippingCost({ ...req, shipmentMode: "AIR", serviceType: "EXPRESS" })), "NO_SLA");
});

test("inactive mode blocks pricing", async () => {
  const { facade } = loadFacade({ modeSettings: [{ mode: "SEA", isActive: false, volumetricDivisor: 5000 }] });
  assert.equal(await code(facade.calculateShippingCost({ ...req, shipmentMode: "SEA", serviceType: "STANDARD" })), "MODE_INACTIVE");
});

test("no offerings configured at all => explicit 503-style code, not a guess", async () => {
  const { facade } = loadFacade({ offerings: [] });
  assert.equal(await code(facade.calculateShippingCost({ ...req, shipmentMode: "LAND", serviceType: "STANDARD" })), "NO_OFFERINGS_CONFIGURED");
});

test("getOfferings lists only real, sellable products and explains the rest", async () => {
  const { facade } = loadFacade({
    slas: F.SLAS.filter((s) => !(s.shipmentMode === "SEA" && s.serviceType === "ECONOMY")),
    offerings: [...F.OFFERINGS.filter((o) => !(o.shipmentMode === "AIR" && o.serviceType === "STANDARD")), { ...F.offering("AIR", "STANDARD"), isActive: false }],
  });
  const out = await facade.getOfferings(req);
  const keys = out.offerings.map((o) => `${o.shipmentMode}|${o.serviceType}`).sort();
  assert.deepEqual(keys, ["AIR|EXPRESS", "LAND|ECONOMY", "LAND|EXPRESS", "LAND|STANDARD", "SEA|STANDARD"]);
  const reasons = Object.fromEntries(out.unavailable.map((u) => [`${u.shipmentMode}|${u.serviceType}`, u.reasonCode]));
  assert.deepEqual(reasons, { "AIR|STANDARD": "OFFERING_INACTIVE", "SEA|ECONOMY": "NO_SLA" });
  assert.ok(out.offerings.every((o) => o.deliveryEstimate && o.total > 0));
});

test("getOfferings honours mode/service filters and exposes route info", async () => {
  const { facade } = loadFacade();
  const out = await facade.getOfferings({ ...req, shipmentMode: "LAND" });
  assert.deepEqual(out.offerings.map((o) => o.shipmentMode), ["LAND", "LAND", "LAND"]);
  assert.equal(out.route.zone, 3);
  assert.equal(out.route.fromCity.name, "Lagos");
});

test("contract discounts flow through the facade and are scoped by mode", async () => {
  const contracts = [{ id: "c", userId: "u1", isActive: true, shipmentMode: "LAND", serviceType: null, discountPercent: 10 }];
  const { facade } = loadFacade({ contracts });
  const land = await facade.calculateShippingCost({ ...req, userId: "u1", shipmentMode: "LAND", serviceType: "STANDARD" });
  const air = await facade.calculateShippingCost({ ...req, userId: "u1", shipmentMode: "AIR", serviceType: "EXPRESS" });
  assert.equal(land.pricingMode, "CONTRACT");
  assert.equal(air.pricingMode, "STANDARD");
});

test("promo that does not apply to the chosen product is rejected explicitly", async () => {
  const promos = [{ id: "p", code: "LANDONLY", isActive: true, discountPercent: 10, shipmentMode: "LAND", maxUses: null, usedCount: 0 }];
  const { facade } = loadFacade({ promos });
  assert.equal((await facade.calculateShippingCost({ ...req, promoCode: "landonly", shipmentMode: "LAND", serviceType: "STANDARD" })).pricingMode, "PROMO");
  assert.equal(await code(facade.calculateShippingCost({ ...req, promoCode: "LANDONLY", shipmentMode: "AIR", serviceType: "EXPRESS" })), "PROMO_NOT_APPLICABLE");
  // …while the comparison endpoint just reports it per offering instead of throwing
  const out = await facade.getOfferings({ ...req, promoCode: "LANDONLY" });
  const air = out.offerings.find((o) => o.shipmentMode === "AIR" && o.serviceType === "EXPRESS");
  assert.equal(air.promoStatus.status, "NOT_APPLICABLE");
});

test("assertOfferingSellable: booking a locked quote only re-checks availability", async () => {
  const off = F.OFFERINGS.map((o) => (o.shipmentMode === "SEA" && o.serviceType === "STANDARD" ? { ...o, isActive: false } : o));
  const { facade } = loadFacade({ offerings: off });
  assert.equal(await code(facade.assertOfferingSellable({ shipmentMode: "SEA", serviceType: "STANDARD" })), "OFFERING_INACTIVE");
  assert.equal(await code(facade.assertOfferingSellable({ shipmentMode: "LAND", serviceType: "STANDARD" })), null);
  assert.equal(await code(facade.assertOfferingSellable({ shipmentMode: "LAND", serviceType: "STANDARD", offeringId: "nope" })), null); // legacy quote, unknown id => not blocked
});

test("delivery estimates come from the SLA, business days only", () => {
  const { facade } = loadFacade();
  const fri = new Date("2026-10-02T09:00:00Z"); // a Friday
  assert.equal(facade.estimateDeliveryDate(fri, 1).getDay(), 1); // -> Monday
  assert.equal(facade.estimateDeliveryDate(fri, null), null);
});
