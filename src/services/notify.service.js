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

/**
 * Notify the internal admin staff who should hear about an event that
 * requires admin attention (a new address-change request, a filed claim,
 * an SLA breach, an escalated ticket, etc).
 *
 * Several call sites used to write a comment like "// Notify admins" but
 * then created the Notification row with the *customer's* userId — so the
 * customer got a duplicate notification and no admin/SUPER_ADMIN ever saw
 * anything. This is the single place that actually resolves "which admins"
 * and fans a notification out to all of them.
 *
 * SUPER_ADMIN and LOGISTICS_MANAGER always qualify (full visibility). A
 * ROLE_ADMIN (custom staff role) only qualifies if `capability` is passed
 * and their AdminRolePermission has that flag set to true.
 *
 * @param {{type:string, title:string, body:string, data?:object, capability?:string}} params
 * @returns {Promise<string[]>} ids of the admin users notified
 */
async function notifyAdmins({ type, title, body, data = {}, capability = null }) {
  const { prisma } = require("../config/db");

  const admins = await prisma.user.findMany({
    where: {
      role: "ADMIN",
      isActive: true,
      OR: [
        { adminSubRole: { in: ["SUPER_ADMIN", "LOGISTICS_MANAGER"] } },
        ...(capability
          ? [
              {
                adminSubRole: "ROLE_ADMIN",
                rolePermission: { [capability]: true },
              },
            ]
          : []),
      ],
    },
    select: { id: true },
  });

  if (admins.length === 0) return [];

  await prisma.notification.createMany({
    data: admins.map((a) => ({ userId: a.id, type, title, body, data })),
  });

  // createMany doesn't return the created rows, and querying them back just
  // to deliver a socket/push event isn't worth the round trip — the socket
  // payload only needs to look like a notification, not carry a real id.
  const livePayload = { type, title, body, data, isRead: false, createdAt: new Date() };
  admins.forEach((a) => notify(a.id, livePayload));

  return admins.map((a) => a.id);
}

module.exports = { notify, notifyAdmins };
