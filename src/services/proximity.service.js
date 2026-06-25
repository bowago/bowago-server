/**
 * Driver Proximity Service — Sprint 4
 *
 * PRD spec:
 *   "Trigger: Driver location within 500 meters of pickup address.
 *    GPS updates location every 5 minutes.
 *    When distance ≤ 500m: System sends push 'Driver arriving in ~30 minutes'.
 *    Deduplication: Only send once per shipment."
 *
 * How it works:
 *  1. The driver's mobile app calls POST /api/v1/shipments/:id/driver-location
 *     with { lat, lng } every 5 minutes while on the way to pickup.
 *  2. This service calculates Haversine distance from driver to pickup address.
 *     (Pickup lat/lng must exist on the Shipment record — set when the shipment
 *      is created/confirmed. If missing, we skip the check.)
 *  3. If distance ≤ PROXIMITY_THRESHOLD_METERS AND the notification hasn't
 *     been sent yet (proximityAlertSent = false on Shipment), we:
 *      a. Emit a Socket.IO push to the customer.
 *      b. Create an in-app Notification row.
 *      c. Mark shipment.proximityAlertSent = true to prevent duplicates.
 *
 * Prisma schema additions required (add to Shipment model):
 *   pickupLat           Float?
 *   pickupLng           Float?
 *   proximityAlertSent  Boolean @default(false)
 *
 * Run the Prisma migration after adding those fields:
 *   npx prisma migrate dev --name add_proximity_fields
 */

const { prisma } = require("../config/db");
const socketService = require("./socket.service");

const PROXIMITY_THRESHOLD_METERS = 500;

/**
 * Haversine formula — returns distance in metres between two lat/lng pairs.
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number} distance in metres
 */
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6_371_000; // Earth radius in metres
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Check proximity and fire the "driver arriving" notification if warranted.
 *
 * @param {string} shipmentId - ID of the shipment being picked up
 * @param {number} driverLat  - Driver's current latitude
 * @param {number} driverLng  - Driver's current longitude
 */
async function checkProximityAndNotify(shipmentId, driverLat, driverLng) {
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    select: {
      id: true,
      customerId: true,
      trackingNumber: true,
      status: true,
      pickupLat: true,
      pickupLng: true,
      proximityAlertSent: true,
    },
  });

  if (!shipment) return { skipped: "shipment_not_found" };

  // Only relevant while shipment is on the way to pickup
  if (!["CONFIRMED", "AWAITING_PICKUP"].includes(shipment.status)) {
    return { skipped: "wrong_status", status: shipment.status };
  }

  // Already notified — do nothing (PRD: "Deduplication: Only send once")
  if (shipment.proximityAlertSent) {
    return { skipped: "already_sent" };
  }

  // No pickup coordinates stored yet
  if (shipment.pickupLat == null || shipment.pickupLng == null) {
    return { skipped: "no_pickup_coords" };
  }

  const distanceMeters = haversineMeters(
    driverLat,
    driverLng,
    shipment.pickupLat,
    shipment.pickupLng,
  );

  if (distanceMeters > PROXIMITY_THRESHOLD_METERS) {
    return { skipped: "too_far", distanceMeters: Math.round(distanceMeters) };
  }

  // ── Driver is within 500 m — fire the notification ──────────────────────

  // 1. Mark alert as sent (idempotency guard)
  await prisma.shipment.update({
    where: { id: shipmentId },
    data: { proximityAlertSent: true },
  });

  // 2. Persist in-app notification
  const notification = await prisma.notification.create({
    data: {
      userId: shipment.customerId,
      title: "Driver is nearby",
      body: `Your driver is arriving in approximately 30 minutes to pick up shipment ${shipment.trackingNumber}. Please have your package ready.`,
      type: "SHIPMENT_UPDATE",
      shipmentId: shipment.id,
      isRead: false,
    },
  });

  // 3. Push via Socket.IO (PRD Sprint 4: real-time push to customer)
  socketService.emitNotification(shipment.customerId, {
    id: notification.id,
    title: notification.title,
    body: notification.body,
    type: notification.type,
    shipmentId: shipment.id,
    trackingNumber: shipment.trackingNumber,
    deepLink: `/track/${shipment.trackingNumber}`,
  });

  return {
    notified: true,
    distanceMeters: Math.round(distanceMeters),
    customerId: shipment.customerId,
  };
}

module.exports = { checkProximityAndNotify, haversineMeters };
