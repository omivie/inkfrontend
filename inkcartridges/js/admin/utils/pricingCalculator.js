/**
 * Pricing calculator — mirrors the backend tier-based retail-pricing engine
 * defined in src/services/marginSimulatorService.js so the FE simulator can
 * preview without round-trips and the server tests stay in lockstep with FE
 * tests (see tests/pricingCalculator.test.js, golden pairs from spec §12).
 *
 * GST_RATE  : NZ GST 15% (always applied on top of cost × multiplier).
 * STRIPE_RATE: Stripe NZ domestic card rate (per-unit; the $0.30 fixed fee
 *             is order-level, applied in profitability.js).
 *
 * snapPriceCeil rounds .49/.79/.99 ceiling — same psychology pricing the
 * server uses, so retail figures match commit-time exactly.
 *
 * Exposed both as ES module (browser) and CommonJS (Node tests) via the
 * dual-export shim at the bottom — keeps the file build-tool-free.
 */

const GST_RATE = 0.15;
const STRIPE_RATE = 0.029;

const DEFAULT_TIERS = {
  genuine: {
    '<=10': 1.45, '10-15': 1.42, '15-20': 1.40, '20-40': 1.32, '40-70': 1.24,
    '70-100': 1.22, '100-130': 1.17, '130-150': 1.15, '150-200': 1.14,
    '200-300': 1.13, '300-400': 1.12, '400-600': 1.10, '600-900': 1.09, '900+': 1.08,
  },
  compatible: {
    '<=5': 1.87, '5-10': 1.77, '10-20': 1.67, '20-35': 1.57, '35-55': 1.47,
    '55-80': 1.37, '80-120': 1.27, '120-180': 1.17, '180+': 1.12,
  },
};

const COARSE_4_TIER_PRESET = {
  genuine: {
    '<=10': 1.40, '10-15': 1.40, '15-20': 1.40,
    '20-40': 1.25, '40-70': 1.25,
    '70-100': 1.15, '100-130': 1.15, '130-150': 1.15, '150-200': 1.15,
    '200-300': 1.10, '300-400': 1.10, '400-600': 1.10, '600-900': 1.10, '900+': 1.10,
  },
  compatible: {
    '<=5': 1.90,
    '5-10': 1.70, '10-20': 1.70,
    '20-35': 1.50, '35-55': 1.50,
    '55-80': 1.35, '80-120': 1.35, '120-180': 1.35, '180+': 1.35,
  },
};

const GENUINE_TIER_KEYS = Object.keys(DEFAULT_TIERS.genuine);
const COMPATIBLE_TIER_KEYS = Object.keys(DEFAULT_TIERS.compatible);
const TIER_BOUNDS_GENUINE = [
  ['<=10', 10], ['10-15', 15], ['15-20', 20], ['20-40', 40], ['40-70', 70],
  ['70-100', 100], ['100-130', 130], ['130-150', 150], ['150-200', 200],
  ['200-300', 300], ['300-400', 400], ['400-600', 600], ['600-900', 900],
];
const TIER_BOUNDS_COMPATIBLE = [
  ['<=5', 5], ['5-10', 10], ['10-20', 20], ['20-35', 35], ['35-55', 55],
  ['55-80', 80], ['80-120', 120], ['120-180', 180],
];

function lookupGenuineMultiplier(cost, tiers) {
  const t = tiers || DEFAULT_TIERS.genuine;
  for (const [k, max] of TIER_BOUNDS_GENUINE) if (cost <= max) return t[k];
  return t['900+'];
}

function lookupCompatibleMultiplier(cost, tiers) {
  const t = tiers || DEFAULT_TIERS.compatible;
  for (const [k, max] of TIER_BOUNDS_COMPATIBLE) if (cost <= max) return t[k];
  return t['180+'];
}

function tierKeyForCost(cost, source) {
  if (source === 'genuine') {
    for (const [k, max] of TIER_BOUNDS_GENUINE) if (cost <= max) return k;
    return '900+';
  }
  for (const [k, max] of TIER_BOUNDS_COMPATIBLE) if (cost <= max) return k;
  return '180+';
}

function snapPriceCeil(price) {
  const cleaned = Math.round(price * 100) / 100;
  const base = Math.floor(cleaned);
  const dec = Math.round((cleaned - base) * 100) / 100;
  if (dec <= 0.49) return base + 0.49;
  if (dec <= 0.79) return base + 0.79;
  return base + 0.99;
}

function calcRetail(cost, source, tiers) {
  const t = tiers || DEFAULT_TIERS;
  const mult = source === 'genuine'
    ? lookupGenuineMultiplier(cost, t.genuine)
    : lookupCompatibleMultiplier(cost, t.compatible);
  const raw = cost * mult * (1 + GST_RATE);
  return snapPriceCeil(raw);
}

function netMarginPct(retail, cost) {
  if (retail <= 0) return -1;
  const netRev = retail / (1 + GST_RATE);
  const fee = (retail * STRIPE_RATE) / (1 + GST_RATE);
  return Math.round(((netRev - cost - fee) / netRev) * 10000) / 100;
}

function grossMarkupPct(retail, cost) {
  if (cost <= 0) return 0;
  return Math.round(((retail / (1 + GST_RATE)) / cost - 1) * 10000) / 100;
}

function validateMultiplier(m) {
  const n = Number(m);
  if (!Number.isFinite(n)) return { ok: false, reason: 'not_a_number' };
  if (n < 1.05) return { ok: false, reason: 'below_minimum', min: 1.05 };
  if (n > 5) return { ok: false, reason: 'above_maximum', max: 5 };
  return { ok: true, value: n };
}

function validateTierMap(map, source) {
  const expected = source === 'genuine' ? GENUINE_TIER_KEYS : COMPATIBLE_TIER_KEYS;
  const errors = [];
  for (const [key, value] of Object.entries(map || {})) {
    if (!expected.includes(key)) errors.push({ key, reason: 'unknown_tier' });
    const v = validateMultiplier(value);
    if (!v.ok) errors.push({ key, ...v });
  }
  return { ok: errors.length === 0, errors };
}

const PricingCalc = {
  GST_RATE,
  STRIPE_RATE,
  DEFAULT_TIERS,
  COARSE_4_TIER_PRESET,
  GENUINE_TIER_KEYS,
  COMPATIBLE_TIER_KEYS,
  lookupGenuineMultiplier,
  lookupCompatibleMultiplier,
  tierKeyForCost,
  snapPriceCeil,
  calcRetail,
  netMarginPct,
  grossMarkupPct,
  validateMultiplier,
  validateTierMap,
};

export {
  GST_RATE,
  STRIPE_RATE,
  DEFAULT_TIERS,
  COARSE_4_TIER_PRESET,
  GENUINE_TIER_KEYS,
  COMPATIBLE_TIER_KEYS,
  lookupGenuineMultiplier,
  lookupCompatibleMultiplier,
  tierKeyForCost,
  snapPriceCeil,
  calcRetail,
  netMarginPct,
  grossMarkupPct,
  validateMultiplier,
  validateTierMap,
  PricingCalc,
};
export default PricingCalc;
