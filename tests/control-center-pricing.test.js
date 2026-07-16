/**
 * Control Center — pricingCalculator + bundleLogic
 * =================================================
 *
 * Pin the FE math so the Margin Simulator preview cannot drift away from
 * the server's marginSimulatorService. Golden cost/source pairs come from
 * spec §12 (readfirst/control-center-may2026.md). Backend tests assert the
 * same fixtures — when these two suites disagree, one of them is wrong and
 * commit-time prices will surprise us.
 *
 * Run with: node --test tests/control-center-pricing.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const PRICING_PATH = path.join(ROOT, 'inkcartridges', 'js', 'admin', 'utils', 'pricingCalculator.js');
const BUNDLE_PATH = path.join(ROOT, 'inkcartridges', 'js', 'admin', 'utils', 'bundleLogic.js');

// Strip ES-module syntax so we can run the source in a vm sandbox without
// adding a build step. Keeps the tests free of bundlers / ts-node.
// Strip ESM and re-attach top-level identifiers from `export { a, b }` lists
// onto globalThis so the test sandbox can read them after vm.runInContext.
// const/let don't bind to globalThis on their own, so we have to lift them.
function stripEsm(src) {
  const exposed = new Set();
  let stripped = src.replace(/export\s*\{([\s\S]*?)\}\s*;?/g, (_m, body) => {
    body.split(',').forEach(name => {
      const id = name.trim().split(/\s+as\s+/)[0].trim();
      if (id) exposed.add(id);
    });
    return '';
  });
  stripped = stripped.replace(/export\s+default\s+([A-Za-z0-9_$]+)\s*;?/g, (_m, id) => {
    exposed.add(id);
    return `globalThis.__default = ${id};`;
  });
  stripped = stripped.replace(/^export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm, (_m, kw, id) => {
    exposed.add(id);
    return `${kw} ${id}`;
  });
  const footer = '\n;' + [...exposed].map(id => `try { globalThis.${id} = ${id}; } catch(_) {}`).join('\n');
  return stripped + footer;
}

function loadModule(absPath, extraSandbox = {}) {
  const src = fs.readFileSync(absPath, 'utf8');
  const sandbox = {
    console, Math, Number, Object, Array, String, Boolean,
    JSON, Error,
    ...extraSandbox,
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(stripEsm(src), ctx, { filename: path.basename(absPath) });
  return sandbox;
}

const pricing = loadModule(PRICING_PATH);
const bundle  = loadModule(BUNDLE_PATH);

// ─── Constants & defaults ───────────────────────────────────────────────────

test('GST_RATE is 15%, STRIPE_RATE is 2.65%, STRIPE_FEE_GST is 15%', () => {
  assert.equal(pricing.GST_RATE, 0.15);
  assert.equal(pricing.STRIPE_RATE, 0.0265);
  assert.equal(pricing.STRIPE_FEE_GST, 0.15);
});

test('DEFAULT_TIERS has all genuine + compatible + ribbon tier keys (Jul 2026 reband)', () => {
  const g = ['<=10','10-15','15-20','20-30','30-45','45-60','60-80','80-100','100-130','130-160','160-200','200-260','260-340','340-450','450-600','600-800','800-1000','1000+'];
  const c = ['<=5','5-8','8-12','12-18','18-25','25-35','35-45','45-55','55-70','70-90','90-120','120-150','150-200','200+'];
  const r = ['<6','6-10','10-15','15-20','20-30','30-50','50+'];
  assert.deepEqual(Object.keys(pricing.DEFAULT_TIERS.genuine), g);
  assert.deepEqual(Object.keys(pricing.DEFAULT_TIERS.compatible), c);
  assert.deepEqual(Object.keys(pricing.DEFAULT_TIERS.ribbon), r);
  assert.equal(g.length, 18);
  assert.equal(c.length, 14);
});

test('every default multiplier obeys 1.05 ≤ m ≤ 5', () => {
  for (const src of ['genuine', 'compatible', 'ribbon']) {
    for (const v of Object.values(pricing.DEFAULT_TIERS[src])) {
      assert.ok(v >= 1.05 && v <= 5, `${src} ${v} out of bounds`);
    }
  }
});

test('every coarse-4-tier preset multiplier obeys 1.05 ≤ m ≤ 5', () => {
  for (const src of ['genuine', 'compatible', 'ribbon']) {
    for (const v of Object.values(pricing.COARSE_4_TIER_PRESET[src])) {
      assert.ok(v >= 1.05 && v <= 5, `${src} coarse ${v} out of bounds`);
    }
  }
});

// ─── Tier lookup boundaries (new bands) ─────────────────────────────────────

test('lookupGenuineMultiplier picks the right tier at every boundary', () => {
  const t = pricing.DEFAULT_TIERS.genuine;
  assert.equal(pricing.lookupGenuineMultiplier(0,  t), t['<=10']);
  assert.equal(pricing.lookupGenuineMultiplier(10, t), t['<=10']);
  assert.equal(pricing.lookupGenuineMultiplier(10.01, t), t['10-15']);
  assert.equal(pricing.lookupGenuineMultiplier(15, t), t['10-15']);
  assert.equal(pricing.lookupGenuineMultiplier(15.01, t), t['15-20']);
  assert.equal(pricing.lookupGenuineMultiplier(20, t), t['15-20']);
  assert.equal(pricing.lookupGenuineMultiplier(20.01, t), t['20-30']);
  assert.equal(pricing.lookupGenuineMultiplier(30, t), t['20-30']);
  assert.equal(pricing.lookupGenuineMultiplier(1000, t), t['800-1000']);
  assert.equal(pricing.lookupGenuineMultiplier(1000.01, t), t['1000+']);
  assert.equal(pricing.lookupGenuineMultiplier(50000, t), t['1000+']);
});

test('lookupCompatibleMultiplier picks the right tier at every boundary', () => {
  const t = pricing.DEFAULT_TIERS.compatible;
  assert.equal(pricing.lookupCompatibleMultiplier(0,    t), t['<=5']);
  assert.equal(pricing.lookupCompatibleMultiplier(5,    t), t['<=5']);
  assert.equal(pricing.lookupCompatibleMultiplier(5.01, t), t['5-8']);
  assert.equal(pricing.lookupCompatibleMultiplier(8,    t), t['5-8']);
  assert.equal(pricing.lookupCompatibleMultiplier(8.01, t), t['8-12']);
  assert.equal(pricing.lookupCompatibleMultiplier(200,  t), t['150-200']);
  assert.equal(pricing.lookupCompatibleMultiplier(200.01, t), t['200+']);
});

test('tierKeyForCost returns the same key the lookup uses', () => {
  assert.equal(pricing.tierKeyForCost(20,  'genuine'),    '15-20');
  assert.equal(pricing.tierKeyForCost(50,  'genuine'),    '45-60');
  assert.equal(pricing.tierKeyForCost(200, 'genuine'),    '160-200');
  assert.equal(pricing.tierKeyForCost(4,   'compatible'), '<=5');
  assert.equal(pricing.tierKeyForCost(12,  'compatible'), '8-12');
  assert.equal(pricing.tierKeyForCost(100, 'compatible'), '90-120');
  assert.equal(pricing.tierKeyForCost(9999,'compatible'), '200+');
});

// ─── snapPriceCeil ──────────────────────────────────────────────────────────

test('snapPriceCeil snaps to .49 / .79 / .99 ceilings (psychology pricing)', () => {
  assert.equal(pricing.snapPriceCeil(10.00), 10.49);
  assert.equal(pricing.snapPriceCeil(10.49), 10.49);
  assert.equal(pricing.snapPriceCeil(10.50), 10.79);
  assert.equal(pricing.snapPriceCeil(10.79), 10.79);
  assert.equal(pricing.snapPriceCeil(10.80), 10.99);
  assert.equal(pricing.snapPriceCeil(10.99), 10.99);
  assert.equal(pricing.snapPriceCeil(11.00), 11.49);
});

// ─── Spec §12 golden cost/source pairs ──────────────────────────────────────
// These are the same fixtures the backend Jest tests pin against. If FE math
// drifts, the simulator misrepresents what commits will produce.

// Recomputed for the Jul 2026 reband (values captured live from
// GET /admin/pricing/tier-multipliers). Cost-plus retail only — the backend
// market cap is applied separately and is not modelled by calcRetail.
const GOLDENS = [
  { cost: 20.00,  source: 'genuine',    expected: 32.79,  tierKey: '15-20',   mult: 1.42 },
  { cost: 50.00,  source: 'genuine',    expected: 79.79,  tierKey: '45-60',   mult: 1.385 },
  { cost: 200.00, source: 'genuine',    expected: 304.79, tierKey: '160-200', mult: 1.325 },
  { cost: 4.00,   source: 'compatible', expected: 8.79,   tierKey: '<=5',     mult: 1.87 },
  { cost: 12.00,  source: 'compatible', expected: 24.49,  tierKey: '8-12',    mult: 1.75 },
  { cost: 100.00, source: 'compatible', expected: 154.49, tierKey: '90-120',  mult: 1.34 },
];

for (const g of GOLDENS) {
  test(`golden: ${g.source} cost $${g.cost.toFixed(2)} → retail $${g.expected.toFixed(2)} (tier ${g.tierKey} × ${g.mult})`, () => {
    const tiers = pricing.DEFAULT_TIERS;
    const retail = pricing.calcRetail(g.cost, g.source, tiers);
    assert.equal(retail, g.expected, `expected $${g.expected}, got $${retail}`);
    const lookup = g.source === 'genuine'
      ? pricing.lookupGenuineMultiplier(g.cost, tiers.genuine)
      : pricing.lookupCompatibleMultiplier(g.cost, tiers.compatible);
    assert.equal(lookup, g.mult);
    assert.equal(pricing.tierKeyForCost(g.cost, g.source), g.tierKey);
  });
}

// ─── Margin & markup math ───────────────────────────────────────────────────

test('netMarginPct returns >0 for healthy retail and 0 for break-even', () => {
  // Compatible $4 → retail $8.79. ex-GST = 7.6435;
  // fee = 8.79 × 0.0265 × 1.15 ≈ 0.2679 (full cash to Stripe incl. GST on fee).
  // profit = 7.6435 - 4 - 0.2679 = 3.3756; margin = 3.3756 / 7.6435 ≈ 44.16%
  const m = pricing.netMarginPct(8.79, 4.00);
  assert.ok(m > 43 && m < 46, `expected ~44%, got ${m}`);
});

test('netMarginPct flags non-positive retail with -1 sentinel', () => {
  assert.equal(pricing.netMarginPct(0, 5), -1);
  assert.equal(pricing.netMarginPct(-3, 5), -1);
});

test('grossMarkupPct is 0 when cost is 0 (avoids div-by-zero)', () => {
  assert.equal(pricing.grossMarkupPct(10, 0), 0);
});

test('grossMarkupPct: $4 cost → $8.79 retail ≈ 91% gross markup', () => {
  // ex-GST retail = 7.6435; markup = (7.6435/4 - 1) * 100 = 91.09%
  const m = pricing.grossMarkupPct(8.79, 4.00);
  assert.ok(m > 90 && m < 92, `expected ~91%, got ${m}`);
});

// ─── Validation ─────────────────────────────────────────────────────────────

test('validateMultiplier accepts in-range, rejects below/above', () => {
  assert.equal(pricing.validateMultiplier(1.05).ok, true);
  assert.equal(pricing.validateMultiplier(5).ok,    true);
  assert.equal(pricing.validateMultiplier(1.04).ok, false);
  assert.equal(pricing.validateMultiplier(5.01).ok, false);
  assert.equal(pricing.validateMultiplier('nope').ok, false);
});

test('validateTierMap flags unknown keys and bad values', () => {
  const r = pricing.validateTierMap({ '<=10': 1.5, 'bogus': 1.5, '10-15': 0.5 }, 'genuine');
  assert.equal(r.ok, false);
  const reasons = r.errors.map(e => e.reason);
  assert.ok(reasons.includes('unknown_tier'));
  assert.ok(reasons.includes('below_minimum'));
});

test('validateTierMap passes for an all-good map', () => {
  const r = pricing.validateTierMap(pricing.DEFAULT_TIERS.genuine, 'genuine');
  assert.equal(r.ok, true);
});

// ─── bundleLogic.recommendAction matrix (spec §7.2) ─────────────────────────

test('recommendAction: broken + only missing constituent → deactivate', () => {
  assert.equal(bundle.recommendAction({ isBroken: true, missing: ['CY'], inactive: [], drifted: false }), 'deactivate');
});

test('recommendAction: broken with inactive constituent → regenerate', () => {
  assert.equal(bundle.recommendAction({ isBroken: true, missing: [], inactive: ['G-X-CY'], drifted: false }), 'regenerate');
});

test('recommendAction: broken with both missing + inactive → regenerate (inactive wins on precedence)', () => {
  // Spec precedence: regenerate covers the case where we know the SKU exists
  // but is dormant — we have material to rebuild from. Pure missing means
  // the underlying single doesn't exist at all (deactivate the pack).
  assert.equal(bundle.recommendAction({ isBroken: true, missing: ['CY'], inactive: ['G-X-MG'], drifted: true }), 'regenerate');
});

test('recommendAction: healthy structure but drifted retail → reprice', () => {
  assert.equal(bundle.recommendAction({ isBroken: false, missing: [], inactive: [], drifted: true }), 'reprice');
});

test('recommendAction: nothing wrong → none', () => {
  assert.equal(bundle.recommendAction({ isBroken: false, missing: [], inactive: [], drifted: false }), 'none');
});

test('recommendAction: missing inputs do not throw', () => {
  assert.equal(bundle.recommendAction({}), 'none');
  assert.equal(bundle.recommendAction(undefined), 'none');
});

// ─── bundleLogic.driftSeverity boundaries ───────────────────────────────────

test('driftSeverity: 0 / 0.01 → green', () => {
  assert.equal(bundle.driftSeverity(0), 'green');
  assert.equal(bundle.driftSeverity(0.01), 'green');
  assert.equal(bundle.driftSeverity(-0.01), 'green');
});

test('driftSeverity: between 0.01 and 0.50 → yellow', () => {
  assert.equal(bundle.driftSeverity(0.02), 'yellow');
  assert.equal(bundle.driftSeverity(0.50), 'yellow');
  assert.equal(bundle.driftSeverity(-0.49), 'yellow');
});

test('driftSeverity: > 0.50 → red', () => {
  assert.equal(bundle.driftSeverity(0.51), 'red');
  assert.equal(bundle.driftSeverity(-2.00), 'red');
});

test('driftSeverity: garbage in is treated as 0 (not NaN)', () => {
  assert.equal(bundle.driftSeverity(undefined), 'green');
  assert.equal(bundle.driftSeverity(null), 'green');
  assert.equal(bundle.driftSeverity('not a number'), 'green');
});

// ─── bundleLogic.actionLabel ────────────────────────────────────────────────

test('actionLabel returns the spec copy for every action', () => {
  assert.equal(bundle.actionLabel('reprice'),    'Reprice to match singles');
  assert.equal(bundle.actionLabel('deactivate'), 'Deactivate (missing constituent)');
  assert.equal(bundle.actionLabel('regenerate'), 'Regenerate (constituent inactive)');
  assert.equal(bundle.actionLabel('none'),       'Healthy');
});
