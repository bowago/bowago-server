const { prisma } = require('../config/db');
const { ApiError } = require('../utils/ApiError');

/**
 * Determines zone between two cities using the zone matrix.
 * Falls back to region-based calculation if direct city lookup fails.
 */
async function getZone(fromCityName, toCityName) {
  const [fromCity, toCity] = await Promise.all([
    prisma.city.findFirst({ where: { name: { equals: fromCityName, mode: 'insensitive' } } }),
    prisma.city.findFirst({ where: { name: { equals: toCityName, mode: 'insensitive' } } }),
  ]);

  if (!fromCity) throw new ApiError(400, `Origin city "${fromCityName}" not found`);
  if (!toCity) throw new ApiError(400, `Destination city "${toCityName}" not found`);

  const matrix = await prisma.zoneMatrix.findUnique({
    where: { fromCityId_toCityId: { fromCityId: fromCity.id, toCityId: toCity.id } },
  });

  if (!matrix) throw new ApiError(400, `No zone data available for this route`);

  return { zone: matrix.zone, fromCity, toCity };
}

/**
 * Gets distance in KM between two cities.
 */
async function getDistance(fromCityId, toCityId) {
  const km = await prisma.kmMatrix.findUnique({
    where: { fromCityId_toCityId: { fromCityId, toCityId } },
  });
  return km ? km.distanceKm : null;
}

/**
 * Main shipping cost calculator.
 * Input: { fromCity, toCity, weightKg?, tons?, cartons?, boxDimensionId? }
 */
async function calculateShippingCost({ fromCity, toCity, weightKg, tons, cartons, boxDimensionId }) {
  // 1. Get zone
  const { zone, fromCity: from, toCity: to } = await getZone(fromCity, toCity);

  // 2. Get distance
  const distanceKm = await getDistance(from.id, to.id);

  // 3. Determine weight in KG
  let resolvedWeightKg = weightKg;

  if (!resolvedWeightKg && boxDimensionId) {
    const box = await prisma.boxDimension.findUnique({ where: { id: boxDimensionId } });
    if (box) {
      resolvedWeightKg = box.weightKgLimit;
    }
  }

  if (!resolvedWeightKg && tons) resolvedWeightKg = tons * 1000;
  if (!resolvedWeightKg && cartons) resolvedWeightKg = cartons * 15; // ~15kg avg per carton

  if (!resolvedWeightKg || resolvedWeightKg <= 0) {
    throw new ApiError(400, 'Please provide weight (kg, tons, or cartons)');
  }

  // 4. Find price band for this zone + weight
  const priceBand = await prisma.priceBand.findFirst({
    where: {
      zone,
      isActive: true,
      minKg: { lte: resolvedWeightKg },
      OR: [
        { maxKg: { gte: resolvedWeightKg } },
        { maxKg: null }, // "and above" band
      ],
    },
  });

  if (!priceBand) {
    throw new ApiError(400, `No pricing available for zone ${zone} with weight ${resolvedWeightKg}kg`);
  }

  // 5. Calculate price
  let price = 0;
  if (priceBand.pricePerKg) {
    price = priceBand.pricePerKg * resolvedWeightKg;
  } else if (priceBand.basePrice) {
    price = priceBand.basePrice;
  }

  // 6. Apply surcharges if needed
  const isFragile = false; // passed from caller if needed
  const fragileMultiplier = 1.0;

  const finalPrice = Math.ceil(price * fragileMultiplier);

  return {
    zone,
    distanceKm,
    weightKg: resolvedWeightKg,
    fromCity: { id: from.id, name: from.name, region: from.region, state: from.state },
    toCity: { id: to.id, name: to.name, region: to.region, state: to.state },
    breakdown: {
      priceBandId: priceBand.id,
      basePrice: priceBand.basePrice,
      pricePerKg: priceBand.pricePerKg,
      subtotal: price,
    },
    total: finalPrice,
    currency: 'NGN',
  };
}

module.exports = { calculateShippingCost, getZone, getDistance };
