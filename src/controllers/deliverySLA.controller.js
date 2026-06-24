const { prisma } = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { success } = require('../utils/helpers');

// ─── Auto-generate human label ───────────────────────────────────────────────
function buildLabel(minDays, maxDays) {
  if (minDays === maxDays) return `${minDays} business day${minDays === 1 ? '' : 's'}`;
  return `${minDays}–${maxDays} business days`;
}

// ─── GET /pricing/delivery-sla ────────────────────────────────────────────────
// Public (used by frontend to show zone-aware delivery times in booking modal)
async function listSLAs(req, res) {
  const slas = await prisma.deliverySLA.findMany({
    orderBy: [{ zone: 'asc' }, { serviceType: 'asc' }],
  });
  return success(res, { slas });
}

// ─── PATCH /pricing/delivery-sla/:id ─────────────────────────────────────────
// Super Admin / Admin: update minDays/maxDays for a zone×serviceType combination
async function updateSLA(req, res) {
  const { id } = req.params;
  const { minDays, maxDays } = req.body;

  if (!minDays || !maxDays) throw new ApiError(400, 'minDays and maxDays are required');
  if (minDays > maxDays) throw new ApiError(400, 'minDays cannot be greater than maxDays');
  if (minDays < 0 || maxDays < 0) throw new ApiError(400, 'Days must be positive numbers');

  const sla = await prisma.deliverySLA.update({
    where: { id },
    data: {
      minDays: Number(minDays),
      maxDays: Number(maxDays),
      label: buildLabel(Number(minDays), Number(maxDays)),
    },
  });

  return success(res, { sla }, 'Delivery SLA updated');
}

// ─── PATCH /pricing/delivery-sla/zone/:zone/service/:serviceType ─────────────
// Update by zone + service type (alternative to ID)
async function updateSLAByZoneService(req, res) {
  const { zone, serviceType } = req.params;
  const { minDays, maxDays } = req.body;

  if (!minDays || !maxDays) throw new ApiError(400, 'minDays and maxDays are required');
  if (Number(minDays) > Number(maxDays)) throw new ApiError(400, 'minDays cannot be greater than maxDays');

  const sla = await prisma.deliverySLA.upsert({
    where: { zone_serviceType: { zone: Number(zone), serviceType: serviceType.toUpperCase() } },
    update: {
      minDays: Number(minDays),
      maxDays: Number(maxDays),
      label: buildLabel(Number(minDays), Number(maxDays)),
    },
    create: {
      zone: Number(zone),
      serviceType: serviceType.toUpperCase(),
      minDays: Number(minDays),
      maxDays: Number(maxDays),
      label: buildLabel(Number(minDays), Number(maxDays)),
      createdBy: req.user?.id,
    },
  });

  return success(res, { sla }, 'Delivery SLA updated');
}

// ─── Helper: get estimated delivery date for a shipment ───────────────────────
// Used by shipment.controller.js at booking time
async function getEstimatedDelivery(zone, serviceType, pickupDate) {
  const sla = await prisma.deliverySLA.findFirst({
    where: { zone: Number(zone), serviceType: serviceType.toUpperCase() },
  });

  const days = sla ? sla.maxDays : getDefaultDays(serviceType);
  const base = pickupDate ? new Date(pickupDate) : new Date();
  const delivery = addBusinessDays(base, days);
  return { estimatedDelivery: delivery, slaLabel: sla?.label ?? `${days} business days` };
}

function getDefaultDays(serviceType) {
  const defaults = { EXPRESS: 3, STANDARD: 7, ECONOMY: 14 };
  return defaults[serviceType?.toUpperCase()] ?? 7;
}

function addBusinessDays(startDate, days) {
  const date = new Date(startDate);
  let added = 0;
  while (added < days) {
    date.setDate(date.getDate() + 1);
    const day = date.getDay();
    if (day !== 0 && day !== 6) added++; // skip weekends
  }
  return date;
}

module.exports = { listSLAs, updateSLA, updateSLAByZoneService, getEstimatedDelivery };
