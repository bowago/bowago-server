const { prisma } = require("../config/db");
const { ApiError } = require("../utils/ApiError");
const { success, getPagination, buildMeta } = require("../utils/helpers");
const pushService = require("../services/push.service");
const { notify } = require("../services/notify.service");

async function listNotifications(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { unreadOnly } = req.query;

  const where = {
    userId: req.user.id,
    ...(unreadOnly === "true" && { isRead: false }),
  };

  const [notifications, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({
      where: { userId: req.user.id, isRead: false },
    }),
  ]);

  return res.json({
    success: true,
    data: { notifications, unreadCount },
    meta: buildMeta(total, page, limit),
  });
}

async function markRead(req, res) {
  const { id } = req.params;

  if (id === "all") {
    await prisma.notification.updateMany({
      where: { userId: req.user.id, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return success(res, {}, "All notifications marked as read");
  }

  const notif = await prisma.notification.findFirst({
    where: { id, userId: req.user.id },
  });
  if (!notif) throw new ApiError(404, "Notification not found");

  await prisma.notification.update({
    where: { id },
    data: { isRead: true, readAt: new Date() },
  });

  return success(res, {}, "Notification marked as read");
}

async function deleteNotification(req, res) {
  const { id } = req.params;

  await prisma.notification.deleteMany({
    where: { id, userId: req.user.id },
  });

  return success(res, {}, "Notification deleted");
}

// ─── DELETE /notifications/bulk ───────────────────────────────────────────────
// Delete multiple notifications by id array, or all if ids not provided
async function bulkDeleteNotifications(req, res) {
  const { ids } = req.body; // array of ids, or omit to delete all

  if (ids && !Array.isArray(ids)) {
    throw new ApiError(400, '"ids" must be an array of notification IDs');
  }

  const where =
    ids && ids.length > 0
      ? { userId: req.user.id, id: { in: ids } }
      : { userId: req.user.id };

  const result = await prisma.notification.deleteMany({ where });

  return success(
    res,
    { deleted: result.count },
    `${result.count} notification(s) deleted`,
  );
}

// Admin: broadcast notification
async function broadcastNotification(req, res) {
  const { title, body, type, userIds } = req.body;

  let targets;
  if (userIds && userIds.length > 0) {
    targets = userIds;
  } else {
    const users = await prisma.user.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    targets = users.map((u) => u.id);
  }

  await prisma.notification.createMany({
    data: targets.map((userId) => ({
      userId,
      type: type || "SYSTEM",
      title,
      body,
    })),
  });

  return success(
    res,
    { sent: targets.length },
    `Notification sent to ${targets.length} users`,
  );
}

// Update FCM token
async function updateFcmToken(req, res) {
  const { fcmToken } = req.body;

  await prisma.user.update({
    where: { id: req.user.id },
    data: { fcmToken },
  });

  return success(res, {}, "FCM token updated");
}

// ─── GET /notifications/unread-count ─────────────────────────────────────────
async function getUnreadCount(req, res) {
  const userId = req.user.id;
  const count = await prisma.notification.count({
    where: { userId, isRead: false },
  });
  return success(res, { count });
}

// ─── PATCH /notifications/mark-all-read ──────────────────────────────────────
async function markAllRead(req, res) {
  const userId = req.user.id;
  await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  return success(res, {}, "All notifications marked as read");
}

// ─── GET /notifications/vapid-public-key ─────────────────────────────────────
// The frontend needs this to call pushManager.subscribe({applicationServerKey}).
// Returns null if push isn't configured yet (env vars unset) so the frontend
// can just skip offering the "enable push" toggle rather than erroring.
async function getVapidPublicKey(req, res) {
  return success(res, { publicKey: process.env.VAPID_PUBLIC_KEY || null });
}

// ─── POST /notifications/push-subscribe ──────────────────────────────────────
async function subscribeToPush(req, res) {
  const { subscription } = req.body;
  if (!subscription) throw new ApiError(400, "subscription is required");

  await pushService.saveSubscription(
    req.user.id,
    subscription,
    req.headers["user-agent"],
  );

  return success(res, {}, "Push notifications enabled");
}

// ─── DELETE /notifications/push-subscribe ────────────────────────────────────
async function unsubscribeFromPush(req, res) {
  const { endpoint } = req.body;
  if (!endpoint) throw new ApiError(400, "endpoint is required");

  await pushService.removeSubscription(endpoint);

  return success(res, {}, "Push notifications disabled");
}

module.exports = {
  listNotifications,
  markRead,
  deleteNotification,
  bulkDeleteNotifications,
  broadcastNotification,
  updateFcmToken,
  getUnreadCount,
  markAllRead,
  getVapidPublicKey,
  subscribeToPush,
  unsubscribeFromPush,
};
