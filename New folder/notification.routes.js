const router = require('express').Router();
const notifController = require('../controllers/notification.controller');
const { authenticate, requireAdmin } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Notifications
 *   description: In-app notifications and FCM push token registration
 */

router.use(authenticate);

/**
 * @swagger
 * /notifications:
 *   get:
 *     summary: Get my notifications
 *     tags: [Notifications]
 *     description: Returns paginated notifications for the authenticated user, with the current unread count.
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: unreadOnly
 *         schema: { type: boolean }
 *         description: Pass true to return only unread notifications
 *     responses:
 *       200:
 *         description: Notifications returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     notifications:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Notification'
 *                     unreadCount: { type: integer, example: 3 }
 *                 meta:
 *                   $ref: '#/components/schemas/PaginationMeta'
 *       401:
 *         description: Unauthorized
 */
router.get('/', notifController.listNotifications);

/**
 * @swagger
 * /notifications/{id}/read:
 *   patch:
 *     summary: Mark notification(s) as read
 *     tags: [Notifications]
 *     description: Pass a notification ID to mark one as read, or pass the literal string "all" to mark every unread notification as read.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Notification UUID, or the literal string "all"
 *         example: all
 *     responses:
 *       200:
 *         description: Notification(s) marked as read
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       404:
 *         description: Notification not found
 *       401:
 *         description: Unauthorized
 */
router.patch('/:id/read', notifController.markRead);

/**
 * @swagger
 * /notifications/{id}:
 *   delete:
 *     summary: Delete a notification
 *     tags: [Notifications]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Notification deleted
 *       401:
 *         description: Unauthorized
 */
router.delete('/:id', notifController.deleteNotification);

/**
 * @swagger
 * /notifications/fcm-token:
 *   post:
 *     summary: Register device push token
 *     tags: [Notifications]
 *     description: Saves the FCM / Expo push token for the current device. Call this after login and whenever the push token refreshes.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fcmToken]
 *             properties:
 *               fcmToken:
 *                 type: string
 *                 description: Firebase Cloud Messaging or Expo push notification token
 *                 example: "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"
 *     responses:
 *       200:
 *         description: Push token saved
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       401:
 *         description: Unauthorized
 */
router.post('/fcm-token', notifController.updateFcmToken);

/**
 * @swagger
 * /notifications/broadcast:
 *   post:
 *     summary: Broadcast a notification to users (Admin)
 *     tags: [Notifications]
 *     description: Sends an in-app notification to all active users, or to a specific subset by userIds.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, body]
 *             properties:
 *               title:
 *                 type: string
 *                 example: "BowaGO Maintenance Notice"
 *               body:
 *                 type: string
 *                 example: "The app will be under maintenance on Sunday 2am–4am WAT."
 *               type:
 *                 type: string
 *                 enum: [SHIPMENT_UPDATE, PAYMENT, PROMO, SYSTEM]
 *                 default: SYSTEM
 *               userIds:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *                 description: Optional — if omitted, sends to all active users
 *     responses:
 *       200:
 *         description: Notification broadcast successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     sent: { type: integer, example: 520 }
 *       403:
 *         description: Admin access required
 */
router.post('/broadcast', requireAdmin, notifController.broadcastNotification);

module.exports = router;
