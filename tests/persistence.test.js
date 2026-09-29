const test = require("node:test");
const assert = require("node:assert/strict");
const { loadFacade } = require("./fakeDb");
const F = require("./fixtures");

const req = { fromCity: "Lagos", toCity: "Abuja", weightKg: 10, isFragile: false };
const adhoc = () => ({ autoApply: [F.adhocEntry()], suggested: [] });

async function priced(mode, service, extra = {}) {
  const { facade } = loadFacade({ contracts: [] });
  const r = await facade.calculateShippingCost({ ...req, ...extra, shipmentMode: mode, serviceType: service });
  const snap = require("../src/services/quoteSnapshot");
  return { r, snap };
}

const cols = (snap, r, extra = {}) =>
  snap.quoteColumns(r, { ...req, ...extra }, {
    userId: "u1", originCity: "Lagos", destinationCity: "Abuja",
    expiresAt: new Date(), declaredValueKobo: 5000000, insuranceSelected: !!extra.requiresInsurance,
  });

test("quote columns: the persisted kobo components add up to the persisted total", async () => {
  const { r, snap } = await priced("LAND", "STANDARD", { requiresInsurance: true, insuranceValue: 50000 });
  const q = cols(snap, r, { requiresInsurance: true, insuranceValue: 50000 });
  assert.equal(q.totalPriceKobo, q.basePriceKobo + q.surchargeTotalKobo + q.adhocChargesKobo + (q.insurancePremiumKobo || 0) + q.vatKobo);
  assert.equal(q.fuelSurchargeKobo + q.remoteAreaFeeKobo, q.surchargeTotalKobo);
  assert.equal(q.standardBasePriceKobo, 400000);
  assert.equal(q.shipmentMode, "LAND");
  assert.equal(q.serviceType, "STANDARD");
  assert.equal(q.offeringId, "o-LAND-STANDARD");
});

test("quote columns: SLA and product are snapshotted with the quote", async () => {
  const { r, snap } = await priced("AIR", "EXPRESS");
  const q = cols(snap, r);
  assert.deepEqual([q.slaMinDays, q.slaMaxDays], [1, 2]);
  assert.equal(q.slaLabel, "1–2 business days");
  assert.ok(q.pricingSnapshot.version === 2);
  assert.equal(q.pricingSnapshot.offering.shipmentMode, "AIR");
  assert.equal(q.weightKg, 10); // ACTUAL weight column stays actual
});

test("quote view reads back exactly what was persisted (no recomputation)", async () => {
  const { r, snap } = await priced("LAND", "EXPRESS");
  const stored = { id: "q1", ...cols(snap, r) };
  // Simulate the world changing after the quote: nothing in the view depends on live rates.
  const view = snap.quoteToPricedView(stored, { fromCity: { name: "Lagos" }, toCity: { name: "Abuja" } });
  assert.equal(view.total, r.total);
  assert.equal(view.finalBasePrice, r.finalBasePrice);
  assert.equal(view.surchargeTotal, r.surchargeTotal);
  assert.deepEqual(view.deliveryEstimate, { minDays: 2, maxDays: 4, label: "2–4 business days", source: "SNAPSHOT" });
  assert.equal(view.pricing.totalNaira, r.total);
  assert.equal(view.pricing.basePriceNaira + view.pricing.surchargeTotalNaira + view.pricing.adhocTotalNaira + view.pricing.taxNaira, r.total);
});

test("pricingBlock exposes explicit components — clients never need total − surcharge", async () => {
  const { r, snap } = await priced("LAND", "STANDARD");
  const b = snap.pricingBlock({ id: "q", ...cols(snap, r) });
  assert.deepEqual([b.basePriceNaira, b.surchargeTotalNaira, b.taxNaira, b.totalNaira], [4000, 700, 353, 5053]);
  assert.equal(b.fuelSurchargeNaira, 200);
  assert.equal(b.remoteAreaFeeNaira, 500);
});

test("shipment snapshot fields carry the locked product, SLA and breakdown", async () => {
  const { r, snap } = await priced("LAND", "STANDARD");
  const stored = { id: "q1", ...cols(snap, r) };
  const f = snap.shipmentSnapshotFields(stored);
  assert.equal(f.offeringId, "o-LAND-STANDARD");
  assert.deepEqual([f.slaMinDays, f.slaMaxDays], [3, 5]);
  assert.equal(f.surchargeBreakdown.length, stored.surchargeBreakdown.length);
  assert.ok(f.pricingSnapshot);
});

test("estimated delivery uses the quote's SLA snapshot even if today's SLA row changed", async () => {
  const { facade, state } = loadFacade();
  const snap = require("../src/services/quoteSnapshot");
  const r = await facade.calculateShippingCost({ ...req, shipmentMode: "LAND", serviceType: "STANDARD" });
  const stored = { id: "q1", ...cols(snap, r) };
  state.slas.find((s) => s.shipmentMode === "LAND" && s.serviceType === "STANDARD").maxDays = 30; // ops changes the SLA afterwards
  const mon = new Date("2026-10-05T09:00:00Z");
  const d = await snap.estimatedDeliveryFor(stored, mon);
  assert.equal(d.toISOString().slice(0, 10), "2026-10-12"); // 5 business days from Monday, not 30
});

test("legacy quote (no snapshot): falls back to that exact zone+mode+service SLA, or no estimate", async () => {
  loadFacade();
  const snap = require("../src/services/quoteSnapshot");
  const legacy = { id: "old", zone: 3, shipmentMode: "LAND", serviceType: "STANDARD", slaMaxDays: null }; // pre-snapshot quote
  const mon = new Date("2026-10-05T09:00:00Z");
  assert.equal((await snap.estimatedDeliveryFor(legacy, mon)).toISOString().slice(0, 10), "2026-10-12");
  assert.equal(await snap.estimatedDeliveryFor({ ...legacy, serviceType: "EXPRESS", shipmentMode: "SEA" }, mon), null);
});

test("approved ad-hoc charge moves quote total, columns, breakdown and snapshot together", async () => {
  const { r, snap } = await priced("LAND", "STANDARD");
  const stored = { id: "q1", ...cols(snap, r) };
  const patch = snap.applyApprovedAdhocToQuote(stored, { name: "Storage", reason: "held 3 days", amountKobo: 200000, vatKobo: 15000, vatApplicable: true, chargeTypeId: "t9" });
  assert.equal(patch.totalPriceKobo, stored.totalPriceKobo + 215000);
  assert.equal(patch.adhocChargesKobo, 200000);
  assert.equal(patch.vatKobo, stored.vatKobo + 15000);
  const cats = patch.surchargeBreakdown.map((l) => l.category);
  assert.deepEqual(cats, ["SURCHARGE", "SURCHARGE", "ADHOC", "TAX"]); // ad-hoc sits before the tax line
  const lineTotal = patch.surchargeBreakdown.reduce((a, l) => a + l.amountKobo, 0);
  assert.equal(stored.basePriceKobo + lineTotal, patch.totalPriceKobo, "breakdown still sums to the total");
  assert.equal(patch.pricingSnapshot.pricingKobo.total, patch.totalPriceKobo);
  assert.equal(patch.pricingSnapshot.components.total, patch.totalPriceKobo / 100);
  assert.equal(stored.totalPriceKobo, r.pricingKobo.total, "the input row was not mutated");
});

test("approved non-taxable ad-hoc adds no VAT line change", async () => {
  const { r, snap } = await priced("SEA", "ECONOMY"); // no VAT surcharge match? VAT is ALL so a tax line exists
  const stored = { id: "q1", ...cols(snap, r) };
  const patch = snap.applyApprovedAdhocToQuote(stored, { name: "Fee", amountKobo: 50000, vatKobo: 0, vatApplicable: false, chargeTypeId: "t" });
  assert.equal(patch.vatKobo, stored.vatKobo);
  assert.equal(patch.totalPriceKobo, stored.totalPriceKobo + 50000);
});
