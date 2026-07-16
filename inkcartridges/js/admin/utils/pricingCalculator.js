/**
 * Pricing calculator — mirrors the backend tier-based retail-pricing engine
 * defined in src/services/marginSimulatorService.js so the FE simulator can
 * preview without round-trips and the server tests stay in lockstep with FE
 * tests (see tests/control-center-pricing.test.js, golden pairs).
 *
 * ── KEY-AGNOSTIC (Jul 2026, market-aware hybrid engine handoff) ──────────────
 * The backend re-granularised its gross-markup bands (genuine 14→18,
 * compatible 9→14, plus a 7-band `ribbon` source) and its `/pricing/simulate`
 * + `/pricing/tier-multipliers` Joi schemas are `.unknown(false)` — an unknown
 * bucket key is rejected outright. To make a *future* reband a zero-FE-change
 * event, this module no longer hardcodes a parallel bounds table: tier bounds
 * are parsed straight out of the key string (`"20-30"` → cost ∈ (20, 30]) and
 * every lookup/midpoint/validation is driven by whatever key set it is handed.
 * `DEFAULT_TIERS` still carries a bundled snapshot of the live defaults (used as
 * an offline fallback + the "Reset to defaults" preset baseline); the live
 * simulator prefers the map the API returns (see cc2-pricing.js).
 *
 * calcRetail models the COST-PLUS retail only. The backend now also applies a
 * market-aware cap (undercut the cheapest fresh competitor, with a survival
 * floor) that the FE does NOT model — the authoritative aggregate/sample for a
 * proposed change still comes from `POST /admin/pricing/simulate`.
 *
 * GST_RATE       : NZ GST 15% (always applied on top of cost × multiplier).
 * STRIPE_RATE    : Stripe NZ domestic card rate (per-unit; the $0.30 fixed fee
 *                  is order-level, applied in profitability.js).
 * STRIPE_FEE_GST : 15% GST Stripe charges on its fee (real cash outflow, see
 *                  2026-05-12 convention in profitability.js).
 *
 * snapPriceCeil rounds .49/.79/.99 ceiling — same psychology pricing the
 * server uses, so retail figures match commit-time exactly.
 *
 * Exposed both as ES module (browser) and CommonJS (Node tests) via the
 * dual-export shim at the bottom — keeps the file build-tool-free.
 */

const GST_RATE = 0.15;
const STRIPE_RATE = 0.0265;
const STRIPE_FEE_GST = 0.15;

// Bundled snapshot of the live backend defaults, captured 2026-07-16 from
// GET /api/admin/pricing/tier-multipliers (see the handoff). Kept in sync as an
// offline fallback + "Reset to defaults" baseline; the live map wins at runtime.
const DEFAULT_TIERS = {
  genuine: {
    '<=10': 1.47, '10-15': 1.44, '15-20': 1.42, '20-30': 1.405, '30-45': 1.395,
    '45-60': 1.385, '60-80': 1.38, '80-100': 1.375, '100-130': 1.355, '130-160': 1.34,
    '160-200': 1.325, '200-260': 1.305, '260-340': 1.29, '340-450': 1.275, '450-600': 1.265,
    '600-800': 1.255, '800-1000': 1.245, '1000+': 1.235,
  },
  compatible: {
    '<=5': 1.87, '5-8': 1.80, '8-12': 1.75, '12-18': 1.69, '18-25': 1.63,
    '25-35': 1.57, '35-45': 1.51, '45-55': 1.47, '55-70': 1.42, '70-90': 1.38,
    '90-120': 1.34, '120-150': 1.295, '150-200': 1.26, '200+': 1.24,
  },
  ribbon: {
    '<6': 1.50, '6-10': 1.48, '10-15': 1.43, '15-20': 1.39, '20-30': 1.35,
    '30-50': 1.28, '50+': 1.22,
  },
};

// The sources the /pricing/simulate + /pricing/tier-multipliers write endpoints
// accept. `ribbon` exists in the multiplier store (and prices ribbon products)
// but the simulate endpoint rejects it (verified live 2026-07-16), so the
// interactive simulator only offers these two.
const SIMULATABLE_SOURCES = ['genuine', 'compatible'];

// ── Key parsing — the single source of truth for tier bounds ─────────────────
// Understands "<=10" / "<6" (open-low), "20-30" (closed range), "1000+" / "50+"
// (open-high). Returns numeric { lower, upper }; upper is Infinity for "N+".
function parseTierKey(key) {
  const s = String(key).trim();
  let m;
  if ((m = s.match(/^<=?\s*(\d+(?:\.\d+)?)$/))) return { lower: 0, upper: Number(m[1]) };
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/))) return { lower: Number(m[1]), upper: Number(m[2]) };
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*\+$/))) return { lower: Number(m[1]), upper: Infinity };
  return { lower: 0, upper: Infinity };
}

// A representative cost inside the bucket so preview examples feel real.
function tierMidpoint(key) {
  const { lower, upper } = parseTierKey(key);
  if (upper === Infinity) return lower > 0 ? Math.round(lower * 1.2 * 100) / 100 : 50;
  if (lower === 0) return Math.round(upper * 0.8 * 100) / 100;
  return Math.round(((lower + upper) / 2) * 100) / 100;
}

// Cost-ascending order (by upper bound). Stable for equal uppers.
function sortTierKeys(keys) {
  return [...keys].sort((a, b) => parseTierKey(a).upper - parseTierKey(b).upper);
}

// Generic cost → multiplier over ANY key set. First bucket whose upper ≥ cost;
// falls through to the highest bucket. Works for genuine / compatible / ribbon
// or any future source without code changes.
function lookupMultiplierByCost(cost, tierMap) {
  const keys = sortTierKeys(Object.keys(tierMap || {}));
  if (!keys.length) return 1;
  for (const k of keys) {
    if (cost <= parseTierKey(k).upper) return tierMap[k];
  }
  return tierMap[keys[keys.length - 1]];
}

// Back-compat thin wrappers (keep older imports/tests working).
function lookupGenuineMultiplier(cost, tiers) {
  return lookupMultiplierByCost(cost, tiers || DEFAULT_TIERS.genuine);
}
function lookupCompatibleMultiplier(cost, tiers) {
  return lookupMultiplierByCost(cost, tiers || DEFAULT_TIERS.compatible);
}

// Which bucket key a cost lands in. `sourceOrMap` may be a source string
// (resolved against DEFAULT_TIERS) or an explicit tier map.
function tierKeyForCost(cost, sourceOrMap, tierMap) {
  const map = tierMap
    || (typeof sourceOrMap === 'string' ? DEFAULT_TIERS[sourceOrMap] : sourceOrMap)
    || {};
  const keys = sortTierKeys(Object.keys(map));
  if (!keys.length) return null;
  for (const k of keys) {
    if (cost <= parseTierKey(k).upper) return k;
  }
  return keys[keys.length - 1];
}

function snapPriceCeil(price) {
  const cleaned = Math.round(price * 100) / 100;
  const base = Math.floor(cleaned);
  const dec = Math.round((cleaned - base) * 100) / 100;
  if (dec <= 0.49) return base + 0.49;
  if (dec <= 0.79) return base + 0.79;
  return base + 0.99;
}

// Cost-plus retail (pre-market-cap). Source-agnostic.
function calcRetail(cost, source, tiers) {
  const t = tiers || DEFAULT_TIERS;
  const map = (t && t[source]) || DEFAULT_TIERS[source] || {};
  const mult = lookupMultiplierByCost(cost, map);
  const raw = cost * mult * (1 + GST_RATE);
  return snapPriceCeil(raw);
}

function netMarginPct(retail, cost) {
  if (retail <= 0) return -1;
  const netRev = retail / (1 + GST_RATE);
  // Fee in nominal dollars (cash leaving the company): Stripe rate on gross
  // retail, multiplied by (1 + STRIPE_FEE_GST) for the 15% GST Stripe charges
  // on its fee. Deducted directly from ex-GST revenue.
  const fee = retail * STRIPE_RATE * (1 + STRIPE_FEE_GST);
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

// Validate a proposed map. `allowed` may be an explicit key array (preferred —
// pass the LIVE keys so validation always tracks the server), a source string
// (resolved against DEFAULT_TIERS), or omitted (any key accepted, values only).
function validateTierMap(map, allowed) {
  let expected = null;
  if (Array.isArray(allowed)) expected = allowed;
  else if (typeof allowed === 'string') expected = Object.keys(DEFAULT_TIERS[allowed] || {});
  else if (allowed && typeof allowed === 'object') expected = Object.keys(allowed);
  const errors = [];
  for (const [key, value] of Object.entries(map || {})) {
    if (expected && !expected.includes(key)) errors.push({ key, reason: 'unknown_tier' });
    const v = validateMultiplier(value);
    if (!v.ok) errors.push({ key, ...v });
  }
  return { ok: errors.length === 0, errors };
}

// Generate a "coarse" preset over an arbitrary key set — assigns a small number
// of distinct multipliers by each bucket's upper bound, so it adapts to any
// reband (no hardcoded key list). Values stay within 1.05 ≤ m ≤ 5.
function coarsePreset(source, keys) {
  const list = keys && keys.length ? keys : Object.keys(DEFAULT_TIERS[source] || {});
  const band = (upper) => {
    if (source === 'genuine') {
      if (upper <= 20) return 1.42;
      if (upper <= 100) return 1.32;
      if (upper <= 260) return 1.20;
      return 1.14;
    }
    if (source === 'ribbon') {
      if (upper <= 10) return 1.48;
      if (upper <= 30) return 1.38;
      return 1.24;
    }
    // compatible (default)
    if (upper <= 8) return 1.85;
    if (upper <= 25) return 1.65;
    if (upper <= 70) return 1.45;
    return 1.28;
  };
  const out = {};
  for (const k of list) out[k] = band(parseTierKey(k).upper);
  return out;
}

const COARSE_4_TIER_PRESET = {
  genuine: coarsePreset('genuine'),
  compatible: coarsePreset('compatible'),
  ribbon: coarsePreset('ribbon'),
};

// Normalise whatever GET /pricing/tier-multipliers returns into
// { effective: {source: {key: mult}}, defaults: {...} }. Tolerates the live
// object shape ({defaults, overrides, effective}), a bare {genuine,compatible},
// or a flat array of {source, tier_name/tier/name, multiplier} rows. On an
// unrecognised shape it FAILS LOUD (returns effective:null + error) rather than
// silently pretending the store is empty — an absence read as a healthy zero is
// how prior incidents shipped.
function normalizeTierResponse(resp) {
  const obj = resp && resp.data !== undefined ? resp.data : resp;
  const KNOWN = ['genuine', 'compatible', 'ribbon'];
  const pickSources = (o) => {
    const out = {};
    if (!o || typeof o !== 'object') return out;
    for (const s of KNOWN) {
      if (o[s] && typeof o[s] === 'object' && !Array.isArray(o[s])) out[s] = { ...o[s] };
    }
    return out;
  };
  const nonEmpty = (o) => o && Object.keys(o).length > 0;

  if (Array.isArray(obj)) {
    const eff = {};
    let missingSource = false;
    for (const row of obj) {
      const src = row && (row.source || row.type);
      const key = row && (row.tier_name || row.tier || row.name || row.key);
      const mult = row && Number(row.multiplier ?? row.value);
      if (!src) { missingSource = true; continue; }
      if (!key || !Number.isFinite(mult)) continue;
      (eff[src] = eff[src] || {})[key] = mult;
    }
    if (!nonEmpty(eff)) return { effective: null, defaults: null, error: 'unrecognized_array_shape' };
    return { effective: eff, defaults: eff, error: missingSource ? 'some_rows_missing_source' : null };
  }

  if (obj && typeof obj === 'object') {
    const eff = pickSources(obj.effective || obj);
    if (!nonEmpty(eff)) return { effective: null, defaults: null, error: 'unrecognized_object_shape' };
    const def = nonEmpty(pickSources(obj.defaults)) ? pickSources(obj.defaults) : eff;
    return { effective: eff, defaults: def, error: null };
  }

  return { effective: null, defaults: null, error: 'no_data' };
}

const GENUINE_TIER_KEYS = Object.keys(DEFAULT_TIERS.genuine);
const COMPATIBLE_TIER_KEYS = Object.keys(DEFAULT_TIERS.compatible);
const RIBBON_TIER_KEYS = Object.keys(DEFAULT_TIERS.ribbon);

const PricingCalc = {
  GST_RATE,
  STRIPE_RATE,
  STRIPE_FEE_GST,
  DEFAULT_TIERS,
  COARSE_4_TIER_PRESET,
  SIMULATABLE_SOURCES,
  GENUINE_TIER_KEYS,
  COMPATIBLE_TIER_KEYS,
  RIBBON_TIER_KEYS,
  parseTierKey,
  tierMidpoint,
  sortTierKeys,
  lookupMultiplierByCost,
  lookupGenuineMultiplier,
  lookupCompatibleMultiplier,
  tierKeyForCost,
  snapPriceCeil,
  calcRetail,
  netMarginPct,
  grossMarkupPct,
  validateMultiplier,
  validateTierMap,
  coarsePreset,
  normalizeTierResponse,
};

export {
  GST_RATE,
  STRIPE_RATE,
  STRIPE_FEE_GST,
  DEFAULT_TIERS,
  COARSE_4_TIER_PRESET,
  SIMULATABLE_SOURCES,
  GENUINE_TIER_KEYS,
  COMPATIBLE_TIER_KEYS,
  RIBBON_TIER_KEYS,
  parseTierKey,
  tierMidpoint,
  sortTierKeys,
  lookupMultiplierByCost,
  lookupGenuineMultiplier,
  lookupCompatibleMultiplier,
  tierKeyForCost,
  snapPriceCeil,
  calcRetail,
  netMarginPct,
  grossMarkupPct,
  validateMultiplier,
  validateTierMap,
  coarsePreset,
  normalizeTierResponse,
  PricingCalc,
};
export default PricingCalc;
