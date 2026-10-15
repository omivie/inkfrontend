/**
 * Admin Pricing page — one viewer and changer for every price (ERR-336).
 *
 *   §1 sidebar: `pricing` sits in Catalog and is owner-only
 *   §2 the old Site Health → Pricing tab forwards to #pricing
 *   §3 margin % ↔ multiplier is display conversion, and refuses impossible margins
 *   §4 the bulk runner: one write at a time, every outcome reported, cap enforced
 *   §5 guards: no FE price maths, no manual_retail_price read, gated controls visible
 *   §6 lock / unlock + "Price set by" filter + cost/price ranges (live 2026-10-16)
 *
 * Run with: node --test tests/admin-pricing-page-oct2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const stripComments = require('./helpers/strip-comments');

const ADMIN = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin');
const read = (rel) => stripComments(fs.readFileSync(path.join(ADMIN, rel), 'utf8'));
const APP = read('app.js');
const PAGE = read('pages/pricing.js');
const CC = read('pages/control-center.js');
const RULES = read('pages/cc2-pricing.js');

// The util is a dependency-free ES module; load it as one.
async function loadUtil() {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-page-')), 'pricing-page.mjs');
  fs.copyFileSync(path.join(ADMIN, 'utils', 'pricing-page.js'), tmp);
  return import(pathToFileURL(tmp).href);
}

// §1 ─────────────────────────────────────────────────────────────────────────
test('§1 pricing is a Catalog item, owner-only', () => {
  const a = APP.indexOf("section: 'Catalog'");
  const b = APP.indexOf("section: 'Analytics'");
  const k = APP.indexOf("key: 'pricing'");
  assert.ok(a !== -1 && b > a && k > a && k < b, 'pricing must sit between the Catalog and Analytics markers');
  assert.match(APP, /\{ key: 'pricing', label: 'Pricing', icon: 'finance', ownerOnly: true \}/);
});

// §2 ─────────────────────────────────────────────────────────────────────────
test('§2 Control Center no longer has a Pricing tab and forwards the old link', () => {
  const tabs = CC.slice(CC.indexOf('const TABS'), CC.indexOf('];', CC.indexOf('const TABS')));
  assert.doesNotMatch(tabs, /id: 'pricing'/);
  assert.match(CC, /MOVED_TABS = \{ pricing: '#pricing' \}/);
  // switchTab must forward BEFORE anything else, or the Overview card and the
  // top-bar tile (both still say tab:'pricing') would land on Overview.
  const sw = CC.slice(CC.indexOf('async function switchTab('));
  assert.match(sw.slice(0, 200), /MOVED_TABS\[tabId\]\) \{ window\.location\.replace/);
  for (const f of fs.readdirSync(path.join(ADMIN, 'pages'))) {
    assert.doesNotMatch(read(`pages/${f}`), /control-center\?tab=pricing/, `${f} still links the old tab`);
  }
});

test('§2b the Pricing page mounts the rules engine rather than copying it', () => {
  assert.match(PAGE, /import\('\.\/cc2-pricing\.js'\)/);
  assert.match(PAGE, /_rules\.destroy\(\)/);
});

// §3 ─────────────────────────────────────────────────────────────────────────
test('§3 margin % ↔ multiplier', async () => {
  const { multFromMargin, marginFromMult } = await loadUtil();
  assert.equal(multFromMargin(20), 1.25);
  assert.equal(multFromMargin(50), 2);
  assert.equal(multFromMargin(40), 1.667);
  assert.equal(marginFromMult(1.25), 20);
  assert.equal(marginFromMult(2), 50);
  for (const m of [10, 33.3, 45, 70]) assert.ok(Math.abs(marginFromMult(multFromMargin(m)) - m) < 0.1, `round trip ${m}`);
  for (const bad of [-1, 100, 150, 'abc', '', null]) assert.equal(multFromMargin(bad), null, `refuses ${bad}`);
  for (const bad of [0, -2, '', null, 'x']) assert.equal(marginFromMult(bad), null, `refuses ${bad}`);
});

test('§3b filters map only to keys /api/admin/products accepts', async () => {
  const { filtersToParams } = await loadUtil();
  assert.deepEqual(filtersToParams({ active: '' }), { active: 'all' });
  assert.deepEqual(filtersToParams({ active: 'true', brand: 'b1', source: 'genuine', type: 'toner_cartridge', search: 'tn', sort: 'retail_price', order: 'desc' }),
    { active: 'true', brand: 'b1', source: 'genuine', product_type: 'toner_cartridge', search: 'tn', sort: 'retail_price', order: 'desc' });
  assert.deepEqual(filtersToParams({ active: 'true', type: 'ribbons' }), { active: 'true', product_type_group: 'ribbons' });
});

test('§3c the ladder Margin % input writes the multiplier cell; the propose body stays multipliers', () => {
  assert.match(RULES, /data-margin-for/);
  assert.match(RULES, /multIn\.value = m;\s*\}\s*multIn\.dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\)/);
  assert.match(RULES, /if \(t\.dataset\.marginFor != null\) \{ onMarginInput\(t\); return; \}/);
});

// §4 ─────────────────────────────────────────────────────────────────────────
test('§4 runSequential: one write at a time, three outcomes, unapplied flagged', async () => {
  const { runSequential } = await loadUtil();
  let inFlight = 0;
  let maxInFlight = 0;
  const put = async (id) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    if (id === 'b' || id === 'd') throw new Error(`refused ${id}`);
    return { retail_price: id === 'e' ? 31 : 29.99 };
  };
  const res = await runSequential(['a', 'b', 'c', 'd', 'e'], put, { expect: 29.99 });
  assert.equal(maxInFlight, 1);
  assert.equal(res.ok.length, 3);
  assert.deepEqual(res.failed.map((f) => [f.id, f.message]), [['b', 'refused b'], ['d', 'refused d']]);
  assert.deepEqual(res.notAttempted, []);
  assert.deepEqual(res.ok.filter((r) => r.unapplied).map((r) => r.id), ['e']);
});

test('§4b Stop leaves the rest as notAttempted; over the cap nothing is called', async () => {
  const { runSequential, BULK_CAP } = await loadUtil();
  let calls = 0;
  let stop = false;
  const res = await runSequential(['a', 'b', 'c', 'd'], async () => { calls++; if (calls === 2) stop = true; return {}; }, { shouldStop: () => stop });
  assert.equal(res.ok.length, 2);
  assert.deepEqual(res.notAttempted, ['c', 'd']);

  calls = 0;
  const ids = Array.from({ length: BULK_CAP + 1 }, (_, i) => String(i));
  const big = await runSequential(ids, async () => { calls++; return {}; });
  assert.equal(calls, 0);
  assert.equal(big.refused, true);
  assert.equal(big.notAttempted.length, BULK_CAP + 1);
});

// §5 ─────────────────────────────────────────────────────────────────────────
test('§5 the page computes no price and never reads manual_retail_price', () => {
  assert.doesNotMatch(PAGE, /computeProfitability|\* ?1\.15|\/ ?1\.15/);
  assert.doesNotMatch(PAGE, /\.select\([^)]*manual_retail_price/);
  // It only ever WRITES the field — exact value as typed, or null to clear.
  assert.match(PAGE, /updateProduct\(id, \{ manual_retail_price: v \}\)/);
  assert.match(PAGE, /updateProduct\(id, \{ manual_retail_price: null \}\)/);
  // A refused list is shown, not rendered as "no products" (getProducts → null).
  assert.match(PAGE, /listProductsStrict/);
  assert.doesNotMatch(PAGE, /AdminAPI\.getProducts\(/);
});

test('§5b gated controls are visible, disabled and say why', () => {
  assert.match(PAGE, /const NEEDS_BACKEND = `Needs backend — asked in \$\{SPEC\}`/);
  assert.match(PAGE, /SPEC = 'the backend asks sent 2026-10-16 \(§3\)'/);
  assert.match(PAGE, /<button class="admin-btn admin-btn--sm" disabled title="\$\{esc\(NEEDS_BACKEND\)\}">Adjust by % \/ \$/);
  assert.match(PAGE, /disabled title="\$\{esc\(NEEDS_BACKEND\)\}">Set margin for this filter/);
  // Unknown manual status is printed as unknown, never as "Rule".
  assert.match(PAGE, /: '<span class="pricing-chip" title="The server did not say whether this price is manual">unknown<\/span>'/);
  // The asks file was sent and deleted 2026-10-16 (owner); the page must not cite a repo path.
  assert.doesNotMatch(PAGE, /backend-docs\/outbox\//);
});

test('§5c the exact-price confirm warns that existing manual prices are replaced', () => {
  assert.match(PAGE, /Existing manual prices on these products are replaced/);
  assert.match(PAGE, /A reprice never lowers a price today/);
});

// §6 ─────────────────────────────────────────────────────────────────────────
test('§6a filters send has_manual and the four ranges under the exact backend names', async () => {
  const { filtersToParams } = await loadUtil();
  assert.deepEqual(filtersToParams({ active: 'true', manual: 'true', cost_min: '5', cost_max: '20.5', price_min: '0', price_max: '99' }),
    { active: 'true', has_manual: 'true', cost_min: '5', cost_max: '20.5', price_min: '0', price_max: '99' });
  assert.deepEqual(filtersToParams({ active: 'true', manual: 'false' }), { active: 'true', has_manual: 'false' });
  // empty, junk and negative are omitted, never sent as NaN
  assert.deepEqual(filtersToParams({ active: 'true', manual: '', cost_min: '', cost_max: 'abc', price_min: '-1', price_max: null }), { active: 'true' });
  const API = read('api.js');
  const fn = API.slice(API.indexOf('function productListParams('), API.indexOf('const AdminAPI'));
  assert.match(fn, /\['has_manual', 'cost_min', 'cost_max', 'price_min', 'price_max'\]/);
  assert.doesNotMatch(fn, /min_price|max_price|has_manual_price/, '400s at the backend (measured 2026-10-16)');
});

test('§6b lockPlan copies the row price verbatim, skips locked, refuses unknown', async () => {
  const { lockPlan } = await loadUtil();
  const rows = new Map([
    ['a', { id: 'a', retail_price: 29.99, has_manual_price: false }],
    ['b', { id: 'b', retail_price: 10, has_manual_price: true }],
    ['c', { id: 'c', retail_price: null, has_manual_price: false }],
    ['d', { id: 'd', retail_price: '8.49' }],
  ]);
  const p = lockPlan(['a', 'b', 'c', 'd', 'zz'], rows);
  assert.deepEqual(p.send, [{ id: 'a', price: 29.99 }, { id: 'd', price: 8.49 }]);
  assert.deepEqual(p.already, ['b']);
  assert.deepEqual(p.noPrice, ['c', 'zz']);
});

test('§6c page: filter select, live ranges, lock + unlock buttons and per-row chip', () => {
  assert.match(PAGE, /data-f="manual"/);
  for (const k of ['cost_min', 'cost_max', 'price_min', 'price_max']) assert.match(PAGE, new RegExp(`data-f="${k}"`));
  assert.doesNotMatch(PAGE, /pricing-gated|disabled aria-label="(Cost|Price)/);
  assert.doesNotMatch(PAGE, /cannot yet show which products have a manual/);
  assert.match(PAGE, /data-act="lock"/);
  assert.match(PAGE, /Unlock \(clear manual price\)/);
  assert.match(PAGE, /data-act="lock-one"/);
  assert.match(PAGE, /data-act="unlock-one"/);
  assert.match(PAGE, /manual_retail_price: price\.get\(String\(id\)\)/);
  assert.match(PAGE, /#pricing-table'\)\.addEventListener\('click', onClick\)/);
});
