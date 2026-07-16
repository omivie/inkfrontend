/**
 * Market-Aware Hybrid Pricing Engine — FE integration (Jul 2026)
 * ==============================================================
 *
 * The backend re-granularised its gross-markup bands (genuine 14→18,
 * compatible 9→14, + a 7-band `ribbon` source) and its pricing endpoints are
 * `.unknown(false)` — an unknown bucket key is rejected outright. These tests
 * pin the FE's response to that:
 *
 *  1. The calculator is KEY-AGNOSTIC — bounds are parsed from the key string,
 *     so an ARBITRARY (future) key set works with zero code changes. This is the
 *     guarantee that a reband never breaks the FE again.
 *  2. normalizeTierResponse tolerates every response shape the endpoint has
 *     used and FAILS LOUD (not silently empty) on an unrecognised one.
 *  3. coarsePreset adapts to whatever key set it's handed and stays in-range.
 *  4. validateTierMap tracks the LIVE keys it's given (so a stale key can't be
 *     sent to the .unknown(false) schema).
 *
 * Run with: node --test tests/pricing-hybrid-engine-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const PRICING_PATH = path.join(ROOT, 'inkcartridges', 'js', 'admin', 'utils', 'pricingCalculator.js');

// Same ESM-stripping vm loader used by control-center-pricing.test.js — keeps
// the source build-tool-free while remaining unit-testable in Node.
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

function loadModule(absPath) {
  const src = fs.readFileSync(absPath, 'utf8');
  const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(stripEsm(src), ctx, { filename: path.basename(absPath) });
  return sandbox;
}

const p = loadModule(PRICING_PATH);

// ─── parseTierKey ────────────────────────────────────────────────────────────

// The module runs in a vm sandbox; values it returns carry the sandbox's
// intrinsic prototypes, so spread objects/arrays into the test realm before a
// deepEqual (otherwise deepStrictEqual fails on the [[Prototype]] check).
const obj = (o) => ({ ...o });
const arr = (a) => [...a];

test('parseTierKey understands open-low, closed range, and open-high keys', () => {
  assert.deepEqual(obj(p.parseTierKey('<=10')), { lower: 0, upper: 10 });
  assert.deepEqual(obj(p.parseTierKey('<6')),   { lower: 0, upper: 6 });   // ribbon uses strict-less
  assert.deepEqual(obj(p.parseTierKey('20-30')), { lower: 20, upper: 30 });
  assert.deepEqual(obj(p.parseTierKey('1000+')), { lower: 1000, upper: Infinity });
  assert.deepEqual(obj(p.parseTierKey('200+')),  { lower: 200, upper: Infinity });
  // Decimal + whitespace tolerance.
  assert.deepEqual(obj(p.parseTierKey('12.5-18')), { lower: 12.5, upper: 18 });
  // Garbage → widest bucket (never throws).
  assert.deepEqual(obj(p.parseTierKey('nonsense')), { lower: 0, upper: Infinity });
});

// ─── tierMidpoint ────────────────────────────────────────────────────────────

test('tierMidpoint returns a representative cost inside the bucket', () => {
  assert.equal(p.tierMidpoint('20-30'), 25);       // closed → true midpoint
  assert.equal(p.tierMidpoint('<=10'), 8);         // open-low → 0.8 × upper
  assert.equal(p.tierMidpoint('<6'), 4.8);
  assert.equal(p.tierMidpoint('1000+'), 1200);     // open-high → 1.2 × lower
  // A midpoint must land inside its own bucket (the invariant the preview needs).
  for (const k of ['<=5','8-12','90-120','200+','<6','30-50','50+']) {
    const { lower, upper } = p.parseTierKey(k);
    const mid = p.tierMidpoint(k);
    assert.ok(mid > lower && mid <= (upper === Infinity ? mid + 1 : upper), `${k} midpoint ${mid} outside bucket`);
  }
});

// ─── sortTierKeys ────────────────────────────────────────────────────────────

test('sortTierKeys orders by cost (upper bound), open-high last', () => {
  const shuffled = ['1000+','15-20','<=10','200-260','20-30'];
  assert.deepEqual(arr(p.sortTierKeys(shuffled)), ['<=10','15-20','20-30','200-260','1000+']);
});

// ─── Key-agnostic lookup over an ARBITRARY key set (the core guarantee) ──────

test('lookupMultiplierByCost works on an arbitrary (future) key set with no code change', () => {
  // A totally made-up reband the FE has never seen.
  const future = { '<=7': 1.9, '7-19': 1.6, '19-42': 1.4, '42+': 1.2 };
  assert.equal(p.lookupMultiplierByCost(0, future), 1.9);
  assert.equal(p.lookupMultiplierByCost(7, future), 1.9);
  assert.equal(p.lookupMultiplierByCost(7.01, future), 1.6);
  assert.equal(p.lookupMultiplierByCost(19, future), 1.6);
  assert.equal(p.lookupMultiplierByCost(41.99, future), 1.4);
  assert.equal(p.lookupMultiplierByCost(42, future), 1.4);
  assert.equal(p.lookupMultiplierByCost(9999, future), 1.2);   // falls through to top band
  assert.equal(p.lookupMultiplierByCost(5, {}), 1);            // empty map → neutral, no throw
});

test('tierKeyForCost accepts an explicit map as well as a source string', () => {
  const future = { '<=7': 1.9, '7-19': 1.6, '19+': 1.2 };
  assert.equal(p.tierKeyForCost(5, null, future), '<=7');
  assert.equal(p.tierKeyForCost(10, null, future), '7-19');
  assert.equal(p.tierKeyForCost(100, null, future), '19+');
  // Ribbon source resolves against DEFAULT_TIERS.
  assert.equal(p.tierKeyForCost(4, 'ribbon'), '<6');
  assert.equal(p.tierKeyForCost(1000, 'ribbon'), '50+');
});

test('calcRetail is source-agnostic (prices ribbon via its own band)', () => {
  // ribbon $12 → tier 10-15 (×1.43): 12 × 1.43 × 1.15 = 19.734 → snap .79 → 19.79
  assert.equal(p.calcRetail(12, 'ribbon', p.DEFAULT_TIERS), 19.79);
});

// ─── coarsePreset ────────────────────────────────────────────────────────────

test('coarsePreset covers every key of an arbitrary set and stays 1.05..5', () => {
  const keys = ['<=9', '9-40', '40-300', '300+'];
  const preset = p.coarsePreset('genuine', keys);
  assert.deepEqual(arr(Object.keys(preset)), keys);         // one entry per live key
  for (const v of Object.values(preset)) assert.ok(v >= 1.05 && v <= 5);
  // Coarse means fewer distinct values than a granular set.
  assert.ok(new Set(Object.values(preset)).size <= keys.length);
});

test('COARSE_4_TIER_PRESET is generated for all three sources', () => {
  for (const s of ['genuine', 'compatible', 'ribbon']) {
    assert.deepEqual(arr(Object.keys(p.COARSE_4_TIER_PRESET[s])), arr(Object.keys(p.DEFAULT_TIERS[s])));
  }
});

// ─── validateTierMap tracks the LIVE keys it's handed ────────────────────────

test('validateTierMap accepts the live key list and rejects a stale key', () => {
  const liveKeys = Object.keys(p.DEFAULT_TIERS.genuine);
  const good = { ...p.DEFAULT_TIERS.genuine };
  assert.equal(p.validateTierMap(good, liveKeys).ok, true);

  // An OLD key (removed in the reband) must be rejected — this is exactly what
  // the server's .unknown(false) schema does, caught client-side first.
  const stale = { ...good, '20-40': 1.3 };
  const r = p.validateTierMap(stale, liveKeys);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.key === '20-40' && e.reason === 'unknown_tier'));
});

test('validateTierMap still range-checks multipliers (1.05..5)', () => {
  const keys = ['<=5', '5-8'];
  const r = p.validateTierMap({ '<=5': 1.0, '5-8': 6 }, keys);
  assert.equal(r.ok, false);
  const reasons = r.errors.map(e => e.reason);
  assert.ok(reasons.includes('below_minimum'));
  assert.ok(reasons.includes('above_maximum'));
});

// ─── normalizeTierResponse — every shape + loud failure ──────────────────────

test('normalizeTierResponse handles the live { data: { defaults, overrides, effective } } shape', () => {
  const live = {
    data: {
      defaults:  { genuine: { '<=10': 1.4 }, compatible: { '<=5': 1.8 }, ribbon: { '<6': 1.5 } },
      overrides: {},
      effective: { genuine: { '<=10': 1.47 }, compatible: { '<=5': 1.87 }, ribbon: { '<6': 1.5 } },
    },
  };
  const norm = p.normalizeTierResponse(live);
  assert.equal(norm.error, null);
  assert.equal(norm.effective.genuine['<=10'], 1.47);   // effective wins for "Live"
  assert.equal(norm.defaults.genuine['<=10'], 1.4);     // defaults preserved for "Reset"
  assert.ok(norm.effective.ribbon);                     // ribbon carried through
});

test('normalizeTierResponse handles a bare { genuine, compatible } object', () => {
  const norm = p.normalizeTierResponse({ genuine: { '<=10': 1.42 }, compatible: { '<=5': 1.85 } });
  assert.equal(norm.error, null);
  assert.equal(norm.effective.genuine['<=10'], 1.42);
  assert.equal(norm.defaults.genuine['<=10'], 1.42);    // falls back to effective
});

test('normalizeTierResponse groups a flat array of {source, tier_name, multiplier} rows', () => {
  const arr = [
    { source: 'genuine', tier_name: '<=10', multiplier: 1.47 },
    { source: 'genuine', tier: '10-15', multiplier: 1.44 },
    { source: 'compatible', name: '<=5', multiplier: 1.87 },
  ];
  const norm = p.normalizeTierResponse(arr);
  assert.equal(norm.effective.genuine['<=10'], 1.47);
  assert.equal(norm.effective.genuine['10-15'], 1.44);
  assert.equal(norm.effective.compatible['<=5'], 1.87);
});

test('normalizeTierResponse FAILS LOUD on an unrecognised shape (never a silent empty)', () => {
  for (const bad of [null, undefined, 42, 'nope', {}, { foo: 1 }, []]) {
    const norm = p.normalizeTierResponse(bad);
    assert.equal(norm.effective, null, `expected null effective for ${JSON.stringify(bad)}`);
    assert.ok(norm.error, `expected an error flag for ${JSON.stringify(bad)}`);
  }
});

test('normalizeTierResponse flags array rows missing a source instead of dropping them silently', () => {
  const arr = [
    { source: 'genuine', tier_name: '<=10', multiplier: 1.47 },
    { tier_name: '10-15', multiplier: 1.44 }, // no source — ambiguous
  ];
  const norm = p.normalizeTierResponse(arr);
  assert.equal(norm.error, 'some_rows_missing_source');
  assert.ok(norm.effective.genuine); // still returns what it could resolve
});

// ─── SIMULATABLE_SOURCES reflects the verified backend constraint ────────────

test('SIMULATABLE_SOURCES is genuine + compatible (ribbon is store-only; simulate rejects it)', () => {
  assert.deepEqual(arr(p.SIMULATABLE_SOURCES), ['genuine', 'compatible']);
});
