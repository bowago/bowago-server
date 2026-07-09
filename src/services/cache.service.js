// cache.service.js — Sprint 4 tracking-query cache
//
// PRD Sprint 4 technical spec: "Implement Redis caching for tracking queries
// to handle high traffic spikes without hitting the main DB."
//
// Implementation: Upstash Redis over REST (the project already runs QStash on
// Upstash, and the REST client works in serverless/Vercel without persistent
// TCP connections). The cache degrades gracefully:
//
//   • UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set → every call
//     is a no-op and tracking reads hit the database directly (identical to
//     pre-cache behaviour — nothing breaks in dev or if Redis is down).
//   • Any Redis error → logged and treated as a cache miss.
//
// Cache keys are invalidated whenever a shipment's status/timeline changes
// (see shipment.controller updateShipmentStatus / updateDriverLocation), and
// entries carry a short TTL as a safety net so stale data can never persist
// longer than TRACKING_CACHE_TTL_SECONDS even if an invalidation is missed.

const REST_URL = process.env.UPSTASH_REDIS_REST_URL || null;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || null;
const TTL_SECONDS = parseInt(process.env.TRACKING_CACHE_TTL_SECONDS) || 30;

const enabled = !!(REST_URL && REST_TOKEN);

async function redisCommand(command) {
  // Upstash REST protocol: POST the command as a JSON array to the base URL.
  const res = await fetch(REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Upstash Redis HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

function trackingKey(trackingNumber) {
  return `tracking:${String(trackingNumber).trim().toUpperCase()}`;
}

/** Get a cached tracking payload (parsed) or null on miss/error/disabled. */
async function getCachedTracking(trackingNumber) {
  if (!enabled) return null;
  try {
    const raw = await redisCommand(["GET", trackingKey(trackingNumber)]);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error("[Cache] tracking GET failed:", err.message);
    return null;
  }
}

/** Store a tracking payload with TTL. Never throws. */
async function setCachedTracking(trackingNumber, payload) {
  if (!enabled) return;
  try {
    await redisCommand([
      "SET",
      trackingKey(trackingNumber),
      JSON.stringify(payload),
      "EX",
      String(TTL_SECONDS),
    ]);
  } catch (err) {
    console.error("[Cache] tracking SET failed:", err.message);
  }
}

/** Invalidate a shipment's tracking cache (call on any status/timeline change). */
async function invalidateTracking(trackingNumber) {
  if (!enabled || !trackingNumber) return;
  try {
    await redisCommand(["DEL", trackingKey(trackingNumber)]);
  } catch (err) {
    console.error("[Cache] tracking DEL failed:", err.message);
  }
}

module.exports = {
  cacheEnabled: enabled,
  getCachedTracking,
  setCachedTracking,
  invalidateTracking,
};
