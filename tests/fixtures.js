// Shared in-memory fixtures for the pricing tests (no database needed).
const now = new Date("2026-09-28T10:00:00Z");
const band = (o) => ({ id: `b-${Math.random().toString(36).slice(2, 8)}`, isActive: true, minKg: 0, maxKg: 50, zone: 3,
  pricePerKg: null, basePrice: null, fixedPricePerKgByZone: null, validFrom: null, validUntil: null, updatedAt: now, ...o });

const offering = (mode, service, extra = {}) => ({
  id: `o-${mode}-${service}`, shipmentMode: mode, serviceType: service, displayName: null, isActive: true,
  allowsNoSla: false, minWeightKg: null, maxWeightKg: null, maxLongestSideCm: null, minChargeNaira: null, lanes: [], ...extra,
});

// The seven products BowaGO operates in this fixture (NO SEA+EXPRESS, NO AIR+ECONOMY).
const OFFERINGS = [
  offering("AIR", "EXPRESS"), offering("AIR", "STANDARD"),
  offering("LAND", "EXPRESS"), offering("LAND", "STANDARD"), offering("LAND", "ECONOMY"),
  offering("SEA", "STANDARD"), offering("SEA", "ECONOMY"),
];

const BANDS = [
  band({ shipmentMode: "LAND", serviceType: "EXPRESS", pricePerKg: 600 }),
  band({ shipmentMode: "LAND", serviceType: "STANDARD", minKg: 0, maxKg: 10, pricePerKg: 400 }),
  band({ shipmentMode: "LAND", serviceType: "STANDARD", minKg: 11, maxKg: 50, pricePerKg: 300 }),
  band({ shipmentMode: "LAND", serviceType: "ECONOMY", pricePerKg: 200 }),
  band({ shipmentMode: "AIR", serviceType: "EXPRESS", pricePerKg: 1500 }),
  // fixed-price-by-zone band (zone null, price lives in the map)
  band({ shipmentMode: "AIR", serviceType: "STANDARD", zone: null, fixedPricePerKgByZone: { 3: 900 } }),
  band({ shipmentMode: "SEA", serviceType: "STANDARD", pricePerKg: 120 }),
  band({ shipmentMode: "SEA", serviceType: "ECONOMY", pricePerKg: 80 }),
];

const sla = (mode, service, minDays, maxDays, zone = 3) => ({ id: `s-${mode}-${service}-${zone}`, zone, shipmentMode: mode, serviceType: service, minDays, maxDays, label: null });
const SLAS = [
  sla("LAND", "EXPRESS", 2, 4), sla("LAND", "STANDARD", 3, 5), sla("LAND", "ECONOMY", 5, 8),
  sla("AIR", "EXPRESS", 1, 2), sla("AIR", "STANDARD", 2, 3),
  sla("SEA", "STANDARD", 10, 14), sla("SEA", "ECONOMY", 12, 18),
];

const SURCHARGES = [
  { id: "s1", type: "FUEL", label: "Fuel Surcharge", ratePercent: 5, flatAmount: 0, isActive: true, appliesTo: "ALL" },
  { id: "s2", type: "REMOTE_AREA", label: "Remote Area Fee", ratePercent: 0, flatAmount: 500, isActive: true, appliesTo: "STANDARD,ECONOMY" },
  { id: "s3", type: "VAT", label: "VAT (7.5%)", ratePercent: 7.5, flatAmount: 0, isActive: true, appliesTo: "ALL" },
];

const ZONE3 = { zone: 3, fromCity: { id: "c1", name: "Lagos" }, toCity: { id: "c2", name: "Abuja" } };

function ctx(over = {}) {
  return {
    now, ...ZONE3, distanceKm: 760,
    modeSettings: { LAND: { isActive: true, volumetricDivisor: 5000 }, AIR: { isActive: true, volumetricDivisor: 6000 }, SEA: { isActive: true, volumetricDivisor: 5000 } },
    slas: SLAS, bands: BANDS, surcharges: SURCHARGES, box: null, contracts: [], promo: null,
    insurance: { ratePercent: 2.5, minPremiumNaira: 100 },
    evaluateAdhoc: () => ({ autoApply: [], suggested: [] }),
    ...over,
  };
}

const adhocEntry = (o = {}) => ({
  rule: { id: "r1", behaviour: "AUTO_APPLY" },
  chargeType: { id: "t1", name: "Heavy handling", vatApplicable: true },
  amountKobo: 100000, reason: "Billable weight above threshold", ...o,
});

module.exports = { now, band, offering, OFFERINGS, BANDS, SLAS, SURCHARGES, ctx, adhocEntry, sla };
