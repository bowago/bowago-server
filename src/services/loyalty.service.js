// loyalty.service.js
// Handles all loyalty account operations: earn on delivery, redeem at checkout,
// tier upgrades, and account creation on first earn.
const { prisma } = require('../config/db');
const { getNumberSetting } = require('./settings.service');

const TIER_ORDER = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM'];

async function getTierThresholds() {
  const [silver, gold, platinum] = await Promise.all([
    getNumberSetting('loyalty.silver_threshold'),
    getNumberSetting('loyalty.gold_threshold'),
    getNumberSetting('loyalty.platinum_threshold'),
  ]);
  return { silver, gold, platinum };
}

async function getTierMultipliers() {
  const [silver, gold, platinum] = await Promise.all([
    getNumberSetting('loyalty.silver_multiplier'),
    getNumberSetting('loyalty.gold_multiplier'),
    getNumberSetting('loyalty.platinum_multiplier'),
  ]);
  return { BRONZE: 1, SILVER: silver, GOLD: gold, PLATINUM: platinum };
}

function calculateTier(lifetimePoints, thresholds) {
  if (lifetimePoints >= thresholds.platinum) return 'PLATINUM';
  if (lifetimePoints >= thresholds.gold)     return 'GOLD';
  if (lifetimePoints >= thresholds.silver)   return 'SILVER';
  return 'BRONZE';
}

// ─── Get or create a loyalty account for a user ───────────────────────────────
async function getOrCreateAccount(userId) {
  return prisma.loyaltyAccount.upsert({
    where:  { userId },
    create: { userId, points: 0, lifetimePoints: 0, tier: 'BRONZE' },
    update: {},
  });
}

// ─── Earn points after a shipment is delivered ────────────────────────────────
// Called from updateShipmentStatus when status → DELIVERED.
// Returns the updated account (with new tier if upgraded).
async function earnPoints({ userId, shipmentId, finalPriceNaira }) {
  const [earnRate, multipliers, thresholds] = await Promise.all([
    getNumberSetting('loyalty.earn_rate_per_100_naira'),
    getTierMultipliers(),
    getTierThresholds(),
  ]);

  const account = await getOrCreateAccount(userId);
  const tierMultiplier = multipliers[account.tier] ?? 1;

  // Base: 1 pt per ₦100, scaled by tier multiplier, rounded down.
  const rawPoints = Math.floor((finalPriceNaira / 100) * earnRate);
  const earnedPoints = Math.floor(rawPoints * tierMultiplier);

  if (earnedPoints <= 0) return account;

  const newLifetime = account.lifetimePoints + earnedPoints;
  const newTier = calculateTier(newLifetime, thresholds);
  const tierUpgraded = newTier !== account.tier;

  const updated = await prisma.loyaltyAccount.update({
    where: { userId },
    data: {
      points:        { increment: earnedPoints },
      lifetimePoints: { increment: earnedPoints },
      tier:          newTier,
    },
  });

  await prisma.loyaltyTransaction.create({
    data: {
      accountId:   account.id,
      type:        'EARN',
      points:      earnedPoints,
      description: `Earned for delivered shipment${tierUpgraded ? ` · Tier upgraded to ${newTier}` : ''}`,
      shipmentId,
    },
  });

  // In-app notification for tier upgrade
  if (tierUpgraded) {
    await prisma.notification.create({
      data: {
        userId,
        type:  'PAYMENT',
        title: `🎉 Tier Upgraded to ${newTier}!`,
        body:  `Congratulations! You've reached ${newTier} tier. Enjoy ${Math.round((multipliers[newTier] - 1) * 100)}% bonus points on all future shipments.`,
        data:  { loyaltyTier: newTier },
      },
    }).catch(() => {});
  }

  return updated;
}

// ─── Preview redemption — call before booking to show available discount ──────
async function previewRedemption({ userId, pointsToRedeem, shipmentPriceNaira }) {
  const [minRedeem, pointValue, maxPerShipment] = await Promise.all([
    getNumberSetting('loyalty.min_redeem_points'),
    getNumberSetting('loyalty.point_naira_value'),
    getNumberSetting('loyalty.max_redeem_per_shipment'),
  ]);

  const account = await prisma.loyaltyAccount.findUnique({ where: { userId } });
  const balance = account?.points ?? 0;

  if (pointsToRedeem < minRedeem) {
    return { valid: false, reason: `Minimum redemption is ${minRedeem} points`, balance };
  }
  if (pointsToRedeem > balance) {
    return { valid: false, reason: 'Insufficient points balance', balance };
  }
  if (maxPerShipment > 0 && pointsToRedeem > maxPerShipment) {
    return { valid: false, reason: `Maximum ${maxPerShipment} points per shipment`, balance };
  }

  const discountNaira = pointsToRedeem * pointValue;
  const cappedDiscount = Math.min(discountNaira, shipmentPriceNaira * 0.5); // max 50% of shipment price
  const cappedPoints   = Math.ceil(cappedDiscount / pointValue);
  const finalPrice     = shipmentPriceNaira - cappedDiscount;

  return {
    valid: true,
    pointsToRedeem: cappedPoints,
    discountNaira:  cappedDiscount,
    finalPrice:     Math.max(0, finalPrice),
    balance,
    pointValue,
  };
}

// ─── Redeem points against a shipment ────────────────────────────────────────
// Call after shipment is created but before payment is initiated.
async function redeemPoints({ userId, shipmentId, pointsToRedeem }) {
  const account = await prisma.loyaltyAccount.findUnique({ where: { userId } });
  if (!account || account.points < pointsToRedeem) {
    throw new Error('Insufficient points');
  }

  const [minRedeem, pointValue] = await Promise.all([
    getNumberSetting('loyalty.min_redeem_points'),
    getNumberSetting('loyalty.point_naira_value'),
  ]);

  if (pointsToRedeem < minRedeem) throw new Error(`Minimum ${minRedeem} points`);

  const discountNaira = pointsToRedeem * pointValue;

  await prisma.loyaltyAccount.update({
    where: { userId },
    data:  { points: { decrement: pointsToRedeem } },
  });

  await prisma.loyaltyTransaction.create({
    data: {
      accountId:   account.id,
      type:        'REDEEM',
      points:      -pointsToRedeem,
      description: `Redeemed for ₦${discountNaira.toLocaleString()} discount on shipment`,
      shipmentId,
    },
  });

  return { discountNaira, pointsRedeemed: pointsToRedeem };
}

// ─── Get account summary (for customer portal) ────────────────────────────────
async function getAccountSummary(userId) {
  const [account, thresholds, multipliers] = await Promise.all([
    getOrCreateAccount(userId),
    getTierThresholds(),
    getTierMultipliers(),
  ]);

  // Points needed for next tier
  const tierIdx    = TIER_ORDER.indexOf(account.tier);
  const nextTier   = TIER_ORDER[tierIdx + 1] ?? null;
  const nextThresh = nextTier
    ? thresholds[nextTier.toLowerCase()] ?? null
    : null;
  const pointsToNext = nextThresh
    ? Math.max(0, nextThresh - account.lifetimePoints)
    : 0;

  const recentTx = await prisma.loyaltyTransaction.findMany({
    where:   { accountId: account.id },
    orderBy: { createdAt: 'desc' },
    take:    10,
  });

  return {
    ...account,
    nextTier,
    pointsToNext,
    currentMultiplier: multipliers[account.tier],
    recentTransactions: recentTx,
  };
}

module.exports = { earnPoints, redeemPoints, previewRedemption, getAccountSummary, getOrCreateAccount };
