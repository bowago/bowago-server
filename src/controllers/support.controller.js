const { prisma } = require("../config/db");
const socketService = require("../services/socket.service");
const { notify } = require("../services/notify.service");
const { ApiError } = require("../utils/ApiError");
const { assertOwnedResourceAccess } = require("../utils/access");
const {
  success,
  created,
  getPagination,
  buildMeta,
} = require("../utils/helpers");

async function autoAssignTicket(category) {
  const categoryCapabilityMap = {
    PAYMENT: "canManageInvoices",
    PRICING_DISPUTE: "canManageInvoices",
    TRACKING: "canManageShipments",
    DAMAGED_GOODS: "canManageTickets",
    DELIVERY_ISSUE: "canManageShipments",
    ACCOUNT: "canManageTickets",
    OTHER: "canManageTickets",
  };

  const requiredCapability =
    categoryCapabilityMap[category] || "canManageTickets";

  const agent = await prisma.user.findFirst({
    where: {
      role: "ADMIN",
      adminSubRole: "ROLE_ADMIN",
      isActive: true,
      rolePermission: { [requiredCapability]: true },
    },
    orderBy: {
      // Assign to agent with fewest open tickets
      assignedTickets: { _count: "asc" },
    },
  });

  return agent?.id || null;
}

function generateTicketNumber() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `TKT-${date}-${rand}`;
}

// ─── Customer: Create ticket ──────────────────────────────────────────────────
async function createTicket(req, res) {
  const { subject, category, shipmentId, trackingNumber, body } = req.body;
  // Priority is admin-controlled only — customers always start at NORMAL

  // Resolve shipmentId from trackingNumber if provided
  let resolvedShipmentId = shipmentId || null;
  if (!resolvedShipmentId && trackingNumber) {
    const shipment = await prisma.shipment.findUnique({
      where: { trackingNumber: trackingNumber.trim().toUpperCase() },
      select: { id: true, customerId: true },
    });
    if (!shipment)
      throw new ApiError(
        404,
        `No shipment found with tracking number "${trackingNumber}"`,
      );
    // Ticket can only reference a shipment the caller may access
    // (own shipment, or same Enterprise tenant). Admins bypass.
    await assertOwnedResourceAccess(req.user, shipment.customerId, {
      resource: "Shipment",
      resourceId: shipment.id,
      req,
      message: "You can only raise tickets for your own shipments",
    });
    resolvedShipmentId = shipment.id;
  }

  const assignedToId = await autoAssignTicket(category);

  const ticket = await prisma.supportTicket.create({
    data: {
      ticketNumber: generateTicketNumber(),
      customerId: req.user.id,
      subject,
      category: category || "OTHER",
      shipmentId: resolvedShipmentId,
      priority: "NORMAL", // always NORMAL on creation; admin escalates if needed
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
    const assignNotification = await prisma.notification.create({
      data: {
        userId: assignedToId,
        type: "SYSTEM",
        title: "New Support Ticket",
        body: `Ticket ${ticket.ticketNumber} assigned to you: "${subject}"`,
        data: { ticketId: ticket.id },
      },
    });
    notify(assignedToId, assignNotification);
  }

  return created(res, { ticket }, "Support ticket created");
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
      orderBy: { updatedAt: "desc" },
      include: {
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
        assignedTo: { select: { firstName: true, lastName: true } },
        shipment: { select: { trackingNumber: true } },
      },
    }),
    prisma.supportTicket.count({ where }),
  ]);

  const flattened = tickets.map((t) => ({
    ...t,
    trackingNumber: t.shipment?.trackingNumber ?? null,
  }));

  return res.json({
    success: true,
    data: { tickets: flattened },
    meta: buildMeta(total, page, limit),
  });
}

// ─── Get single ticket with full thread ──────────────────────────────────────
async function getTicket(req, res) {
  const { id } = req.params;

  const ticket = await prisma.supportTicket.findUnique({
    where: { id },
    include: {
      messages: {
        // Internal agent notes are visible ONLY to internal ADMIN staff —
        // never to customers or Enterprise tenant users.
        where: req.user.role === "ADMIN" ? {} : { isInternal: false },
        orderBy: { createdAt: "asc" },
      },
      customer: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
        },
      },
      assignedTo: { select: { id: true, firstName: true, lastName: true } },
      shipment: { select: { trackingNumber: true, status: true } },
    },
  });

  if (!ticket) throw new ApiError(404, "Ticket not found");

  await assertOwnedResourceAccess(req.user, ticket.customerId, {
    resource: "SupportTicket",
    resourceId: ticket.id,
    req,
  });

  const flatTicket = {
    ...ticket,
    username: ticket.customer
      ? `${ticket.customer.firstName} ${ticket.customer.lastName}`.trim()
      : undefined,
    email: ticket.customer?.email,
    trackingNumber: ticket.shipment?.trackingNumber ?? null,
  };

  // Sprint 6: Customer context card — last 5 shipments of this customer
  let customerContext = null;
  if (req.user.role === "ADMIN") {
    const [recentShipments, recentPayments] = await Promise.all([
      prisma.shipment.findMany({
        where: { customerId: ticket.customerId },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          trackingNumber: true,
          status: true,
          quotedPrice: true,
          createdAt: true,
        },
      }),
      prisma.payment.findMany({
        where: { userId: ticket.customerId },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          reference: true,
          amountKobo: true,
          status: true,
          paidAt: true,
        },
      }),
    ]);
    customerContext = { recentShipments, recentPayments };
  }

  return success(res, { ticket: flatTicket, customerContext });
}

// ─── Reply to ticket ──────────────────────────────────────────────────────────
async function replyToTicket(req, res) {
  const { id } = req.params;
  const { body, isInternal } = req.body;

  const ticket = await prisma.supportTicket.findUnique({ where: { id } });
  if (!ticket) throw new ApiError(404, "Ticket not found");

  await assertOwnedResourceAccess(req.user, ticket.customerId, {
    resource: "SupportTicket",
    resourceId: ticket.id,
    req,
  });

  if (ticket.status === "CLOSED") {
    throw new ApiError(400, "Cannot reply to a closed ticket");
  }

  const message = await prisma.ticketMessage.create({
    data: {
      ticketId: id,
      senderId: req.user.id,
      body,
      isInternal: req.user.role === "ADMIN" && isInternal ? true : false,
    },
  });

  // Update ticket status
  const newStatus = req.user.role === "ADMIN" ? "IN_PROGRESS" : "OPEN";
  await prisma.supportTicket.update({
    where: { id },
    data: { status: newStatus, updatedAt: new Date() },
  });

  // Notify the other party
  const notifyUserId =
    req.user.role === "ADMIN" ? ticket.customerId : ticket.assignedToId;
  if (notifyUserId && !isInternal) {
    const replyNotification = await prisma.notification.create({
      data: {
        userId: notifyUserId,
        type: "SYSTEM",
        title: `Reply on ticket ${ticket.ticketNumber}`,
        body: body.slice(0, 100),
        data: { ticketId: id },
      },
    });
    notify(notifyUserId, replyNotification);
  }

  // Sprint 6: Real-time — push new message to everyone in the ticket room
  socketService.emitTicketMessage(id, message, {
    id: req.user.id,
    firstName: req.user.firstName,
    lastName: req.user.lastName,
    role: req.user.role,
  });

  return created(res, { message }, "Reply sent");
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
      orderBy: { updatedAt: "desc" },
      include: {
        customer: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        assignedTo: { select: { id: true, firstName: true, lastName: true } },
        shipment: { select: { trackingNumber: true } },
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    }),
    prisma.supportTicket.count({ where }),
  ]);

  // FIX: frontend (TicketColumns) expects flat `username`/`email`/`trackingNumber`
  // fields. The backend was only ever returning the raw `shipmentId` (no
  // relation existed to resolve it into a trackingNumber) and a nested
  // `customer` object the table never read — so "User" and "Tracking No."
  // always rendered blank. Flattening here is the lowest-risk fix.
  const flattened = tickets.map((t) => ({
    ...t,
    username: t.customer
      ? `${t.customer.firstName} ${t.customer.lastName}`.trim()
      : undefined,
    email: t.customer?.email,
    trackingNumber: t.shipment?.trackingNumber ?? null,
  }));

  return res.json({
    success: true,
    data: { tickets: flattened },
    meta: buildMeta(total, page, limit),
  });
}

// ─── Admin: Update ticket status / assign ────────────────────────────────────
async function updateTicket(req, res) {
  const { id } = req.params;
  const { status, assignedToId, priority } = req.body;

  const existing = await prisma.supportTicket.findUnique({
    where: { id },
    select: { assignedToId: true },
  });
  if (!existing) throw new ApiError(404, "Ticket not found");

  // If an admin resolves/updates a ticket that was never explicitly
  // assigned to anyone, auto-assign it to them. Without this, the ticket's
  // assignedToId stays null forever, and getAgentKpi's aggregation query
  // only counts tickets with assignedToId set — so a resolved-but-unassigned
  // ticket silently never appears in ANY agent's KPI stats, which looks
  // exactly like "the dashboard isn't updating" even though the underlying
  // resolution was recorded correctly.
  const effectiveAssignedToId =
    assignedToId ||
    existing.assignedToId ||
    (req.user.role === "ADMIN" ? req.user.id : undefined);

  const ticket = await prisma.supportTicket.update({
    where: { id },
    data: {
      ...(status && { status }),
      ...(effectiveAssignedToId && { assignedToId: effectiveAssignedToId }),
      ...(priority && { priority }),
      ...(status === "RESOLVED" && { resolvedAt: new Date() }),
      ...(status === "CLOSED" && { closedAt: new Date() }),
    },
    include: {
      customer: { select: { id: true, firstName: true, email: true } },
    },
  });

  if (status === "RESOLVED") {
    const resolvedNotification = await prisma.notification.create({
      data: {
        userId: ticket.customerId,
        type: "SYSTEM",
        title: "Ticket Resolved",
        body: `Your support ticket ${ticket.ticketNumber} has been resolved.`,
        data: { ticketId: id },
      },
    });
    notify(ticket.customerId, resolvedNotification);
  }

  // Sprint 6: Real-time — notify ticket room of status/assignment changes
  socketService.emitTicketUpdate(id, { status, assignedToId, priority });

  return success(res, { ticket }, "Ticket updated");
}

// ─── Canned responses (Sprint 6) ─────────────────────────────────────────────
async function listCannedResponses(req, res) {
  const { category } = req.query;
  const responses = await prisma.cannedResponse.findMany({
    where: {
      isActive: true,
      ...(category && { category }),
    },
    orderBy: { title: "asc" },
  });
  return success(res, { responses });
}

async function createCannedResponse(req, res) {
  const { title, body, category } = req.body;
  const response = await prisma.cannedResponse.create({
    data: { title, body, category, createdBy: req.user.id },
  });
  return created(res, { response }, "Canned response created");
}

async function updateCannedResponse(req, res) {
  const { id } = req.params;
  const response = await prisma.cannedResponse.update({
    where: { id },
    data: req.body,
  });
  return success(res, { response }, "Canned response updated");
}

async function deleteCannedResponse(req, res) {
  const { id } = req.params;
  await prisma.cannedResponse.delete({ where: { id } });
  return success(res, {}, "Canned response deleted");
}

// ─── Sprint 6: Agent KPI Dashboard ───────────────────────────────────────────
// Returns per-agent metrics: response time, resolution time, CSAT, volume, re-open rate.
// Internal CS agents (ROLE_ADMIN with canManageTickets but NOT canViewAnalytics)
// see only their own metrics. SUPER_ADMIN/LOGISTICS_MANAGER/ROLE_ADMIN with
// canViewAnalytics see all agents. (Route guard only requires canManageTickets
// to enter; this function decides the scope.)
async function getAgentKpi(req, res) {
  const { from, to, agentId, format } = req.query;

  const fromDate = from
    ? new Date(from)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const toDate = to ? new Date(to) : new Date();

  // Determine whether this internal staff member can see everyone's data.
  let canViewAllAgents = ["SUPER_ADMIN", "LOGISTICS_MANAGER"].includes(
    req.user.adminSubRole,
  );
  if (!canViewAllAgents && req.user.adminSubRole === "ROLE_ADMIN") {
    const perm = await prisma.adminRolePermission.findUnique({
      where: { userId: req.user.id },
    });
    canViewAllAgents = !!perm?.canViewAnalytics;
  }

  // Everyone else (rank-and-file support agents) only see their own data
  const scopedAgentId = canViewAllAgents ? agentId || undefined : req.user.id;

  const ticketWhere = {
    createdAt: { gte: fromDate, lte: toDate },
    assignedToId: scopedAgentId ? scopedAgentId : { not: null },
  };

  const tickets = await prisma.supportTicket.findMany({
    where: ticketWhere,
    include: {
      messages: { orderBy: { createdAt: "asc" } },
      assignedTo: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const agentMap = {};

  for (const ticket of tickets) {
    const aid = ticket.assignedToId;
    if (!aid) continue;
    if (!agentMap[aid]) {
      agentMap[aid] = {
        agentId: aid,
        agentName: ticket.assignedTo
          ? `${ticket.assignedTo.firstName} ${ticket.assignedTo.lastName}`
          : "Unknown",
        totalTickets: 0,
        resolved: 0,
        firstResponseMs: [],
        resolutionMs: [],
        csatScores: [],
        reopened: 0,
        escalated: 0,
        dailyVolume: {}, // { 'YYYY-MM-DD': count }
      };
    }

    const a = agentMap[aid];
    a.totalTickets++;

    // Daily volume
    const dayKey = new Date(ticket.createdAt).toISOString().slice(0, 10);
    a.dailyVolume[dayKey] = (a.dailyVolume[dayKey] || 0) + 1;

    if (["RESOLVED", "CLOSED"].includes(ticket.status)) a.resolved++;
    if (ticket.status === "ESCALATED") a.escalated++;

    // Re-open: any ticket that was previously RESOLVED/CLOSED but is now OPEN/IN_PROGRESS
    if (ticket.status === "OPEN" || ticket.status === "IN_PROGRESS") {
      const hasResolutionMessage = ticket.messages.some(
        (m) => m.body?.toLowerCase().includes("resolved") || m.isInternal,
      );
      // Simpler heuristic: if resolvedAt is set but ticket is open again → reopened
      if (ticket.resolvedAt) a.reopened++;
    }

    // First response time (ticket created → first AGENT message, not customer)
    const firstAgentMsg = ticket.messages.find(
      (m) => m.senderId !== ticket.customerId,
    );
    if (firstAgentMsg) {
      const ms =
        new Date(firstAgentMsg.createdAt).getTime() -
        new Date(ticket.createdAt).getTime();
      if (ms > 0) a.firstResponseMs.push(ms);
    }

    // Resolution time
    if (ticket.resolvedAt) {
      const ms =
        new Date(ticket.resolvedAt).getTime() -
        new Date(ticket.createdAt).getTime();
      if (ms > 0) a.resolutionMs.push(ms);
    }

    // CSAT
    if (ticket.csatScore != null) a.csatScores.push(ticket.csatScore);
  }

  const avg = (arr) =>
    arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  const msToMin = (ms) => (ms != null ? Math.round(ms / 60000) : null);

  const kpi = Object.values(agentMap).map((a) => {
    const avgFirstMs = avg(a.firstResponseMs);
    const avgResMs = avg(a.resolutionMs);
    return {
      agentId: a.agentId,
      agentName: a.agentName,
      totalTickets: a.totalTickets,
      resolvedTickets: a.resolved,
      escalatedTickets: a.escalated,
      reopenedTickets: a.reopened,
      resolutionRate:
        a.totalTickets > 0
          ? Math.round((a.resolved / a.totalTickets) * 100)
          : 0,
      reopenRate:
        a.resolved > 0 ? Math.round((a.reopened / a.resolved) * 100) : 0,
      avgFirstResponseMinutes: msToMin(avgFirstMs),
      avgResolutionMinutes: msToMin(avgResMs),
      // Flag if over-SLA
      firstResponseSlaBreached:
        avgFirstMs != null && avgFirstMs > 60 * 60 * 1000, // > 1h
      resolutionSlaBreached: avgResMs != null && avgResMs > 2 * 60 * 60 * 1000, // > 2h
      avgCsatScore: a.csatScores.length
        ? Math.round(avg(a.csatScores) * 10) / 10
        : null,
      csatResponses: a.csatScores.length,
      // Volume: array sorted by date for sparkline
      dailyVolume: Object.entries(a.dailyVolume)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, count]) => ({ date, count })),
    };
  });

  const team = {
    totalTickets: tickets.length,
    totalResolved: tickets.filter((t) =>
      ["RESOLVED", "CLOSED"].includes(t.status),
    ).length,
    totalEscalated: tickets.filter((t) => t.status === "ESCALATED").length,
    totalReopened: tickets.filter(
      (t) => t.resolvedAt && ["OPEN", "IN_PROGRESS"].includes(t.status),
    ).length,
    slaAdherencePercent:
      tickets.length > 0
        ? Math.round(
            (tickets.filter((t) => t.status !== "ESCALATED").length /
              tickets.length) *
              100,
          )
        : 100,
    period: { from: fromDate, to: toDate },
  };

  // CSV export
  if (format === "csv") {
    const headers = [
      "Agent",
      "Total Tickets",
      "Resolved",
      "Resolution Rate %",
      "Escalated",
      "Reopened",
      "Reopen Rate %",
      "Avg First Response (min)",
      "Avg Resolution (min)",
      "Avg CSAT",
      "CSAT Responses",
    ];
    const rows = kpi.map((a) => [
      a.agentName,
      a.totalTickets,
      a.resolvedTickets,
      a.resolutionRate,
      a.escalatedTickets,
      a.reopenedTickets,
      a.reopenRate,
      a.avgFirstResponseMinutes ?? "",
      a.avgResolutionMinutes ?? "",
      a.avgCsatScore ?? "",
      a.csatResponses,
    ]);
    const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="agent-kpi-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    return res.send(csv);
  }

  return success(
    res,
    { kpi, team, isSelfScoped: !canViewAllAgents },
    "Agent KPI report",
  );
}

// ─── Sprint 6: Ticket Escalation Job ─────────────────────────────────────────
// PRD: Tickets unresolved > 4 hours → auto-escalate with alert to team lead.
// Call this function from a cron or setInterval in server.js.
async function runEscalationJob() {
  const FOUR_HOURS_AGO = new Date(Date.now() - 4 * 60 * 60 * 1000);

  const stale = await prisma.supportTicket.findMany({
    where: {
      status: "IN_PROGRESS",
      createdAt: { lt: FOUR_HOURS_AGO },
      // Only escalate once — skip already-escalated
    },
    include: {
      customer: { select: { firstName: true, lastName: true, email: true } },
      assignedTo: { select: { firstName: true, lastName: true } },
    },
  });

  if (stale.length === 0) return { escalated: 0 };

  // Find a SUPER_ADMIN / LOGISTICS_MANAGER to notify
  const teamLead = await prisma.user.findFirst({
    where: {
      role: "ADMIN",
      adminSubRole: { in: ["SUPER_ADMIN", "LOGISTICS_MANAGER"] },
      isActive: true,
    },
  });

  let escalated = 0;

  for (const ticket of stale) {
    try {
      await prisma.supportTicket.update({
        where: { id: ticket.id },
        data: { status: "ESCALATED" },
      });

      // Notify team lead in-app
      if (teamLead) {
        const escalationNotification = await prisma.notification.create({
          data: {
            userId: teamLead.id,
            type: "SYSTEM",
            title: `🚨 Ticket Escalated: ${ticket.ticketNumber}`,
            body: `Ticket "${ticket.subject}" has been unresolved for over 4 hours. Assigned to: ${ticket.assignedTo ? `${ticket.assignedTo.firstName} ${ticket.assignedTo.lastName}` : "Unassigned"}.`,
            data: { ticketId: ticket.id, ticketNumber: ticket.ticketNumber },
          },
        });
        notify(teamLead.id, escalationNotification);
      }

      escalated++;
    } catch (err) {
      console.error(`Escalation failed for ticket ${ticket.id}:`, err.message);
    }
  }

  return { escalated };
}

// ─── Sprint 6: Customer CSAT submission ──────────────────────────────────────
// Customer rates the resolved ticket (1–5). Can only submit once.
async function submitCsat(req, res) {
  const { id } = req.params;
  const { score } = req.body;

  if (!score || score < 1 || score > 5) {
    throw new ApiError(400, "score must be an integer between 1 and 5");
  }

  const ticket = await prisma.supportTicket.findFirst({
    where: { id, customerId: req.user.id },
  });
  if (!ticket) throw new ApiError(404, "Ticket not found");
  if (!["RESOLVED", "CLOSED"].includes(ticket.status)) {
    throw new ApiError(400, "CSAT can only be submitted for resolved tickets");
  }
  if (ticket.csatScore != null) {
    throw new ApiError(
      409,
      "You have already submitted a rating for this ticket",
    );
  }

  await prisma.supportTicket.update({
    where: { id },
    data: { csatScore: parseInt(score, 10) },
  });

  return success(res, {}, "Thank you for your feedback!");
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
  getAgentKpi,
  runEscalationJob,
  submitCsat,
};
