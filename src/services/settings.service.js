// settings.service.js — typed reads on top of the generic AppSettings
// key/value store, with sane defaults so the app works even before a
// Super Admin has visited Settings → Business Rules and saved anything.
const { prisma } = require('../config/db');

// Group used in the Settings UI so these can be presented together.
const PRICE_ADJUSTMENT_GROUP = 'price_adjustment';
const INSURANCE_GROUP = 'insurance';
const LOYALTY_GROUP = 'loyalty';
const CANCELLATION_GROUP = 'cancellation';

const DEFAULTS = {
  // ── Price Adjustment ───────────────────────────────────────────────────────
  'price_adjustment.response_window_hours': '24',
  'price_adjustment.cancel_refund_percent': '100',
  'price_adjustment.auto_cancel_refund_percent': '100',
  'price_adjustment.downgrade_enabled': 'true',
  'price_adjustment.sweep_interval_minutes': '15',

  // ── Insurance ─────────────────────────────────────────────────────────────
  'insurance.rate_percent': '2.5',
  'insurance.min_premium_naira': '100',

  // ── Cancellation & Returns ───────────────────────────────────────────────
  // % of the paid amount RETAINED (not refunded) by BowaGO when a shipment
  // is cancelled after it has already reached these stages. PRD range for
  // PICKED_UP is 5-10% (warehouse fee); default sits at the 8% midpoint.
  'cancellation.picked_up_fee_percent': '8',
  'cancellation.failed_delivery_fee_percent': '5',

  // ── Loyalty ───────────────────────────────────────────────────────────────
  // Points earned per ₦100 of shipment final price (after discounts/promo).
  'loyalty.earn_rate_per_100_naira': '1',
  // Minimum points balance required to start a redemption at checkout.
  'loyalty.min_redeem_points': '50',
  // Naira value of 1 point when redeeming (1 pt = ₦1).
  'loyalty.point_naira_value': '1',
  // Lifetime point thresholds for tier upgrades.
  'loyalty.silver_threshold': '500',
  'loyalty.gold_threshold': '2000',
  'loyalty.platinum_threshold': '5000',
  // Earn multipliers per tier (applied on top of base earn rate).
  'loyalty.silver_multiplier': '1.25',
  'loyalty.gold_multiplier': '1.5',
  'loyalty.platinum_multiplier': '2',
  // Max points redeemable on a single shipment (0 = no limit).
  'loyalty.max_redeem_per_shipment': '0',
};

const TYPES = {
  'price_adjustment.response_window_hours': 'number',
  'price_adjustment.cancel_refund_percent': 'number',
  'price_adjustment.auto_cancel_refund_percent': 'number',
  'price_adjustment.downgrade_enabled': 'boolean',
  'price_adjustment.sweep_interval_minutes': 'number',
  'insurance.rate_percent': 'number',
  'insurance.min_premium_naira': 'number',
  'cancellation.picked_up_fee_percent': 'number',
  'cancellation.failed_delivery_fee_percent': 'number',
  'loyalty.earn_rate_per_100_naira': 'number',
  'loyalty.min_redeem_points': 'number',
  'loyalty.point_naira_value': 'number',
  'loyalty.silver_threshold': 'number',
  'loyalty.gold_threshold': 'number',
  'loyalty.platinum_threshold': 'number',
  'loyalty.silver_multiplier': 'number',
  'loyalty.gold_multiplier': 'number',
  'loyalty.platinum_multiplier': 'number',
  'loyalty.max_redeem_per_shipment': 'number',
};

async function getSettingValue(key) {
  const row = await prisma.appSettings.findUnique({ where: { key } });
  if (row && row.value !== null && row.value !== undefined && row.value !== '') {
    return row.value;
  }
  return DEFAULTS[key] ?? null;
}

async function getNumberSetting(key) {
  const v = await getSettingValue(key);
  const n = Number(v);
  return Number.isFinite(n) ? n : Number(DEFAULTS[key]);
}

async function getBoolSetting(key) {
  const v = await getSettingValue(key);
  return String(v).toLowerCase() === 'true';
}

// Ensures every default key exists as a row so it shows up in
// GET /admin/settings?group=<group> even before anyone edits it.
function groupForKey(key) {
  if (key.startsWith('insurance.')) return INSURANCE_GROUP;
  if (key.startsWith('cancellation.')) return CANCELLATION_GROUP;
  if (key.startsWith('loyalty.')) return LOYALTY_GROUP;
  return PRICE_ADJUSTMENT_GROUP;
}

async function seedDefaults() {
  await Promise.all(
    Object.entries(DEFAULTS).map(([key, value]) =>
      prisma.appSettings.upsert({
        where: { key },
        update: {},
        create: { key, value, type: TYPES[key] || 'string', group: groupForKey(key) },
      }),
    ),
  );
}

module.exports = {
  PRICE_ADJUSTMENT_GROUP,
  INSURANCE_GROUP,
  LOYALTY_GROUP,
  CANCELLATION_GROUP,
  DEFAULTS,
  TYPES,
  getSettingValue,
  getNumberSetting,
  getBoolSetting,
  seedDefaults,
};
