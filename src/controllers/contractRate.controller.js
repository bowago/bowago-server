const { prisma } = require("../config/db");
const { ApiError } = require("../utils/ApiError");
const { normalizeContract, findContractConflict, describeScope } = require("../services/pricing/contractRules");
const {
  success,
  created,
  getPagination,
  buildMeta,
} = require("../utils/helpers");

// ─── Admin: Create a contract rate for a user ─────────────────────────────────
// A user may hold several contracts (e.g. one per mode). Each has an explicit
// scope — mode (empty = all modes) and service (empty = all services) — and two
// active contracts for the same user may not claim the same product in the
// same period. (This used to be an upsert that silently replaced the user's
// single, mode-less contract.)
async function createContractRate(req, res) {
  const { userId } = req.body;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  if (!user) throw new ApiError(404, "User not found");

  const data = normalizeContract(req.body);
  const existing = await prisma.contractRate.findMany({ where: { userId, isActive: true } });
  const clash = findContractConflict(data, existing);
  if (clash) {
    throw new ApiError(
      409,
      `This user already has an active contract covering ${describeScope(clash)} in an overlapping period. Edit that contract, or narrow the scope/validity of this one.`,
    );
  }

  const contractRate = await prisma.contractRate.create({
    data: { ...data, userId, createdBy: req.user.id },
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
  });

  return created(
    res,
    { contractRate },
    `Contract rate (${describeScope(contractRate)}) assigned to ${user.firstName} ${user.lastName}`,
  );
}

// ─── Admin: List all contract rates ──────────────────────────────────────────
async function listContractRates(req, res) {
  const { page, limit, skip } = getPagination(req.query);
  const { isActive, search } = req.query;

  const where = {
    ...(isActive !== undefined && { isActive: isActive === "true" }),
    ...(search && {
      OR: [
        { label: { contains: search, mode: "insensitive" } },
        { user: { email: { contains: search, mode: "insensitive" } } },
        { user: { firstName: { contains: search, mode: "insensitive" } } },
      ],
    }),
  };

  const [rates, total] = await Promise.all([
    prisma.contractRate.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
          },
        },
      },
    }),
    prisma.contractRate.count({ where }),
  ]);

  return res.json({
    success: true,
    data: { rates },
    meta: buildMeta(total, page, limit),
  });
}

// ─── Admin: Get single contract rate ─────────────────────────────────────────
async function getContractRate(req, res) {
  const { id } = req.params;

  const rate = await prisma.contractRate.findUnique({
    where: { id },
    include: {
      user: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
    },
  });

  if (!rate) throw new ApiError(404, "Contract rate not found");

  return success(res, { contractRate: rate });
}

// ─── Admin: Update contract rate ──────────────────────────────────────────────
const CONTRACT_EDITABLE = [
  "label", "shipmentMode", "serviceType", "discountPercent", "fixedPricePerKgByZone",
  "isActive", "validFrom", "validUntil", "notes",
];

async function updateContractRate(req, res) {
  const { id } = req.params;
  const existing = await prisma.contractRate.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "Contract rate not found");

  const patch = Object.fromEntries(Object.entries(req.body).filter(([k]) => CONTRACT_EDITABLE.includes(k)));
  // Switching pricing type must clear the other side.
  if (patch.fixedPricePerKgByZone && patch.discountPercent === undefined) patch.discountPercent = null;
  if (patch.discountPercent !== undefined && patch.discountPercent !== null && patch.fixedPricePerKgByZone === undefined) {
    patch.fixedPricePerKgByZone = null;
  }

  const data = normalizeContract({ ...existing, ...patch });
  const others = await prisma.contractRate.findMany({ where: { userId: existing.userId, isActive: true } });
  const clash = findContractConflict(data, others, { ignoreId: id });
  if (clash) {
    throw new ApiError(409, `Another active contract for this user already covers ${describeScope(clash)} in an overlapping period.`);
  }

  const rate = await prisma.contractRate.update({
    where: { id },
    data,
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
  });

  return success(res, { contractRate: rate }, "Contract rate updated");
}

// ─── Admin: Delete/deactivate ─────────────────────────────────────────────────
async function deleteContractRate(req, res) {
  const { id } = req.params;
  const existing = await prisma.contractRate.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "Contract rate not found");

  await prisma.contractRate.delete({ where: { id } });

  return success(res, {}, "Contract rate deleted");
}

// ─── Customer: Get my contract rate(s) (if any) ──────────────────────────────
async function getMyContractRate(req, res) {
  const rates = await prisma.contractRate.findMany({
    where: { userId: req.user.id, isActive: true },
    orderBy: { createdAt: "asc" },
  });

  if (rates.length === 0) {
    return success(res, { contractRate: null, contractRates: [], hasContract: false });
  }

  // Security audit log — viewing own rate card
  await prisma.activityLog.create({
    data: {
      userId: req.user.id,
      action: "VIEW_CONTRACT_RATE",
      resource: "ContractRate",
      resourceId: rates[0].id,
    },
  });

  return success(res, {
    contractRate: rates[0], // first one, kept for older clients
    contractRates: rates,
    hasContract: true,
    discountType: rates[0].discountPercent ? "PERCENT" : "FIXED_PER_ZONE",
  });
}

module.exports = {
  createContractRate,
  listContractRates,
  getContractRate,
  updateContractRate,
  deleteContractRate,
  getMyContractRate,
};
