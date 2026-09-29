const test = require("node:test");
const assert = require("node:assert/strict");
const { computeCoverage, rateWarnings } = require("../src/services/pricing/offeringRules");
const F = require("./fixtures");

test("coverage: sellable only with BOTH a usable rate and an SLA", () => {
  const off = F.OFFERINGS.find((o) => o.shipmentMode === "LAND" && o.serviceType === "STANDARD");
  const cov = computeCoverage({ offering: off, zones: [3, 4], slas: F.SLAS, bands: F.BANDS, now: F.now });
  assert.deepEqual(cov.map((c) => [c.zone, c.sellable, c.missing]), [[3, true, []], [4, false, ["RATE", "SLA"]]]);
});

test("coverage: rate without SLA is reported as missing SLA, and allowsNoSla lifts it", () => {
  const off = F.OFFERINGS.find((o) => o.shipmentMode === "SEA" && o.serviceType === "ECONOMY");
  const noSla = F.SLAS.filter((s) => !(s.shipmentMode === "SEA" && s.serviceType === "ECONOMY"));
  const c = computeCoverage({ offering: off, zones: [3], slas: noSla, bands: F.BANDS, now: F.now })[0];
  assert.deepEqual([c.sellable, c.missing], [false, ["SLA"]]);
  const lifted = computeCoverage({ offering: { ...off, allowsNoSla: true }, zones: [3], slas: noSla, bands: F.BANDS, now: F.now })[0];
  assert.equal(lifted.sellable, true);
});

test("coverage: ₦0 placeholder and inactive bands do not count", () => {
  const off = F.OFFERINGS[0];
  const bands = [
    F.band({ shipmentMode: off.shipmentMode, serviceType: off.serviceType, pricePerKg: 0, basePrice: 0 }),
    F.band({ shipmentMode: off.shipmentMode, serviceType: off.serviceType, pricePerKg: 5, isActive: false }),
  ];
  assert.equal(computeCoverage({ offering: off, zones: [3], slas: F.SLAS, bands, now: F.now })[0].hasRate, false);
});

test("warnings are advisory: fixtures are sane, and an inverted card is flagged not blocked", () => {
  assert.deepEqual(rateWarnings({ bands: F.BANDS, zones: [3], now: F.now }), []);
  const inverted = [
    F.band({ shipmentMode: "LAND", serviceType: "STANDARD", pricePerKg: 500 }),
    F.band({ shipmentMode: "AIR", serviceType: "STANDARD", pricePerKg: 100 }),
    F.band({ shipmentMode: "SEA", serviceType: "STANDARD", pricePerKg: 900 }),
  ];
  const w = rateWarnings({ bands: inverted, zones: [3], services: ["STANDARD"], now: F.now });
  assert.deepEqual(w.map((x) => x.code).sort(), ["AIR_CHEAPER_THAN_LAND", "SEA_DEARER_THAN_AIR"]);
});
