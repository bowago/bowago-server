const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeBand, findConflict } = require("../src/services/pricing/bandRules");
const { normalizeContract, findContractConflict } = require("../src/services/pricing/contractRules");

const rejects = (fn, re) => assert.throws(fn, (e) => (re ? re.test(e.message) : true));
const goodBand = { shipmentMode: "AIR", serviceType: "EXPRESS", zone: 3, pricePerKg: 5, minKg: 0, maxKg: 10 };

// ─── Bands ───────────────────────────────────────────────────────────────────
test("band: mode and service are mandatory (no defaults)", () => {
  rejects(() => normalizeBand({ ...goodBand, shipmentMode: undefined }), /shipmentMode/);
  rejects(() => normalizeBand({ ...goodBand, serviceType: undefined }), /serviceType/);
  rejects(() => normalizeBand({ ...goodBand, shipmentMode: "RAIL" }), /shipmentMode/);
});

test("band: an active band needs a real price — ₦0 and discount-only are rejected", () => {
  rejects(() => normalizeBand({ ...goodBand, pricePerKg: 0, basePrice: 0 }), /needs a price/);
  rejects(() => normalizeBand({ ...goodBand, pricePerKg: null, discountPercent: 15 }), /discount alone/);
  assert.equal(normalizeBand({ ...goodBand, pricePerKg: 0, basePrice: 0, isActive: false }).pricePerKg, null); // inactive placeholder is fine
});

test("band: zone XOR fixed map; map values must be positive; weight & validity sanity", () => {
  rejects(() => normalizeBand({ ...goodBand, fixedPricePerKgByZone: { 3: 5 } }), /not both/);
  rejects(() => normalizeBand({ ...goodBand, zone: null, pricePerKg: null, fixedPricePerKgByZone: { 3: 0 } }), /greater than 0/);
  rejects(() => normalizeBand({ ...goodBand, zone: null, pricePerKg: null, fixedPricePerKgByZone: "{oops" }), /valid JSON/);
  rejects(() => normalizeBand({ ...goodBand, zone: null }), /zone/);
  rejects(() => normalizeBand({ ...goodBand, minKg: 10, maxKg: 5 }), /maxKg/);
  rejects(() => normalizeBand({ ...goodBand, validFrom: "2026-05-01", validUntil: "2026-04-01" }), /validUntil/);
  const multi = normalizeBand({ ...goodBand, zone: null, pricePerKg: null, fixedPricePerKgByZone: '{"1":150,"2":200}' });
  assert.deepEqual(multi.fixedPricePerKgByZone, { 1: 150, 2: 200 });
  assert.equal(multi.zone, null);
});

test("band conflicts: same product+zone+weight+validity overlap; edges, modes, services, zones don't", () => {
  const existing = { id: "1", isActive: true, ...normalizeBand(goodBand) };
  const c = (o) => findConflict({ ...normalizeBand({ ...goodBand, ...o }) }, [existing], { ignoreId: o.id });
  assert.ok(c({ minKg: 5, maxKg: 20 }));
  assert.ok(c({ minKg: 0, maxKg: null }));
  assert.equal(c({ minKg: 10, maxKg: 20 }), null, "touching edges are not an overlap");
  assert.equal(c({ shipmentMode: "SEA" }), null);
  assert.equal(c({ serviceType: "STANDARD" }), null);
  assert.equal(c({ zone: 4 }), null);
  assert.equal(c({ validFrom: "2027-01-01", validUntil: "2027-06-01" }) && 1, existing.validFrom || existing.validUntil ? null : 1); // open-ended existing overlaps a dated window
  assert.equal(findConflict({ ...existing }, [existing], { ignoreId: "1" }), null, "a band never conflicts with itself");
  assert.ok(findConflict({ ...normalizeBand({ ...goodBand, zone: null, pricePerKg: null, fixedPricePerKgByZone: { 3: 9 } }) }, [existing]), "fixed map overlapping a single-zone band");
});

// ─── Contracts ───────────────────────────────────────────────────────────────
test("contract: exactly one pricing type; percent bounds; fixed needs a mode", () => {
  rejects(() => normalizeContract({}), /discountPercent or fixed/);
  rejects(() => normalizeContract({ discountPercent: 10, fixedPricePerKgByZone: { 1: 5 }, shipmentMode: "LAND" }), /not both/);
  rejects(() => normalizeContract({ discountPercent: 0 }), /greater than 0/);
  rejects(() => normalizeContract({ discountPercent: 101 }), /at most 100/);
  rejects(() => normalizeContract({ fixedPricePerKgByZone: { 1: 5 } }), /must name its shipment mode/);
  rejects(() => normalizeContract({ discountPercent: 10, shipmentMode: "RAIL" }), /shipmentMode/);
  assert.equal(normalizeContract({ discountPercent: 10 }).shipmentMode, null); // null = all modes, explicitly
  assert.equal(normalizeContract({ fixedPricePerKgByZone: { 1: 5 }, shipmentMode: "AIR" }).shipmentMode, "AIR");
});

test("contract conflicts: overlapping scope+period clash; different modes/periods don't", () => {
  const all = { id: "a", isActive: true, ...normalizeContract({ discountPercent: 10 }) };
  const landOnly = normalizeContract({ discountPercent: 5, shipmentMode: "LAND" });
  assert.ok(findContractConflict(landOnly, [all]), "an all-modes contract overlaps a land contract");
  const air = { id: "b", isActive: true, ...normalizeContract({ discountPercent: 5, shipmentMode: "AIR" }) };
  assert.equal(findContractConflict(landOnly, [air]), null);
  const later = normalizeContract({ discountPercent: 5, validFrom: "2027-01-01" });
  const ended = { id: "c", isActive: true, ...normalizeContract({ discountPercent: 10, validUntil: "2026-12-31" }) };
  assert.equal(findContractConflict(later, [ended]), null);
  assert.equal(findContractConflict(landOnly, [all], { ignoreId: "a" }), null);
});
