const { prisma } = require('../config/db');
const { success } = require('../utils/helpers');

// Dashboard summary stats
async function getDashboardStats(req, res) {
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);

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

  // Monthly trend (current year, grouped by month)
  const allShipments = await prisma.shipment.findMany({
    where: { createdAt: { gte: startOfYear } },
    select: { createdAt: true },
  });
  const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const trendMap = {};
  MONTH_LABELS.forEach(m => { trendMap[m] = 0; });
  for (const s of allShipments) {
    const m = MONTH_LABELS[new Date(s.createdAt).getMonth()];
    trendMap[m] = (trendMap[m] || 0) + 1;
  }
  const trend = MONTH_LABELS.map(month => ({ month, shipments: trendMap[month] }));

  // Top 3 routes (from → to city by shipment count)
  const routeAgg = await prisma.shipment.groupBy({
    by: ['senderCity', 'recipientCity'],
    _count: { _all: true },
    orderBy: { _count: { id: 'desc' } },
    take: 5,
  });
  const topRoutes = routeAgg
    .filter(r => r.senderCity && r.recipientCity)
    .slice(0, 3)
    .map((r, i) => ({
      rank: i + 1,
      from: r.senderCity,
      to: r.recipientCity,
      shipments: r._count._all,
    }));

  // Service type distribution
  const serviceAgg = await prisma.shipment.groupBy({
    by: ['serviceType'],
    _count: { _all: true },
  });
  const totalSvc = serviceAgg.reduce((s, r) => s + r._count._all, 0) || 1;
  const SERVICE_COLORS = {
    EXPRESS: '#e8432d',
    STANDARD: '#3b82f6',
    ECONOMY: '#10b981',
  };
  const serviceDistribution = serviceAgg.map(r => ({
    name: r.serviceType || 'Other',
    value: Math.round((r._count._all / totalSvc) * 100),
    color: SERVICE_COLORS[r.serviceType ?? ''] ?? '#6b7280',
  }));

  return success(res, {
    users: { total: totalUsers, customers: totalCustomers, admins: totalAdmins },
    shipments: {
      total: totalShipments,
      pending: pendingShipments,
      delivered: deliveredShipments,
    },
    revenue: {
      total: totalRevenue._sum.quotedPrice || 0,
      currency: 'NGN',
    },
    trend,
    topRoutes,
    serviceDistribution,
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

  // Merge in known defaults for keys that haven't been saved yet — important
  // on serverless (Vercel) where the boot-time seedDefaults() never runs.
  const { DEFAULTS, TYPES, PRICE_ADJUSTMENT_GROUP, INSURANCE_GROUP, CANCELLATION_GROUP, LOYALTY_GROUP } = require('../services/settings.service');
  const relevantGroups = [PRICE_ADJUSTMENT_GROUP, INSURANCE_GROUP, CANCELLATION_GROUP, LOYALTY_GROUP];
  if (!group || relevantGroups.includes(group)) {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (!settingsMap[key]) {
        const keyGroup = key.startsWith('insurance.')
          ? INSURANCE_GROUP
          : key.startsWith('cancellation.')
            ? CANCELLATION_GROUP
            : key.startsWith('loyalty.')
              ? LOYALTY_GROUP
              : PRICE_ADJUSTMENT_GROUP;
        if (!group || group === keyGroup) {
          settingsMap[key] = { value, type: TYPES[key] || 'string', group: keyGroup };
        }
      }
    }
  }

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
