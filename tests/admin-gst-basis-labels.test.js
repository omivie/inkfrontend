/**
 * Admin — GST-basis sub-lines on money headers — Jul 2026
 * =======================================================
 *
 * NZ GST is 15%, and the admin shows money on both sides of it in adjacent
 * columns. On the Products list `retail_price` is GST-INCLUSIVE and
 * `cost_price` is GST-EXCLUSIVE, two columns apart, with nothing on screen to
 * say so. Same on Orders, Invoices, Expenses and the Dashboard KPIs.
 *
 * So every money header now carries a muted second line naming its basis,
 * rendered from ONE vocabulary module (js/admin/utils/gst-basis.js).
 *
 * This test pins the two things that would silently rot:
 *
 *   1. THE VOCABULARY. Before this change four spellings of the same idea were
 *      already live — `(excl. GST)`, `(incl GST)`, `(ex GST)`, `(ex-GST)` —
 *      because each page invented its own. §3 fails the build if a page label
 *      reintroduces one of the retired forms.
 *
 *   2. THE BLANKS. ~25 admin money fields are backend passthrough whose basis
 *      nobody has proven, and two are actively contradicted between files
 *      (`pnl.revenue`; Stripe fees, ERR-114). Those render NO sub-line, and
 *      that blank is a deliberate signal recorded in
 *      gst-basis-backend-brief-jul2026.md. §5 fails if a future "helpful" PR
 *      quietly labels one of them from a guess — a wrong GST basis on an admin
 *      figure is worse than none, because it is how a wrong return gets filed.
 *
 * Run: node --test tests/admin-gst-basis-labels.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const READ = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const GST_SRC       = READ('inkcartridges/js/admin/utils/gst-basis.js');
const TABLE_SRC     = READ('inkcartridges/js/admin/components/table.js');
const CSS_SRC       = READ('inkcartridges/css/admin.css');
const PRODUCTS_SRC  = READ('inkcartridges/js/admin/pages/products.js');
const ORDERS_SRC    = READ('inkcartridges/js/admin/pages/orders.js');
const DASHBOARD_SRC = READ('inkcartridges/js/admin/pages/dashboard.js');
const PRICEMON_SRC  = READ('inkcartridges/js/admin/pages/price-monitor.js');
const CUSTOMERS_SRC = READ('inkcartridges/js/admin/pages/customers.js');
const CCPROFIT_SRC  = READ('inkcartridges/js/admin/pages/cc-profit.js');
const EXPALL_SRC    = READ('inkcartridges/js/admin/pages/expenses-tab-all.js');
const EXPOVER_SRC   = READ('inkcartridges/js/admin/pages/expenses-tab-overview.js');
const FINHEALTH_SRC = READ('inkcartridges/js/admin/pages/financial-health.js');

const PAGES_DIR = path.join(ROOT, 'inkcartridges/js/admin/pages');
const PAGE_FILES = fs.readdirSync(PAGES_DIR).filter(f => f.endsWith('.js'));

// ── §1 the vocabulary module ────────────────────────────────────────────────

test('§1 gst-basis.js exports the seven basis constants with the canon strings', () => {
  const expected = {
    GST_INCL:   'incl. GST',
    GST_EXCL:   'excl. GST',
    GST_BASE:   'excl. GST base',
    GST_NET:    'net of GST',
    GST_MIXED:  'GST-netted (mixed basis)',
    GST_CLAIM:  'excl. GST when claimable',
    GST_AMOUNT: 'GST amount',
  };
  for (const [name, value] of Object.entries(expected)) {
    const re = new RegExp(`export const ${name}\\s*=\\s*'${value.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}'`);
    assert.match(GST_SRC, re, `${name} must be exported as exactly '${value}'`);
  }
});

test('§1 profit reads "net of GST", never "excl. GST"', () => {
  // Order/invoice profit is GST-NEUTRAL: ex-GST on the revenue side AND the
  // cost side, so GST nets to zero. Calling it "excl. GST" implies a further
  // 15% is still to come off. It is not.
  assert.match(GST_SRC, /export const GST_NET\s*=\s*'net of GST'/);
  assert.match(ORDERS_SRC, /label: 'Profit', gst: GST_NET/,
    'the Orders list Profit column must use GST_NET');
});

test('§1 gstSub() renders the shared class and nothing at all when blank', () => {
  assert.match(GST_SRC, /export function gstSub\(basis\)/);
  assert.match(GST_SRC, /return basis \? `<span class="admin-th-sub">\$\{basis\}<\/span>` : ''/,
    'a falsy basis must render the empty string, not an empty span');
});

// ── §2 the shared table contract ────────────────────────────────────────────

test('§2 table.js renders col.gst through esc() into .admin-th-sub', () => {
  assert.match(TABLE_SRC, /const gstSub = col\.gst \? `<span class="admin-th-sub">\$\{esc\(col\.gst\)\}<\/span>` : ''/,
    'col.gst must be escaped like every other <th> input');
  assert.match(TABLE_SRC, /\$\{esc\(col\.label\)\}\$\{arrow\}\$\{gstSub\}<\/th>/,
    'the sub-line goes AFTER the sort arrow so the arrow stays inline with the label');
});

test('§2 the basis cannot be smuggled through col.label', () => {
  // label is HTML-escaped — a <span> in it would render as visible tag text.
  // That escaping is the whole reason col.gst exists; if it is ever removed,
  // pages will start hand-rolling markup in labels again.
  assert.match(TABLE_SRC, /\$\{esc\(col\.label\)\}/,
    'col.label must stay escaped');
});

// ── §3 CSS hooks ────────────────────────────────────────────────────────────

test('§3 the sub-line classes exist and neutralise the host header styling', () => {
  for (const cls of ['.admin-th-sub', '.admin-kpi__basis', '.exp-kpi__basis', '.exp-kpi-strip__basis']) {
    assert.ok(CSS_SRC.includes(cls), `${cls} must be defined in css/admin.css`);
  }
  // .admin-table th is uppercase with 0.06em tracking; the sub-line must opt out
  // of both, and it is also used inside margin.js's entirely unstyled
  // .margin-table, so it cannot rely on inheriting a reset.
  const block = CSS_SRC.slice(CSS_SRC.indexOf('.admin-th-sub {'));
  const rule = block.slice(0, block.indexOf('}'));
  assert.match(rule, /display:\s*block/);
  assert.match(rule, /text-transform:\s*none/);
  assert.match(rule, /letter-spacing:\s*normal/);
  assert.match(rule, /font-weight:\s*400/,
    'must beat .admin-table th font-weight 600 (700 in light theme)');
});

// ── §4 the retired spellings ────────────────────────────────────────────────

test('§4 no admin page reintroduces a retired GST spelling', () => {
  // Scoped to the two unambiguously wrong forms: "(incl GST)" and "(ex GST)".
  // "(ex-GST)" survives in tooltip/comment PROSE (e.g. "ex-GST revenue"), which
  // reads correctly and is not a label — banning it there would be noise.
  const banned = [/\(incl GST\)/, /\(ex GST\)/];
  const offenders = [];
  for (const f of PAGE_FILES) {
    const src = fs.readFileSync(path.join(PAGES_DIR, f), 'utf8');
    for (const re of banned) if (re.test(src)) offenders.push(`${f}: ${re}`);
  }
  assert.deepEqual(offenders, [],
    'Use the constants in utils/gst-basis.js — one spelling, one source.');
});

test('§4 the basis is not printed twice on a de-duplicated label', () => {
  // These labels used to carry the basis inline. The sub-line replaced it; if a
  // future edit restores the old text the header reads it twice.
  assert.ok(!/label: 'Total \(incl/.test(READ('inkcartridges/js/admin/pages/invoices.js')));
  assert.ok(!/label: 'Total \(incl/.test(READ('inkcartridges/js/admin/pages/quick-order.js')));
  assert.match(EXPALL_SRC, /ex_gst: 'P&L cost'/,
    'the Ex-GST column was renamed — its old label duplicated (and overstated) the basis');
});

test('§4 the Financial Health P&L rows all state a basis in canon wording', () => {
  for (const row of [
    'Revenue (incl. GST)',
    'Cost of Goods Sold (excl. GST)',
    'Gross Profit (excl. GST)',
    'Stripe Fees (excl. GST)',
    'Operating Expenses (excl. GST)',
    'Net Profit (excl. GST)',
  ]) {
    assert.ok(FINHEALTH_SRC.includes(`'${row}'`), `P&L row "${row}" missing`);
  }
});

// ── §5 the blanks are deliberate ────────────────────────────────────────────

test('§5 Price Monitor labels NO money column', () => {
  // Zero GST arithmetic in the file: our price, competitor prices, floor and
  // margin % are all raw backend passthrough. Likely incl-GST, unverified.
  assert.ok(!/\bgst:\s*GST_/.test(PRICEMON_SRC),
    'Price Monitor bases are unconfirmed — see gst-basis-backend-brief-jul2026.md');
});

test('§5 Customers total_spent stays unlabelled', () => {
  assert.match(CUSTOMERS_SRC, /key: 'total_spent'/);
  assert.ok(!/key: 'total_spent'[^}]*gst:/.test(CUSTOMERS_SRC),
    'total_spent is a passthrough with no documented basis');
});

test('§5 Dashboard Refund Rate carries no basis', () => {
  const tile = DASHBOARD_SRC.slice(DASHBOARD_SRC.indexOf("label: 'Refund Rate'"));
  const upToNext = tile.slice(0, tile.indexOf('},'));
  assert.ok(!/gst:/.test(upToNext),
    'the denominator is incl-GST revenue but the refund amounts on top have no documented basis');
});

test('§5 Control Center profit margin/gap columns carry no basis', () => {
  for (const key of ['net_margin', 'gap']) {
    const col = CCPROFIT_SRC.slice(CCPROFIT_SRC.indexOf(`key: '${key}'`));
    assert.ok(!/gst: GST_/.test(col.slice(0, col.indexOf('render:'))),
      `${key} is backend passthrough with no consistency gate`);
  }
});

test('§5 the Expenses "% of revenue" ratio carries no basis', () => {
  // expense-math.js asserts the denominator is ex-GST; financial-health.js
  // proves with live arithmetic that pnl.revenue is INCL-GST. Two files, two
  // opposite claims — neither label would be defensible.
  const strip = EXPOVER_SRC.slice(EXPOVER_SRC.indexOf("label: '% of revenue'"));
  assert.ok(!/basis: GST_/.test(strip.slice(0, strip.indexOf('},'))),
    'unresolved contradiction — must stay blank');
});

test('§5 the expenses headline is MIXED, not ex-GST', () => {
  // "GST-netted" is not the same as "ex-GST": non-claimable rows (foreign SaaS
  // with no NZ GST to reclaim) enter the total at full gross.
  assert.match(EXPOVER_SRC, /basis: GST_MIXED/);
});

// ── §6 the proven labels are actually applied ───────────────────────────────

test('§6 Products labels its four money columns on their proven bases', () => {
  const want = [
    [/key: 'retail_price', label: 'Price'[\s\S]{0,80}?gst: GST_INCL/, 'Price → incl. GST'],
    [/key: 'cost_price', label: 'Cost'[\s\S]{0,80}?gst: GST_EXCL/,    'Cost → excl. GST'],
    [/key: 'margin_pct'[\s\S]{0,80}?gst: GST_BASE/,                   'Margin % → excl. GST base'],
    [/key: 'profit_ex_gst'[\s\S]{0,500}?gst: GST_EXCL/,               'Profit $ → excl. GST'],
  ];
  for (const [re, what] of want) assert.match(PRODUCTS_SRC, re, what);
});

test('§6 the Orders modal Shipping row is labelled incl. GST', () => {
  // shipping_rates stores fees GST-INCLUSIVE (GST inside = fee × 3/23). This
  // was the one unlabelled money row in the modal's meta block.
  assert.match(ORDERS_SRC, /omRow\(`Shipping\$\{gstSub\(GST_INCL\)\}`/);
});

test('§6 the Dashboard KPI template renders a basis when one is known', () => {
  assert.match(DASHBOARD_SRC, /if \(t\.gst\) h \+= `<div class="admin-kpi__basis">\$\{esc\(t\.gst\)\}<\/div>`/);
  for (const [label, konst] of [
    ['Revenue', 'GST_INCL'], ['Gross Profit', 'GST_EXCL'], ['Net Profit', 'GST_EXCL'],
  ]) {
    const tile = DASHBOARD_SRC.slice(DASHBOARD_SRC.indexOf(`label: '${label}'`));
    assert.match(tile.slice(0, 400), new RegExp(`gst: ${konst}`), `${label} → ${konst}`);
  }
});

test('§6 every page that uses a GST constant imports it from the one module', () => {
  const offenders = [];
  for (const f of PAGE_FILES) {
    const src = fs.readFileSync(path.join(PAGES_DIR, f), 'utf8');
    const uses = /\bGST_(INCL|EXCL|BASE|NET|MIXED|CLAIM|AMOUNT)\b/.test(src) || /\bgstSub\(/.test(src);
    if (!uses) continue;
    assert.match(src, /from '\.\.\/utils\/gst-basis\.js'/, `${f} uses the vocabulary but does not import it`);
    // ERR-124: admin ES modules import bare. A ?v= token here forks module identity.
    if (/utils\/gst-basis\.js\?v=/.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], 'gst-basis.js must be imported without a ?v= token');
});
