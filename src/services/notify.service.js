const socketService = require("./socket.service");
const pushService = require("./push.service");

/**
 * @param {string} userId
 * @param {{id:string, type:string, title:string, body:string, data?:object, isRead?:boolean, createdAt:Date}} notification
 *   A Prisma Notification record (or shape-compatible object).
 */
async function notify(userId, notification) {
  if (!userId || !notification) return;

  // Socket delivery is synchronous/local — never let a push failure block it.
  socketService.emitNotification(userId, notification);

  // Push is best-effort and network-bound; don't let it throw into the
  // caller's request (it already never throws internally, but this is a
  // second layer of safety since callers treat this as fire-and-forget).
  try {
    await pushService.sendPush(userId, {
      title: notification.title,
      body: notification.body,
      data: notification.data || {},
    });
  } catch (err) {
    console.error("Push notification dispatch failed:", err.message);
  }
}

module.exports = { notify };
