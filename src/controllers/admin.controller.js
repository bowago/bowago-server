const { prisma } = require('../config/db');
const { success } = require('../utils/helpers');

// Dashboard summary stats
async function getDashboardStats(req, res) {
  const [
    totalUsers,
    totalCustomers,
    totalAdmins,
    totalShipments,
    pendingShipments,
    deliveredShipments,
    totalRevenue,
  ] = await Promise.all([
    prisma.user.count({ where: { isActive: true } }),
    prisma.user.count({ where: { role: 'CUSTOMER', isActive: true } }),
    prisma.user.count({ where: { role: 'ADMIN', isActive: true } }),
    prisma.shipment.count(),
    prisma.shipment.count({ where: { status: 'PENDING' } }),
    prisma.shipment.count({ where: { status: 'DELIVERED' } }),
    prisma.shipment.aggregate({
      where: { paymentStatus: 'PAID' },
      _sum: { quotedPrice: true },
    }),
  ]);

  // Recent 30-day trend
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentShipments = await prisma.shipment.groupBy({
    by: ['status'],
    where: { createdAt: { gte: thirtyDaysAgo } },
    _count: { _all: true },
  });

  return success(res, {
    users: { total: totalUsers, customers: totalCustomers, admins: totalAdmins },
    shipments: {
      total: totalShipments,
      pending: pendingShipments,
      delivered: deliveredShipments,
      last30Days: recentShipments,
    },
    revenue: {
      total: totalRevenue._sum.quotedPrice || 0,
      currency: 'NGN',
    },
  });
}

// App settings CRUD
async function getSettings(req, res) {
  const { group } = req.query;
  const settings = await prisma.appSettings.findMany({
    where: group ? { group } : {},
    orderBy: [{ group: 'asc' }, { key: 'asc' }],
  });
  const settingsMap = settings.reduce((acc, s) => {
    acc[s.key] = { value: s.value, type: s.type, group: s.group };
    return acc;
  }, {});
  return success(res, { settings: settingsMap });
}

async function updateSetting(req, res) {
  const { key, value, type, group } = req.body;

  const setting = await prisma.appSettings.upsert({
    where: { key },
    update: { value: String(value), type: type || 'string', group, updatedBy: req.user.id },
    create: { key, value: String(value), type: type || 'string', group, updatedBy: req.user.id },
  });

  return success(res, { setting }, 'Setting updated');
}

// Activity logs
async function getActivityLogs(req, res) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 50;
  const skip = (page - 1) * limit;

  const logs = await prisma.activityLog.findMany({
    skip,
    take: limit,
    orderBy: { createdAt: 'desc' },
    include: {
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  });

  return success(res, { logs });
}

module.exports = { getDashboardStats, getSettings, updateSetting, getActivityLogs };
