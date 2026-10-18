/**
 * Admin Pricing page — one viewer and changer for every price (ERR-336).
 *
 *   §1 sidebar: `pricing` sits in Catalog and is owner-only
 *   §2 the old Site Health → Pricing tab forwards to #pricing
 *   §3 margin % ↔ multiplier is display conversion, and refuses impossible margins
 *   §4 the bulk runner: one write at a time, every outcome reported, cap enforced
 *   §5 guards: no FE price maths, no manual_retail_price read; bulk previews first
 *   §6 lock / unlock + "Price set by" filter + cost/price ranges (live 2026-10-16)
 *   §7 bulk endpoint, margin rules by filter, price_source (ERR-363, backend 2026-10-17)
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
  // The ONE per-row write left: lock at the row's own current price.
  assert.match(PAGE, /updateProduct\(id, \{ manual_retail_price: price\.get\(String\(id\)\) \}\)/);
  assert.equal((PAGE.match(/updateProduct\(/g) || []).length, 1, 'every other change goes through the bulk endpoint (ERR-363)');
  // A refused list is shown, not rendered as "no products" (getProducts → null).
  assert.match(PAGE, /listProductsStrict/);
  assert.doesNotMatch(PAGE, /AdminAPI\.getProducts\(/);
});

test('§5b nothing is "needs backend" any more (backend response 2026-10-17, ERR-363)', () => {
  for (const gone of ['NEEDS_BACKEND', 'needs backend', 'Not everything works yet', 'pricing-gaps', 'offerReprice']) {
    assert.ok(!PAGE.includes(gone), `${gone} must not come back — the backend built it`);
  }
  for (const act of ['set-exact', 'adjust', 'set-margin', 'lock', 'clear-manual']) {
    assert.match(PAGE, new RegExp(`data-act="${act}" \\$\\{dis\\}`), `${act} is live (disabled only with no selection)`);
  }
  assert.doesNotMatch(PAGE, /backend-docs\/outbox\//, 'the page must not cite a repo path');
});

test('§5c every bulk change previews first; Apply sends exactly the previewed body', () => {
  const open = PAGE.slice(PAGE.indexOf('function openBulk('), PAGE.indexOf('function bulkOutcomeHtml('));
  assert.match(open, /pricingBulk\(built\.body, true\)/, 'Preview = dry run');
  assert.match(open, /pricingBulk\(previewed, false\)/, 'Apply = the previewed body');
  assert.match(open, /previewed = null; apply\.disabled = true/, 'any input change voids the preview');
  assert.match(open, /data-action="apply" disabled/, 'Apply starts disabled');
  assert.match(open, /Existing manual prices are replaced/);
  assert.match(open, /BULK_TARGET_CAP/, '2,000 cap checked before the call');
  // Unlock = bulk clear_manual (a PUT null cannot clear an older freeze).
  assert.match(PAGE, /act === 'unlock-one'\) openBulk\('clear-manual', \[b\.dataset\.id\]\)/);
  assert.match(PAGE, /read: \(\) => \(\{ action: 'clear_manual' \}\)/);
});

test('§5d API: confirm:true only on an apply; rules preview vs save', () => {
  const API = read('api.js');
  const bulk = API.slice(API.indexOf('async pricingBulk('), API.indexOf('async listPricingRules('));
  assert.match(bulk, /dryRun \? \{ \.\.\.body, dry_run: true \} : \{ \.\.\.body, dry_run: false, confirm: true \}/);
  const rules = API.slice(API.indexOf('async listPricingRules('), API.indexOf('async simulatePricing('));
  assert.match(rules, /window\.API\.get\('\/api\/admin\/pricing\/rules'\)/);
  assert.match(rules, /window\.API\.post\('\/api\/admin\/pricing\/rules', confirm \? \{ \.\.\.body, confirm: true \} : body\)/);
  assert.match(rules, /window\.API\.patch\(`\/api\/admin\/pricing\/rules\/\$\{encodeURIComponent\(ruleId\)\}`/);
  assert.match(rules, /window\.API\.delete\(`\/api\/admin\/pricing\/rules\/\$\{encodeURIComponent\(ruleId\)\}`\)/);
  const ids = API.slice(API.indexOf('async listProductIds('), API.indexOf('async listProductIds(') + 700);
  assert.match(ids, /params\.set\('ids_only', 'true'\)/);
  assert.match(ids, /throw new Error\('The server sent no id list'\)/);
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
  assert.match(PAGE, /data-act="lock"/);
  assert.match(PAGE, /data-act="clear-manual"/);
  assert.match(PAGE, /data-act="lock-one"/);
  assert.match(PAGE, /data-act="unlock-one"/);
  assert.match(PAGE, /#pricing-table'\)\.addEventListener\('click', onClick\)/);
  // Gross margin column = the backend's gross figure, no caveat.
  assert.match(PAGE, /label: 'Gross margin'[\s\S]{0,400}r\.gross_margin_pct == null/);
  assert.doesNotMatch(PAGE, /differs from \(price ex GST − cost\)/);
});

// §7 ─ backend response 2026-10-17 (ERR-363) ─────────────────────────────────
test('§7a bulkBody: cap 2,000 ids, one body for preview and apply', async () => {
  const { bulkBody, BULK_TARGET_CAP } = await loadUtil();
  assert.equal(BULK_TARGET_CAP, 2000);
  const big = Array.from({ length: 2001 }, (_, i) => `id${i}`);
  assert.match(bulkBody({ action: 'set', value: 10, ids: big }).error, /at most 2,000/);
  const ok = bulkBody({ action: 'adjust_pct', value: '5', ids: ['a', 'b'], allowDecrease: true });
  assert.deepEqual(ok.body, { target: { product_ids: ['a', 'b'] }, action: 'adjust_pct', lock: true, allow_decrease: true, value: 5 });
  assert.ok(!('confirm' in ok.body) && !('dry_run' in ok.body), 'the API wrapper owns dry_run/confirm');
  assert.deepEqual(bulkBody({ action: 'clear_manual', ids: ['a'] }).body,
    { target: { product_ids: ['a'] }, action: 'clear_manual', lock: false, allow_decrease: false, value: 0 });
  assert.match(bulkBody({ action: 'set', value: 0, ids: ['a'] }).error, /above \$0/);
});

test('§7b ruleBody: filter required, margin 4.77–80, cost band, ribbons refused', async () => {
  const { ruleBody } = await loadUtil();
  assert.deepEqual(ruleBody({ brand: 'brother', source: 'compatible', product_type: 'toner_cartridge', margin_pct: '38' }).body,
    { filter: { brand: 'brother', source: 'compatible', product_type: 'toner_cartridge' }, margin_pct: 38, allow_decrease: false });
  assert.match(ruleBody({ margin_pct: 38 }).error, /at least one/, 'catalogue-wide = the ladder (EMPTY_RULE_FILTER)');
  for (const m of ['4.7', '80.1', '', 'x']) assert.match(ruleBody({ source: 'genuine', margin_pct: m }).error, /between 4\.77% and 80%/, m);
  assert.ok(ruleBody({ source: 'genuine', margin_pct: 4.77 }).body && ruleBody({ source: 'genuine', margin_pct: 80 }).body, 'bounds inclusive');
  const band = ruleBody({ cost_min: '10', cost_max: '', margin_pct: 30, allow_decrease: true, priority: '2', notes: ' x ', category: 'con-ink' }).body;
  assert.deepEqual(band, { filter: { category: 'CON-INK', cost_band: { min: 10, max: null } }, margin_pct: 30, allow_decrease: true, priority: 2, notes: 'x' });
  assert.match(ruleBody({ cost_min: 20, cost_max: 10, margin_pct: 30 }).error, /above "to"/);
  assert.match(ruleBody({ product_type: 'ribbons', margin_pct: 30 }).error, /Ribbons group/);
});

test('§7c priceSourceOf: every backend price_source, locked first, packs not lockable', async () => {
  const { priceSourceOf } = await loadUtil();
  assert.deepEqual(priceSourceOf({ has_manual_price: true, price_source: 'manual' }), { kind: 'manual', label: 'Manual (locked)', lockable: false });
  assert.equal(priceSourceOf({ has_manual_price: true, price_source: 'brand_rule' }).kind, 'manual', 'an older freeze is still locked');
  assert.equal(priceSourceOf({ has_manual_price: false, price_source: 'filter_rule', price_rule_id: 'abcdef1234' }).label, 'Margin rule #abcdef12');
  for (const [src, label] of [['brand_rule', 'Brand ladder'], ['catalogue', 'Catalogue band'], ['default', 'Default ladder'], ['ribbon', 'Ribbon ladder']]) {
    assert.deepEqual(priceSourceOf({ has_manual_price: false, price_source: src }), { kind: src, label, lockable: true });
  }
  assert.deepEqual(priceSourceOf({ has_manual_price: false, price_source: 'pack' }).lockable, false);
  assert.equal(priceSourceOf({}).label, 'unknown', 'absent = unknown, never "Rule"');
  assert.equal(priceSourceOf({ price_source: 'bogus' }).label, 'unknown');
});

test('§7d rules UI: list, preview-then-save, toggle via PATCH preview, delete, job polled', () => {
  assert.match(PAGE, /id="pricing-filter-rules"/);
  assert.match(PAGE, /preview: \(body\) => AdminAPI\.controlCenter\.savePricingRule\(body, false\)/);
  assert.match(PAGE, /apply: \(body\) => AdminAPI\.controlCenter\.savePricingRule\(body, true\)/);
  assert.match(PAGE, /patchPricingRule\(id, body, false\)/);
  assert.match(PAGE, /patchPricingRule\(id, body, true\)/);
  assert.match(PAGE, /deletePricingRule\(id\)/);
  assert.match(PAGE, /if \(res && res\.job_id\) pollJob\(res\.job_id\)/);
  assert.match(PAGE, /Could not load the margin rules: /, 'a failed read is loud, never "No filter rules yet"');
  assert.match(PAGE, /clearTimeout\(_jobTimer\)/, 'destroy stops the poll');
});
