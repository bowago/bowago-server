// ─── src/services/pricing/offeringRules.js ───────────────────────────────────
// Pure helpers behind the admin "Offerings" screen: how much of the network an
// offering can actually sell in, and advisory warnings about suspicious rate
// relationships. Warnings are ADVISORY only — the skill forbids hard-coding
// "AIR > LAND > SEA" as a universal law, so nothing here ever blocks a save.
const { bandPrice } = require("./core");

const validNow = (row, now) =>
  (!row.validFrom || new Date(row.validFrom) <= now) && (!row.validUntil || new Date(row.validUntil) >= now);

const usableBands = (bands, mode, service, zone, now) =>
  bands.filter(
    (b) => b.isActive && b.shipmentMode === mode && b.serviceType === service && validNow(b, now) && bandPrice(b, zone, 1),
  );

/**
 * Per-zone sellability of one offering: does it have an SLA (or explicitly
 * allow none) AND at least one usable, priced rate band?
 */
function computeCoverage({ offering, zones, slas, bands, now = new Date() }) {
  return zones.map((zone) => {
    const sla = slas.find(
      (s) => Number(s.zone) === Number(zone) && s.shipmentMode === offering.shipmentMode && s.serviceType === offering.serviceType,
    );
    const rateBands = usableBands(bands, offering.shipmentMode, offering.serviceType, zone, now);
    const hasSla = !!sla;
    const hasRate = rateBands.length > 0;
    return {
      zone,
      hasSla,
      sla: sla ? { id: sla.id, minDays: sla.minDays, maxDays: sla.maxDays, label: sla.label } : null,
      hasRate,
      rateBandCount: rateBands.length,
      sellable: hasRate && (hasSla || !!offering.allowsNoSla),
      missing: [!hasRate && "RATE", !hasSla && !offering.allowsNoSla && "SLA"].filter(Boolean),
    };
  });
}

/**
 * Advisory: at a probe weight, per zone and service, flag AIR cheaper than LAND
 * and SEA dearer than AIR/LAND. Exceptions can be commercially justified, so
 * these are surfaced to the admin, never enforced.
 */
function rateWarnings({ bands, zones, services = ["EXPRESS", "STANDARD", "ECONOMY"], probeKg = 10, now = new Date() }) {
  const priceAt = (mode, service, zone) => {
    const cands = usableBands(bands, mode, service, zone, now)
      .filter((b) => b.minKg <= probeKg && (b.maxKg === null || b.maxKg === undefined || probeKg <= b.maxKg))
      .sort((a, b) => b.minKg - a.minKg);
    if (!cands.length) return null;
    return bandPrice(cands[0], zone, probeKg)?.amount ?? null;
  };
  const out = [];
  for (const zone of zones) {
    for (const service of services) {
      const air = priceAt("AIR", service, zone);
      const land = priceAt("LAND", service, zone);
      const sea = priceAt("SEA", service, zone);
      const add = (code, message) => out.push({ code, zone, serviceType: service, probeKg, message });
      if (air !== null && land !== null && air < land)
        add("AIR_CHEAPER_THAN_LAND", `Zone ${zone} ${service}: AIR (₦${air.toLocaleString()}) is cheaper than LAND (₦${land.toLocaleString()}) at ${probeKg}kg.`);
      if (sea !== null && air !== null && sea > air)
        add("SEA_DEARER_THAN_AIR", `Zone ${zone} ${service}: SEA (₦${sea.toLocaleString()}) costs more than AIR (₦${air.toLocaleString()}) at ${probeKg}kg.`);
      else if (sea !== null && land !== null && sea > land)
        add("SEA_DEARER_THAN_LAND", `Zone ${zone} ${service}: SEA (₦${sea.toLocaleString()}) costs more than LAND (₦${land.toLocaleString()}) at ${probeKg}kg.`);
    }
  }
  return out;
}

module.exports = { computeCoverage, rateWarnings };
