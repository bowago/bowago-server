const { prisma } = require("../config/db");

let webpush = null;
let configured = false;

function ensureConfigured() {
  if (configured) return webpush;

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:support@bowago.dev";

  if (!publicKey || !privateKey) {
    // Not configured yet — push sends become silent no-ops rather than
    // crashing every notification-creating request. Run
    // `npx web-push generate-vapid-keys` and set the two env vars to
    // enable actual delivery.
    return null;
  }

  webpush = require("web-push");
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return webpush;
}

/**
 * Save (or refresh) a browser's push subscription for a user.
 * @param {string} userId
 * @param {{endpoint:string, keys:{p256dh:string, auth:string}}} subscription
 * @param {string} [userAgent]
 */
async function saveSubscription(userId, subscription, userAgent) {
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    throw new Error("Invalid push subscription payload");
  }

  return prisma.pushSubscription.upsert({
    where: { endpoint },
    update: { userId, p256dh: keys.p256dh, auth: keys.auth, userAgent },
    create: {
      userId,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userAgent,
    },
  });
}

/**
 * Remove a subscription (user disabled push, or browser reported it's gone).
 * @param {string} endpoint
 */
async function removeSubscription(endpoint) {
  await prisma.pushSubscription.deleteMany({ where: { endpoint } });
}

/**
 * Send a push notification to every device a user has subscribed on.
 * Expired/invalid subscriptions (HTTP 404/410 from the push service) are
 * pruned automatically so they don't keep failing forever.
 *
 * @param {string} userId
 * @param {{title:string, body:string, data?:object}} payload
 */
async function sendPush(userId, payload) {
  const wp = ensureConfigured();
  if (!wp || !userId) return;

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId },
  });
  if (subscriptions.length === 0) return;

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    data: payload.data || {},
  });

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await wp.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          body,
        );
      } catch (err) {
        // 404/410 = the browser unsubscribed or the subscription expired —
        // clean it up so we stop trying. Any other error is logged but not
        // fatal; push is a best-effort channel, email/in-app already cover
        // the guaranteed-delivery requirement.
        if (err.statusCode === 404 || err.statusCode === 410) {
          await prisma.pushSubscription
            .delete({ where: { id: sub.id } })
            .catch(() => {});
        } else {
          console.error("Push send failed:", err.message);
        }
      }
    }),
  );
}

module.exports = {
  saveSubscription,
  removeSubscription,
  sendPush,
  ensureConfigured,
};
