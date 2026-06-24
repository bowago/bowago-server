/**
 * Socket.IO — Real-Time Tracking Service
 * Sprint 4: PRD spec — WebSocket live update every 10 sec; fallback to polling (5 sec).
 *
 * Rooms:
 *   tracking:{trackingNumber}  — guest/public tracking page joins this room
 *   user:{userId}              — authenticated user joins their personal room
 *
 * Events emitted to clients:
 *   shipment:update  — { trackingNumber, status, currentLocation, timeline, eta }
 *   notification:new — { id, title, body, type, createdAt }   (to user room)
 */

let _io = null;

/**
 * Initialize Socket.IO server attached to the HTTP server.
 * Called once from server.js.
 * @param {import('http').Server} httpServer
 */
function init(httpServer) {
  const { Server } = require('socket.io');

  _io = new Server(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN || '*',
      methods: ['GET', 'POST'],
    },
    // Fallback: if WS transport fails, drop back to polling
    transports: ['websocket', 'polling'],
  });

  _io.on('connection', (socket) => {
    // ─── Guest: join a public tracking room ─────────────────────────────────
    socket.on('track:join', (trackingNumber) => {
      if (trackingNumber && typeof trackingNumber === 'string') {
        const room = `tracking:${trackingNumber.toUpperCase()}`;
        socket.join(room);
        socket.emit('track:joined', { room, trackingNumber });
      }
    });

    socket.on('track:leave', (trackingNumber) => {
      if (trackingNumber) {
        socket.leave(`tracking:${trackingNumber.toUpperCase()}`);
      }
    });

    // ─── Authenticated user: join personal room ──────────────────────────────
    socket.on('user:join', (userId) => {
      if (userId && typeof userId === 'string') {
        socket.join(`user:${userId}`);
      }
    });

    socket.on('disconnect', () => {
      // Socket.IO auto-removes from rooms on disconnect
    });
  });

  return _io;
}

/**
 * Emit a shipment status update to the tracking room for that shipment.
 * Called from shipment.controller.js whenever status changes.
 *
 * @param {object} shipment  Prisma shipment record
 * @param {Array}  timeline  Array of TrackingEvent records
 */
function emitShipmentUpdate(shipment, timeline = []) {
  if (!_io) return;

  const room = `tracking:${shipment.trackingNumber}`;

  // PRD: address masking for public room (non-logged-in guests only see city/state)
  const payload = {
    trackingNumber: shipment.trackingNumber,
    status:         shipment.status,
    serviceType:    shipment.serviceType,
    estimatedDelivery: shipment.estimatedDelivery,
    // Masked location — full address hidden from public room
    currentLocation: shipment.recipientState
      ? `${shipment.recipientCity}, ${shipment.recipientState}`
      : shipment.recipientCity || null,
    timeline: timeline.map((e) => ({
      status:      e.status,
      description: e.description,
      location:    e.location || null,
      timestamp:   e.createdAt,
    })),
    updatedAt: shipment.updatedAt,
  };

  _io.to(room).emit('shipment:update', payload);

  // Also emit to the owner's personal room (full unmasked payload)
  if (shipment.customerId) {
    _io.to(`user:${shipment.customerId}`).emit('shipment:update', {
      ...payload,
      currentLocation: shipment.recipientAddress
        ? `${shipment.recipientAddress}, ${shipment.recipientCity}, ${shipment.recipientState}`
        : payload.currentLocation,
    });
  }
}

/**
 * Emit an in-app notification to a specific user's personal room.
 * Called from any controller that creates a Notification record.
 *
 * @param {string} userId
 * @param {object} notification  Prisma notification record
 */
function emitNotification(userId, notification) {
  if (!_io || !userId) return;
  _io.to(`user:${userId}`).emit('notification:new', {
    id:        notification.id,
    type:      notification.type,
    title:     notification.title,
    body:      notification.body,
    data:      notification.data || null,
    isRead:    notification.isRead,
    createdAt: notification.createdAt,
  });
}

/**
 * Get the Socket.IO instance (after init).
 * @returns {import('socket.io').Server|null}
 */
function getIO() {
  return _io;
}

module.exports = { init, emitShipmentUpdate, emitNotification, getIO };
