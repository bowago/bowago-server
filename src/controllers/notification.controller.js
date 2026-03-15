const { prisma } = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { success, getPagination, buildMeta } = require('../utils/helpers');

async function listNotifications(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { unreadOnly } = req.query;

  const where = {
    userId: req.user.id,
    ...(unreadOnly === 'true' && { isRead: false }),
  };

  const [notifications, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where, skip, take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId: req.user.id, isRead: false } }),
  ]);

  return res.json({
    success: true,
    data: { notifications, unreadCount },
    meta: buildMeta(total, page, limit),
  });
}

async function markRead(req, res) {
  const { id } = req.params;

  if (id === 'all') {
    await prisma.notification.updateMany({
      where: { userId: req.user.id, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return success(res, {}, 'All notifications marked as read');
  }

  const notif = await prisma.notification.findFirst({
    where: { id, userId: req.user.id },
  });
  if (!notif) throw new ApiError(404, 'Notification not found');

  await prisma.notification.update({
    where: { id },
    data: { isRead: true, readAt: new Date() },
  });

  return success(res, {}, 'Notification marked as read');
}

async function deleteNotification(req, res) {
  const { id } = req.params;

  await prisma.notification.deleteMany({
    where: { id, userId: req.user.id },
  });

  return success(res, {}, 'Notification deleted');
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
    targets = users.map(u => u.id);
  }

  await prisma.notification.createMany({
    data: targets.map(userId => ({
      userId,
      type: type || 'SYSTEM',
      title,
      body,
    })),
  });

  return success(res, { sent: targets.length }, `Notification sent to ${targets.length} users`);
}

// Update FCM token
async function updateFcmToken(req, res) {
  const { fcmToken } = req.body;

  await prisma.user.update({
    where: { id: req.user.id },
    data: { fcmToken },
  });

  return success(res, {}, 'FCM token updated');
}

module.exports = {
  listNotifications,
  markRead,
  deleteNotification,
  broadcastNotification,
  updateFcmToken,
};
