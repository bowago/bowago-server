const { prisma } = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { success, created, getPagination, buildMeta } = require('../utils/helpers');

// Auto-assign logic based on category (Sprint 6)
async function autoAssignTicket(category) {
  const categoryAgentMap = {
    PAYMENT: 'LOGISTICS_MANAGER',
    PRICING_DISPUTE: 'LOGISTICS_MANAGER',
    TRACKING: 'LOGISTICS_MANAGER',
    DAMAGED_GOODS: 'LOGISTICS_MANAGER',
    DELIVERY_ISSUE: 'LOGISTICS_MANAGER',
    ACCOUNT: 'SUPER_ADMIN',
    OTHER: 'LOGISTICS_MANAGER',
  };

  const requiredSubRole = categoryAgentMap[category] || 'LOGISTICS_MANAGER';

  const agent = await prisma.user.findFirst({
    where: {
      role: 'ADMIN',
      adminSubRole: requiredSubRole,
      isActive: true,
    },
    orderBy: {
      // Assign to agent with fewest open tickets
      assignedTickets: { _count: 'asc' },
    },
  });

  return agent?.id || null;
}

function generateTicketNumber() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `TKT-${date}-${rand}`;
}

// ─── Customer: Create ticket ──────────────────────────────────────────────────
async function createTicket(req, res) {
  const { subject, category, shipmentId, body, priority } = req.body;

  const assignedToId = await autoAssignTicket(category);

  const ticket = await prisma.supportTicket.create({
    data: {
      ticketNumber: generateTicketNumber(),
      customerId: req.user.id,
      subject,
      category: category || 'OTHER',
      shipmentId,
      priority: priority || 'NORMAL',
      assignedToId,
      messages: {
        create: {
          senderId: req.user.id,
          body,
        },
      },
    },
    include: { messages: true },
  });

  // Notify assigned agent
  if (assignedToId) {
    await prisma.notification.create({
      data: {
        userId: assignedToId,
        type: 'SYSTEM',
        title: 'New Support Ticket',
        body: `Ticket ${ticket.ticketNumber} assigned to you: "${subject}"`,
        data: { ticketId: ticket.id },
      },
    });
  }

  return created(res, { ticket }, 'Support ticket created');
}

// ─── Customer: My tickets ─────────────────────────────────────────────────────
async function myTickets(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { status } = req.query;

  const where = {
    customerId: req.user.id,
    ...(status && { status }),
  };

  const [tickets, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      skip,
      take: limit,
      orderBy: { updatedAt: 'desc' },
      include: {
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        assignedTo: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.supportTicket.count({ where }),
  ]);

  return res.json({ success: true, data: { tickets }, meta: buildMeta(total, page, limit) });
}

// ─── Get single ticket with full thread ──────────────────────────────────────
async function getTicket(req, res) {
  const { id } = req.params;

  const ticket = await prisma.supportTicket.findUnique({
    where: { id },
    include: {
      messages: {
        where: req.user.role === 'CUSTOMER' ? { isInternal: false } : {},
        orderBy: { createdAt: 'asc' },
      },
      customer: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
      assignedTo: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  if (!ticket) throw new ApiError(404, 'Ticket not found');

  if (req.user.role === 'CUSTOMER' && ticket.customerId !== req.user.id) {
    throw new ApiError(403, 'Access denied');
  }

  // Sprint 6: Customer context card — last 5 shipments of this customer
  let customerContext = null;
  if (req.user.role === 'ADMIN') {
    const [recentShipments, recentPayments] = await Promise.all([
      prisma.shipment.findMany({
        where: { customerId: ticket.customerId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { trackingNumber: true, status: true, quotedPrice: true, createdAt: true },
      }),
      prisma.payment.findMany({
        where: { userId: ticket.customerId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { reference: true, amountKobo: true, status: true, paidAt: true },
      }),
    ]);
    customerContext = { recentShipments, recentPayments };
  }

  return success(res, { ticket, customerContext });
}

// ─── Reply to ticket ──────────────────────────────────────────────────────────
async function replyToTicket(req, res) {
  const { id } = req.params;
  const { body, isInternal } = req.body;

  const ticket = await prisma.supportTicket.findUnique({ where: { id } });
  if (!ticket) throw new ApiError(404, 'Ticket not found');

  if (req.user.role === 'CUSTOMER' && ticket.customerId !== req.user.id) {
    throw new ApiError(403, 'Access denied');
  }

  if (ticket.status === 'CLOSED') {
    throw new ApiError(400, 'Cannot reply to a closed ticket');
  }

  const message = await prisma.ticketMessage.create({
    data: {
      ticketId: id,
      senderId: req.user.id,
      body,
      isInternal: req.user.role === 'ADMIN' && isInternal ? true : false,
    },
  });

  // Update ticket status
  const newStatus = req.user.role === 'ADMIN' ? 'IN_PROGRESS' : 'OPEN';
  await prisma.supportTicket.update({
    where: { id },
    data: { status: newStatus, updatedAt: new Date() },
  });

  // Notify the other party
  const notifyUserId = req.user.role === 'ADMIN' ? ticket.customerId : ticket.assignedToId;
  if (notifyUserId && !isInternal) {
    await prisma.notification.create({
      data: {
        userId: notifyUserId,
        type: 'SYSTEM',
        title: `Reply on ticket ${ticket.ticketNumber}`,
        body: body.slice(0, 100),
        data: { ticketId: id },
      },
    });
  }

  return created(res, { message }, 'Reply sent');
}

// ─── Admin: List all tickets ──────────────────────────────────────────────────
async function listTickets(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { status, category, assignedTo, priority } = req.query;

  const where = {
    ...(status && { status }),
    ...(category && { category }),
    ...(assignedTo && { assignedToId: assignedTo }),
    ...(priority && { priority }),
  };

  const [tickets, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      skip,
      take: limit,
      orderBy: { updatedAt: 'desc' },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, email: true } },
        assignedTo: { select: { id: true, firstName: true, lastName: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    }),
    prisma.supportTicket.count({ where }),
  ]);

  return res.json({ success: true, data: { tickets }, meta: buildMeta(total, page, limit) });
}

// ─── Admin: Update ticket status / assign ────────────────────────────────────
async function updateTicket(req, res) {
  const { id } = req.params;
  const { status, assignedToId, priority } = req.body;

  const ticket = await prisma.supportTicket.update({
    where: { id },
    data: {
      ...(status && { status }),
      ...(assignedToId && { assignedToId }),
      ...(priority && { priority }),
      ...(status === 'RESOLVED' && { resolvedAt: new Date() }),
      ...(status === 'CLOSED' && { closedAt: new Date() }),
    },
    include: {
      customer: { select: { id: true, firstName: true, email: true } },
    },
  });

  if (status === 'RESOLVED') {
    await prisma.notification.create({
      data: {
        userId: ticket.customerId,
        type: 'SYSTEM',
        title: 'Ticket Resolved',
        body: `Your support ticket ${ticket.ticketNumber} has been resolved.`,
        data: { ticketId: id },
      },
    });
  }

  return success(res, { ticket }, 'Ticket updated');
}

// ─── Canned responses (Sprint 6) ─────────────────────────────────────────────
async function listCannedResponses(req, res) {
  const { category } = req.query;
  const responses = await prisma.cannedResponse.findMany({
    where: {
      isActive: true,
      ...(category && { category }),
    },
    orderBy: { title: 'asc' },
  });
  return success(res, { responses });
}

async function createCannedResponse(req, res) {
  const { title, body, category } = req.body;
  const response = await prisma.cannedResponse.create({
    data: { title, body, category, createdBy: req.user.id },
  });
  return created(res, { response }, 'Canned response created');
}

async function updateCannedResponse(req, res) {
  const { id } = req.params;
  const response = await prisma.cannedResponse.update({
    where: { id },
    data: req.body,
  });
  return success(res, { response }, 'Canned response updated');
}

async function deleteCannedResponse(req, res) {
  const { id } = req.params;
  await prisma.cannedResponse.delete({ where: { id } });
  return success(res, {}, 'Canned response deleted');
}

module.exports = {
  createTicket,
  myTickets,
  getTicket,
  replyToTicket,
  listTickets,
  updateTicket,
  listCannedResponses,
  createCannedResponse,
  updateCannedResponse,
  deleteCannedResponse,
};
