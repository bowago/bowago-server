const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../src/services/pricing/core");
const F = require("./fixtures");

const base = { fromCity: "Lagos", toCity: "Abuja", weightKg: 10 };
const evalOne = (mode, service, req = {}, ctxOver = {}) =>
  core.evaluateOffering(F.ctx(ctxOver), F.OFFERINGS.find((o) => o.shipmentMode === mode && o.serviceType === service), { ...base, ...req });

// ─── Rating matrix ───────────────────────────────────────────────────────────
test("rating matrix: each operated product prices independently", () => {
  const prices = {};
  for (const o of F.OFFERINGS) {
    const r = core.evaluateOffering(F.ctx(), o, base);
    assert.equal(r.available, true, `${o.shipmentMode}+${o.serviceType} should be available`);
    prices[`${o.shipmentMode}|${o.serviceType}`] = r.finalBasePrice;
  }
  assert.deepEqual(prices, {
    "AIR|EXPRESS": 15000, "AIR|STANDARD": 9000, "LAND|EXPRESS": 6000, "LAND|STANDARD": 4000,
    "LAND|ECONOMY": 2000, "SEA|STANDARD": 1200, "SEA|ECONOMY": 800,
  });
});

test("undefined combinations do not exist (nothing fabricates SEA+EXPRESS / AIR+ECONOMY)", () => {
  const keys = F.OFFERINGS.map((o) => `${o.shipmentMode}|${o.serviceType}`);
  assert.ok(!keys.includes("SEA|EXPRESS"));
  assert.ok(!keys.includes("AIR|ECONOMY"));
});

test("mode, service, weight and zone each change the rate", () => {
  assert.notEqual(evalOne("AIR", "STANDARD").finalBasePrice, evalOne("LAND", "STANDARD").finalBasePrice); // mode
  assert.notEqual(evalOne("LAND", "EXPRESS").finalBasePrice, evalOne("LAND", "ECONOMY").finalBasePrice); // service
  assert.notEqual(evalOne("LAND", "STANDARD", { weightKg: 10 }).finalBasePrice / 10, evalOne("LAND", "STANDARD", { weightKg: 20 }).finalBasePrice / 20); // weight band
  const z2 = core.evaluateOffering(F.ctx({ zone: 2, bands: [F.band({ zone: 2, shipmentMode: "LAND", serviceType: "STANDARD", pricePerKg: 250 })], slas: [F.sla("LAND", "STANDARD", 1, 2, 2)] }),
    F.OFFERINGS.find((o) => o.shipmentMode === "LAND" && o.serviceType === "STANDARD"), base);
  assert.equal(z2.finalBasePrice, 2500); // zone
});

test("rate lookup never crosses mode or service (no silent fallback)", () => {
  const onlyLandStandard = F.BANDS.filter((b) => b.shipmentMode === "LAND" && b.serviceType === "STANDARD");
  const r = evalOne("LAND", "EXPRESS", {}, { bands: onlyLandStandard });
  assert.equal(r.available, false);
  assert.equal(r.reasonCode, "NO_RATE");
  const air = evalOne("AIR", "STANDARD", {}, { bands: onlyLandStandard });
  assert.equal(air.reasonCode, "NO_RATE");
});

// ─── Fixed-price-by-zone ─────────────────────────────────────────────────────
test("fixed price per kg by zone actually participates in standard pricing", () => {
  const r = evalOne("AIR", "STANDARD");
  assert.equal(r.available, true);
  assert.equal(r.rate.source, "BAND_FIXED_ZONE");
  assert.equal(r.finalBasePrice, 9000);
});

test("fixed-price band does not price a zone missing from its map", () => {
  const r = core.evaluateOffering(F.ctx({ zone: 2, slas: [F.sla("AIR", "STANDARD", 1, 2, 2)] }),
    F.OFFERINGS.find((o) => o.shipmentMode === "AIR" && o.serviceType === "STANDARD"), base);
  assert.equal(r.reasonCode, "NO_RATE");
});

test("weight boundaries: inclusive edges and band switch", () => {
  assert.equal(evalOne("LAND", "STANDARD", { weightKg: 10 }).rate.pricePerKg, 400);
  assert.equal(evalOne("LAND", "STANDARD", { weightKg: 11 }).rate.pricePerKg, 300);
  assert.equal(evalOne("LAND", "STANDARD", { weightKg: 50 }).rate.pricePerKg, 300);
  assert.equal(evalOne("LAND", "STANDARD", { weightKg: 50.5 }).reasonCode, "NO_RATE");
});

test("gap between integer bands (10 -> 11) resolves to the upper band, not 'no rate'", () => {
  const r = evalOne("LAND", "STANDARD", { weightKg: 10.5 });
  assert.equal(r.available, true);
  assert.equal(r.rate.gapResolved, true);
  assert.equal(r.rate.pricePerKg, 300);
});

test("unpriced placeholder bands (0 / 0) are not a price", () => {
  const ph = F.band({ shipmentMode: "LAND", serviceType: "STANDARD", pricePerKg: 0, basePrice: 0 });
  const r = evalOne("LAND", "STANDARD", {}, { bands: [ph] });
  assert.equal(r.reasonCode, "NO_RATE");
});

test("inactive and out-of-validity bands are ignored", () => {
  const inactive = F.band({ shipmentMode: "LAND", serviceType: "STANDARD", pricePerKg: 1, isActive: false });
  const expired = F.band({ shipmentMode: "LAND", serviceType: "STANDARD", pricePerKg: 2, validUntil: new Date("2026-01-01") });
  const future = F.band({ shipmentMode: "LAND", serviceType: "STANDARD", pricePerKg: 3, validFrom: new Date("2027-01-01") });
  assert.equal(evalOne("LAND", "STANDARD", {}, { bands: [inactive, expired, future] }).reasonCode, "NO_RATE");
});

test("float noise does not round a price up by a naira", () => {
  assert.equal(core.ceilMoney(0.1 * 3 * 1000), 300); // 300.00000000000006 must NOT become 301
  assert.equal(core.ceilMoney(100.1 * 3), 301); // 300.3 genuinely exceeds 300
  const b = F.band({ shipmentMode: "LAND", serviceType: "STANDARD", pricePerKg: 100.1, minKg: 0, maxKg: 100 });
  assert.equal(evalOne("LAND", "STANDARD", { weightKg: 3 }, { bands: [b] }).finalBasePrice, 301);
  const c = F.band({ shipmentMode: "LAND", serviceType: "STANDARD", pricePerKg: 0.1, minKg: 0, maxKg: 10000 });
  assert.equal(evalOne("LAND", "STANDARD", { weightKg: 3000 }, { bands: [c] }).finalBasePrice, 300);
});

// ─── Billable weight ─────────────────────────────────────────────────────────
test("billable weight is max(actual, volumetric), rounded up to 0.5", () => {
  const m = core.resolveMeasurements({ weightKg: 5, customLength: 60, customWidth: 50, customHeight: 40 }, 5000);
  assert.equal(m.volumetricWeightKg, 24);
  assert.equal(m.billableWeightKg, 24);
  assert.equal(core.resolveMeasurements({ weightKg: 5.2 }, 5000).billableWeightKg, 5.5);
  assert.equal(core.resolveMeasurements({ weightKg: 30, customLength: 10, customWidth: 10, customHeight: 10 }, 5000).billableWeightKg, 30);
});

test("volumetric divisor is per mode", () => {
  const req = { ...base, weightKg: 5, customLength: 60, customWidth: 50, customHeight: 40 };
  assert.equal(evalOne("LAND", "STANDARD", req).billableWeightKg, 24); // /5000
  assert.equal(evalOne("AIR", "STANDARD", req).billableWeightKg, 20); // /6000
});

test("box selection: per-box max(limit, volumetric) x quantity; cartons = box count", () => {
  const box = { weightKgLimit: 12, lengthCm: 50, widthCm: 40, heightCm: 40 }; // vol = 16
  const m = core.resolveMeasurements({ box, cartons: 3 }, 5000);
  assert.equal(m.actualWeightKg, 36);
  assert.equal(m.volumetricWeightKg, 48);
  assert.equal(m.billableWeightKg, 48);
});

test("tons and cartons fall back correctly; nothing at all is rejected", () => {
  assert.equal(core.resolveMeasurements({ tons: 0.5 }).billableWeightKg, 500);
  assert.equal(core.resolveMeasurements({ cartons: 4 }).billableWeightKg, 60);
  assert.throws(() => core.resolveMeasurements({}), /Provide weight/);
});

// ─── SLA ─────────────────────────────────────────────────────────────────────
test("SLA depends on mode: same service, different mode, different promise", () => {
  assert.deepEqual([evalOne("AIR", "EXPRESS").deliveryEstimate.minDays, evalOne("AIR", "EXPRESS").deliveryEstimate.maxDays], [1, 2]);
  assert.deepEqual([evalOne("LAND", "EXPRESS").deliveryEstimate.minDays, evalOne("LAND", "EXPRESS").deliveryEstimate.maxDays], [2, 4]);
});

test("SLA depends on service within the same mode", () => {
  const a = evalOne("AIR", "EXPRESS").deliveryEstimate;
  const b = evalOne("AIR", "STANDARD").deliveryEstimate;
  assert.notDeepEqual([a.minDays, a.maxDays], [b.minDays, b.maxDays]);
});

test("SLA is resolved per zone", () => {
  const z2 = core.evaluateOffering(F.ctx({ zone: 2, bands: [F.band({ zone: 2, shipmentMode: "LAND", serviceType: "STANDARD", pricePerKg: 250 })], slas: [F.sla("LAND", "STANDARD", 1, 2, 2), ...F.SLAS] }),
    F.OFFERINGS.find((o) => o.shipmentMode === "LAND" && o.serviceType === "STANDARD"), base);
  assert.equal(z2.deliveryEstimate.maxDays, 2);
  assert.equal(evalOne("LAND", "STANDARD").deliveryEstimate.maxDays, 5);
});

test("no SLA => not sellable, unless the offering explicitly allows it", () => {
  const noSla = { slas: F.SLAS.filter((s) => !(s.shipmentMode === "SEA" && s.serviceType === "ECONOMY")) };
  assert.equal(evalOne("SEA", "ECONOMY", {}, noSla).reasonCode, "NO_SLA");
  const off = { ...F.OFFERINGS.find((o) => o.shipmentMode === "SEA" && o.serviceType === "ECONOMY"), allowsNoSla: true };
  const r = core.evaluateOffering(F.ctx(noSla), off, base);
  assert.equal(r.available, true);
  assert.equal(r.deliveryEstimate, null);
});

// ─── Eligibility ─────────────────────────────────────────────────────────────
test("inactive mode / offering are not selectable", () => {
  assert.equal(evalOne("SEA", "STANDARD", {}, { modeSettings: { SEA: { isActive: false } } }).reasonCode, "MODE_INACTIVE");
  const off = { ...F.OFFERINGS[0], isActive: false };
  assert.equal(core.evaluateOffering(F.ctx(), off, base).reasonCode, "OFFERING_INACTIVE");
});

test("weight and dimension limits are enforced server-side (offering and mode level)", () => {
  const capped = { ...F.OFFERINGS.find((o) => o.shipmentMode === "AIR" && o.serviceType === "EXPRESS"), maxWeightKg: 8 };
  assert.equal(core.evaluateOffering(F.ctx(), capped, base).reasonCode, "WEIGHT_ABOVE_MAX");
  const min = { ...capped, maxWeightKg: null, minWeightKg: 20 };
  assert.equal(core.evaluateOffering(F.ctx(), min, base).reasonCode, "WEIGHT_BELOW_MIN");
  const modeCap = evalOne("SEA", "STANDARD", {}, { modeSettings: { SEA: { isActive: true, volumetricDivisor: 5000, maxWeightKg: 5 } } });
  assert.equal(modeCap.reasonCode, "WEIGHT_ABOVE_MAX");
  const side = evalOne("LAND", "STANDARD", { weightKg: 5, customLength: 200, customWidth: 10, customHeight: 10 }, { modeSettings: { LAND: { isActive: true, volumetricDivisor: 5000, maxLongestSideCm: 150 } } });
  assert.equal(side.reasonCode, "DIMENSION_LIMIT");
});

test("lane availability: exact pair beats zone; deny wins ties", () => {
  const off = F.OFFERINGS.find((o) => o.shipmentMode === "SEA" && o.serviceType === "STANDARD");
  const zoneDeny = { ...off, lanes: [{ zone: 3, isAvailable: false }] };
  assert.equal(core.evaluateOffering(F.ctx(), zoneDeny, base).reasonCode, "LANE_UNAVAILABLE");
  const pairAllow = { ...off, lanes: [{ zone: 3, isAvailable: false }, { fromCityId: "c1", toCityId: "c2", isAvailable: true }] };
  assert.equal(core.evaluateOffering(F.ctx(), pairAllow, base).available, true);
  const otherPairDeny = { ...off, lanes: [{ fromCityId: "cX", toCityId: "cY", isAvailable: false }] };
  assert.equal(core.evaluateOffering(F.ctx(), otherPairDeny, base).available, true);
  const tie = { ...off, lanes: [{ zone: 3, isAvailable: true }, { zone: 3, isAvailable: false }] };
  assert.equal(core.evaluateOffering(F.ctx(), tie, base).reasonCode, "LANE_UNAVAILABLE");
});

test("minimum charge applies to the standard base price only", () => {
  const off = { ...F.OFFERINGS.find((o) => o.shipmentMode === "SEA" && o.serviceType === "ECONOMY"), minChargeNaira: 1500 };
  const r = core.evaluateOffering(F.ctx(), off, { ...base, weightKg: 5 }); // 5*80 = 400 < 1500
  assert.equal(r.finalBasePrice, 1500);
  assert.equal(r.rate.minChargeApplied, true);
});

// ─── Contract pricing ────────────────────────────────────────────────────────
test("percent contract with mode=null applies to all modes; scoped contract only to its mode", () => {
  const all = { id: "c-all", isActive: true, shipmentMode: null, serviceType: null, discountPercent: 10 };
  assert.equal(evalOne("LAND", "STANDARD", {}, { contracts: [all] }).finalBasePrice, 3600);
  assert.equal(evalOne("AIR", "EXPRESS", {}, { contracts: [all] }).finalBasePrice, 13500);
  const landOnly = { id: "c-land", isActive: true, shipmentMode: "LAND", serviceType: null, discountPercent: 10 };
  assert.equal(evalOne("AIR", "EXPRESS", {}, { contracts: [landOnly] }).finalBasePrice, 15000);
  assert.equal(evalOne("LAND", "EXPRESS", {}, { contracts: [landOnly] }).finalBasePrice, 5400);
});

test("fixed contract card is mode-specific; a fixed card without a mode is ignored, never guessed", () => {
  const airFixed = { id: "c1", isActive: true, shipmentMode: "AIR", serviceType: "STANDARD", fixedPricePerKgByZone: { 3: 800 } };
  const r = evalOne("AIR", "STANDARD", {}, { contracts: [airFixed] });
  assert.equal(r.finalBasePrice, 8000);
  assert.equal(r.pricingMode, "CONTRACT");
  assert.equal(r.appliedDiscount.discountAmount, 1000);
  assert.equal(evalOne("LAND", "STANDARD", {}, { contracts: [airFixed] }).finalBasePrice, 4000);
  const noMode = { id: "c2", isActive: true, shipmentMode: null, serviceType: null, fixedPricePerKgByZone: { 3: 1 } };
  assert.equal(evalOne("LAND", "STANDARD", {}, { contracts: [noMode] }).pricingMode, "STANDARD");
});

test("contract whose fixed map lacks this zone does not apply (and empty {} does not swallow a percent fallback)", () => {
  const wrongZone = { id: "c1", isActive: true, shipmentMode: "LAND", fixedPricePerKgByZone: { 1: 100 } };
  assert.equal(evalOne("LAND", "STANDARD", {}, { contracts: [wrongZone] }).pricingMode, "STANDARD");
  const pct = { id: "c2", isActive: true, shipmentMode: "LAND", discountPercent: 50, ownerRank: 1 };
  assert.equal(evalOne("LAND", "STANDARD", {}, { contracts: [wrongZone, pct] }).finalBasePrice, 2000);
});

test("more specific contract wins; own contract beats organisation master's", () => {
  const generic = { id: "g", isActive: true, shipmentMode: null, serviceType: null, discountPercent: 10 };
  const specific = { id: "s", isActive: true, shipmentMode: "LAND", serviceType: "STANDARD", discountPercent: 20 };
  assert.equal(evalOne("LAND", "STANDARD", {}, { contracts: [generic, specific] }).contractRateId, "s");
  const masters = { ...specific, id: "m", ownerRank: 1 };
  const own = { ...generic, id: "own", ownerRank: 0 };
  assert.equal(evalOne("LAND", "STANDARD", {}, { contracts: [masters, own] }).contractRateId, "own");
});

test("expired / inactive contracts are ignored", () => {
  const expired = { id: "e", isActive: true, shipmentMode: "LAND", discountPercent: 50, validUntil: new Date("2026-01-01") };
  const off = { id: "o", isActive: false, shipmentMode: "LAND", discountPercent: 50 };
  assert.equal(evalOne("LAND", "STANDARD", {}, { contracts: [expired, off] }).pricingMode, "STANDARD");
});

// ─── Promo pricing ───────────────────────────────────────────────────────────
test("promo is scoped by mode and service; a LAND promo never discounts AIR", () => {
  const promo = { id: "p", code: "LAND20", isActive: true, discountPercent: 20, shipmentMode: "LAND", serviceType: null };
  const land = evalOne("LAND", "STANDARD", {}, { promo });
  assert.equal(land.pricingMode, "PROMO");
  assert.equal(land.finalBasePrice, 3200);
  const air = evalOne("AIR", "STANDARD", {}, { promo });
  assert.equal(air.pricingMode, "STANDARD");
  assert.equal(air.finalBasePrice, 9000);
  assert.equal(air.promoStatus.status, "NOT_APPLICABLE");
});

test("promo: service scope, flat discount cap, and minimum order", () => {
  const svc = { id: "p", code: "X", discountPercent: 10, shipmentMode: null, serviceType: "EXPRESS" };
  assert.equal(evalOne("LAND", "STANDARD", {}, { promo: svc }).promoStatus.status, "NOT_APPLICABLE");
  assert.equal(evalOne("LAND", "EXPRESS", {}, { promo: svc }).finalBasePrice, 5400);
  const flat = { id: "f", code: "BIG", flatDiscount: 999999, shipmentMode: null, serviceType: null };
  assert.equal(evalOne("SEA", "ECONOMY", {}, { promo: flat }).finalBasePrice, 0);
  const min = { id: "m", code: "MIN", discountPercent: 10, minOrderAmount: 100000, shipmentMode: null, serviceType: null };
  assert.equal(evalOne("LAND", "STANDARD", {}, { promo: min }).promoStatus.status, "BELOW_MIN_ORDER");
});

test("contract beats promo (promo is skipped, not stacked)", () => {
  const contract = { id: "c", isActive: true, shipmentMode: null, discountPercent: 10 };
  const promo = { id: "p", code: "X", discountPercent: 50, shipmentMode: null, serviceType: null };
  const r = evalOne("LAND", "STANDARD", {}, { contracts: [contract], promo });
  assert.equal(r.finalBasePrice, 3600);
  assert.equal(r.pricingMode, "CONTRACT");
});

// ─── Surcharges & tax ────────────────────────────────────────────────────────
test("comma-list appliesTo now matches (REMOTE_AREA on STANDARD/ECONOMY only)", () => {
  assert.equal(core.surchargeApplies("STANDARD,ECONOMY", "LAND", "STANDARD"), true);
  assert.equal(core.surchargeApplies("STANDARD, ECONOMY", "LAND", "ECONOMY"), true);
  assert.equal(core.surchargeApplies("STANDARD,ECONOMY", "LAND", "EXPRESS"), false);
  assert.equal(core.surchargeApplies("AIR", "AIR", "EXPRESS"), true); // mode token
  assert.equal(core.surchargeApplies("AIR", "LAND", "EXPRESS"), false);
  assert.equal(core.surchargeApplies(null, "LAND", "EXPRESS"), false);
});

test("surcharges + VAT: LAND STANDARD 10kg", () => {
  const r = evalOne("LAND", "STANDARD");
  assert.equal(r.surchargeTotal, 700); // 200 fuel + 500 remote
  assert.equal(r.tax, 353); // round(4700 * 7.5%) = 352.5 -> 353
  assert.equal(r.total, 5053);
  assert.equal(evalOne("LAND", "EXPRESS").surchargeTotal, 300); // remote fee does not apply to EXPRESS
});

test("multiple FUEL rows are all counted in both the surcharge and the VAT base", () => {
  const extra = { id: "s9", type: "FUEL", label: "Fuel 2", ratePercent: 0, flatAmount: 1000, isActive: true, appliesTo: "ALL" };
  const r = evalOne("LAND", "EXPRESS", {}, { surcharges: [...F.SURCHARGES, extra] });
  assert.equal(r.surchargeTotal, 300 + 1000);
  assert.equal(r.taxableBase, 6000 + 300 + 1000);
});

test("fragile surcharge only when fragile; insurance/VAT rows never leak in as surcharges", () => {
  const frag = { id: "f", type: "FRAGILE", label: "Fragile", ratePercent: 0, flatAmount: 250, isActive: true, appliesTo: "ALL" };
  const ins = { id: "i", type: "INSURANCE", label: "Ins", ratePercent: 5, flatAmount: 0, isActive: true, appliesTo: "ALL" };
  assert.equal(evalOne("LAND", "EXPRESS", {}, { surcharges: [...F.SURCHARGES, frag, ins] }).surcharges.some((s) => s.type === "FRAGILE"), false);
  const r = evalOne("LAND", "EXPRESS", { isFragile: true }, { surcharges: [...F.SURCHARGES, frag, ins] });
  assert.equal(r.surcharges.some((s) => s.type === "FRAGILE"), true);
  assert.equal(r.surcharges.some((s) => s.type === "INSURANCE"), false);
});

// ─── Ad-hoc charges ──────────────────────────────────────────────────────────
test("ad-hoc AUTO_APPLY: appears once, after surcharges, taxable", () => {
  const r = evalOne("LAND", "STANDARD", {}, { evaluateAdhoc: () => ({ autoApply: [F.adhocEntry()], suggested: [] }) });
  assert.equal(r.adhocTotal, 1000);
  assert.equal(r.surchargeTotal, 700); // ad-hoc is NOT folded into surcharges
  assert.equal(r.adhocCharges.length, 1);
  assert.equal(r.taxableBase, 4000 + 200 + 500 + 1000);
  assert.equal(r.tax, 428); // round(5700*7.5%) = 427.5 -> 428
  assert.equal(r.total, 4000 + 700 + 1000 + 428);
  const order = r.surchargeBreakdown.map((l) => l.category);
  assert.deepEqual(order, ["SURCHARGE", "SURCHARGE", "ADHOC", "TAX"]);
  assert.equal(r.surchargeBreakdown.filter((l) => l.category === "ADHOC").length, 1);
});

test("ad-hoc non-taxable stays out of the VAT base", () => {
  const e = F.adhocEntry({ chargeType: { id: "t2", name: "Storage", vatApplicable: false } });
  const r = evalOne("LAND", "STANDARD", {}, { evaluateAdhoc: () => ({ autoApply: [e], suggested: [] }) });
  assert.equal(r.taxableBase, 4700);
  assert.equal(r.tax, 353);
  assert.equal(r.total, 4000 + 700 + 1000 + 353);
});

test("ad-hoc SUGGEST never alters the customer total", () => {
  const plain = evalOne("LAND", "STANDARD");
  const r = evalOne("LAND", "STANDARD", {}, { evaluateAdhoc: () => ({ autoApply: [], suggested: [F.adhocEntry({ rule: { id: "r", behaviour: "SUGGEST" } })] }) });
  assert.equal(r.total, plain.total);
  assert.equal(r.adhocTotal, 0);
  assert.equal(r.adhocSuggestions.length, 1);
});

test("zero, one and multiple ad-hoc charges", () => {
  const two = [F.adhocEntry(), F.adhocEntry({ chargeType: { id: "t3", name: "Oversize", vatApplicable: true }, amountKobo: 50050 })];
  const r0 = evalOne("LAND", "STANDARD");
  const r2 = evalOne("LAND", "STANDARD", {}, { evaluateAdhoc: () => ({ autoApply: two, suggested: [] }) });
  assert.equal(r0.adhocTotal, 0);
  assert.equal(r2.adhocCharges.length, 2);
  assert.equal(r2.adhocTotal, 1500.5);
  assert.equal(r2.pricingKobo.adhoc, 150050);
});

test("ad-hoc is evaluated against the mode's own measurements", () => {
  const seen = [];
  const evaluateAdhoc = (a) => { seen.push([a.shipmentMode, a.measurements.billableWeightKg]); return { autoApply: [], suggested: [] }; };
  const req = { ...base, weightKg: 5, customLength: 60, customWidth: 50, customHeight: 40 };
  evalOne("LAND", "STANDARD", req, { evaluateAdhoc });
  evalOne("AIR", "STANDARD", req, { evaluateAdhoc });
  assert.deepEqual(seen, [["LAND", 24], ["AIR", 20]]);
});

// ─── Insurance ───────────────────────────────────────────────────────────────
test("insurance premium is separate from VAT and counted once", () => {
  const r = evalOne("LAND", "STANDARD", { requiresInsurance: true, insuranceValue: 200000 });
  assert.equal(r.insurancePremium, 5000); // 2.5% of 200000
  assert.equal(r.tax, 353); // insurance is outside the VAT base
  assert.equal(r.total, 5053 + 5000);
  assert.equal(r.surchargeBreakdown.filter((l) => l.category === "INSURANCE").length, 1);
});

test("insurance minimum premium and auto declared value", () => {
  assert.equal(evalOne("LAND", "STANDARD", { requiresInsurance: true, insuranceValue: 1000 }).insurancePremium, 100);
  const auto = evalOne("LAND", "STANDARD", { requiresInsurance: true });
  assert.equal(auto.insuranceAutoCalculated, true);
  assert.equal(auto.insuredValue, 4400); // ceil(4000 * 1.1)
});

// ─── Final-total invariants ──────────────────────────────────────────────────
test("total === sum of explicit components, for every product and adjustment", () => {
  const evaluateAdhoc = () => ({ autoApply: [F.adhocEntry({ amountKobo: 123457 })], suggested: [] });
  const contracts = [{ id: "c", isActive: true, shipmentMode: null, discountPercent: 12.5 }];
  const promo = { id: "p", code: "P", flatDiscount: 111, shipmentMode: null, serviceType: null };
  for (const o of F.OFFERINGS) {
    for (const w of [1, 7.5, 10, 25]) {
      const r = core.evaluateOffering(F.ctx({ evaluateAdhoc, contracts, promo }), o, { ...base, weightKg: w, requiresInsurance: true, insuranceValue: 54321, isFragile: true });
      if (!r.available) continue;
      const k = r.pricingKobo;
      assert.equal(k.total, k.base + k.surcharge + k.adhoc + k.insurance + k.tax, `${o.shipmentMode}/${o.serviceType}/${w}`);
      const lines = r.surchargeBreakdown.reduce((a, l) => a + l.amountKobo, 0);
      assert.equal(lines, k.surcharge + k.adhoc + k.insurance + k.tax);
      assert.equal(Math.round(r.total * 100), k.total);
      assert.equal(Math.round(r.finalBasePrice * 100), k.base);
    }
  }
});

test("kobo helpers round correctly", () => {
  assert.equal(core.toKobo(1234.565), 123457);
  assert.equal(core.fromKobo(123457), 1234.57);
  assert.equal(core.toKobo(0.1 + 0.2), 30);
});
