/**
 * Admin Products — Supplier + Origin columns (Jul 2026)
 * ============================================================================
 *
 * The Orders modal has long shown, per SOLD line, who we sourced it from and how
 * the pack was produced (Single / Assembled / Pre-boxed). Those two questions are
 * really properties of the PRODUCT, so the catalogue list now answers them too.
 *
 * Two things this file exists to police:
 *
 * 1. ONE vocabulary. The origin map used to live inside pages/orders.js. Copying
 *    it into pages/products.js would let "Assembled" on one page and something
 *    else on the other drift apart. Both now import utils/sourcing.js.
 *
 * 2. The derivation is HONEST. `products` has no origin column — productOrigin()
 *    infers it from `pack_type` + whether the pack has a `supplier_sku` of its
 *    own. Anything it cannot answer must render a LOUD em-dash, never a
 *    plausible "Single" default, and 'unknown' must never print as if it were a
 *    supplier called "Unknown" (the ERR-063/068/073 fail-soft-must-be-loud rule).
 *
 * Live evidence for the rule (2026-07-28): GLC3317KCMY is a KCMY value pack with
 * supplier_sku NULL and its order line renders "Assembled"; GLC3317CMY is a CMY
 * value pack carrying supplier_sku "B3317CMY" — a pack the supplier boxes itself.
 *
 * Run: node --test tests/admin-product-sourcing-columns.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'inkcartridges');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PRODUCTS = read('inkcartridges/js/admin/pages/products.js');
const ORDERS = read('inkcartridges/js/admin/pages/orders.js');
const SOURCING = read('inkcartridges/js/admin/utils/sourcing.js');
const CSS = read('inkcartridges/css/admin.css');

// The module is ESM; this file is CJS. Load it once, lazily.
let S;
test.before(async () => {
  S = await import(path.join(SITE, 'js/admin/utils/sourcing.js'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. One shared vocabulary — no second copy of the origin map
// ─────────────────────────────────────────────────────────────────────────────

test('both pages import origin rendering from utils/sourcing.js', () => {
  for (const [name, src] of [['products.js', PRODUCTS], ['orders.js', ORDERS]]) {
    assert.match(src, /from\s+'\.\.\/utils\/sourcing\.js'/,
      `${name} must import the shared sourcing vocabulary`);
  }
});

test('the origin label map exists in exactly one file', () => {
  // "in_house_pack:" keyed to a label tuple is the map's fingerprint.
  for (const [name, src] of [['products.js', PRODUCTS], ['orders.js', ORDERS]]) {
    assert.ok(!/in_house_pack:\s*\[/.test(src),
      `${name} must NOT re-declare the origin map — it belongs to utils/sourcing.js`);
  }
  assert.match(SOURCING, /export const ORIGIN_META\s*=\s*\{[\s\S]*in_house_pack:\s*\[/,
    'utils/sourcing.js must export ORIGIN_META');
});

test('ORIGIN_META keeps the labels the Orders modal already shipped', () => {
  assert.equal(S.ORIGIN_META.in_house_pack[1], 'Assembled');
  assert.equal(S.ORIGIN_META.supplier_pack[1], 'Pre-boxed');
  assert.equal(S.ORIGIN_META.single[1], 'Single');
  // Badge modifiers must match the CSS that already exists for the Orders modal.
  assert.equal(S.ORIGIN_META.in_house_pack[0], 'in-house');
  assert.equal(S.ORIGIN_META.supplier_pack[0], 'supplier-pack');
  assert.equal(S.ORIGIN_META.single[0], 'single');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. productOrigin() — the derivation truth table
// ─────────────────────────────────────────────────────────────────────────────

test('a single product is Single regardless of supplier_sku', () => {
  assert.equal(S.productOrigin({ pack_type: 'single', supplier_sku: 'B3317B' }), 'single');
  assert.equal(S.productOrigin({ pack_type: 'single', supplier_sku: null }), 'single');
});

test('a pack with NO supplier_sku is assembled in-house', () => {
  // GLC3317KCMY — the live example whose order line renders "Assembled".
  assert.equal(S.productOrigin({ pack_type: 'value_pack', supplier_sku: null }), 'in_house_pack');
  assert.equal(S.productOrigin({ pack_type: 'multipack', supplier_sku: '' }), 'in_house_pack');
  assert.equal(S.productOrigin({ pack_type: 'value_pack', supplier_sku: '   ' }), 'in_house_pack',
    'whitespace is not a supplier code');
});

test('a pack WITH its own supplier_sku is bought pre-boxed', () => {
  // GLC3317CMY — supplier_sku "B3317CMY".
  assert.equal(S.productOrigin({ pack_type: 'value_pack', supplier_sku: 'B3317CMY' }), 'supplier_pack');
  assert.equal(S.productOrigin({ pack_type: 'multipack', supplier_sku: 'HI45T' }), 'supplier_pack');
});

test('an unknown or absent pack_type yields NO answer (never a Single default)', () => {
  for (const product of [
    { pack_type: null, supplier_sku: 'X' },
    { pack_type: '', supplier_sku: null },
    { pack_type: 'bundle', supplier_sku: null },   // a value we do not recognise
    {},
    null,
    undefined,
  ]) {
    assert.equal(S.productOrigin(product), null,
      `productOrigin(${JSON.stringify(product)}) must be null, not a guess`);
  }
});

test('a real backend origin field wins over the inference', () => {
  // The day the backend ships product-level origin, it must take precedence —
  // and disagree loudly with the inference rather than being silently overridden.
  assert.equal(
    S.productOrigin({ origin: 'supplier_pack', pack_type: 'value_pack', supplier_sku: null }),
    'supplier_pack',
  );
  // A junk backend value falls back to the inference rather than rendering blank.
  assert.equal(
    S.productOrigin({ origin: 'nonsense', pack_type: 'single' }),
    'single',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Loud fail-soft — unknown renders an em-dash, never a plausible answer
// ─────────────────────────────────────────────────────────────────────────────

test('originBadge(null) is a muted em-dash, not "Single"', () => {
  const html = S.originBadge(null);
  assert.match(html, /admin-text-muted/);
  assert.match(html, /—/);
  assert.ok(!/Single/.test(html), 'an unknown origin must never read as "Single"');
});

test('originBadge renders the badge class the CSS already styles', () => {
  assert.match(S.originBadge('in_house_pack'), /admin-badge admin-badge--in-house/);
  assert.match(S.originBadge('supplier_pack'), /admin-badge admin-badge--supplier-pack/);
  assert.match(S.originBadge('single'), /admin-badge admin-badge--single/);
});

test('the three origin badge styles exist in admin.css', () => {
  for (const cls of ['in-house', 'supplier-pack', 'single']) {
    assert.match(CSS, new RegExp(`\\.admin-badge--${cls}\\s*\\{`),
      `.admin-badge--${cls} must be styled`);
  }
});

test("supplier 'unknown' is an absence, not a supplier named Unknown", () => {
  assert.equal(S.supplierLabel('unknown'), null);
  assert.equal(S.supplierLabel(''), null);
  assert.equal(S.supplierLabel(null), null);
  assert.equal(S.supplierLabel(undefined), null);
  const cell = S.productSupplierCell({ supplier: 'unknown' });
  assert.match(cell, /admin-text-muted/);
  assert.ok(!/[Uu]nknown</.test(cell), 'the word "unknown" must not be printed as a supplier name');
});

test('known supplier slugs keep the casing the backend prints on order lines', () => {
  assert.equal(S.supplierLabel('dsnz'), 'DSNZ');
  assert.equal(S.supplierLabel('DSNZ'), 'DSNZ');
  assert.equal(S.supplierLabel('augmento'), 'Augmento');
});

test('an unmapped supplier slug is shown, with the raw value kept in the tooltip', () => {
  assert.equal(S.supplierLabel('okin'), 'Okin');
  const cell = S.productSupplierCell({ supplier: 'brand-new-co' });
  assert.match(cell, /Brand-new-co/);
  assert.match(cell, /stored as/, 'the raw slug must survive in the tooltip');
});

test('supplierCell (order lines) still de-duplicates names and tooltips constituents', () => {
  const html = S.supplierCell({
    suppliers: [
      { name: 'Ink Depot NZ', color: 'Cyan' },
      { name: 'Ink Depot NZ', color: 'Magenta' },
      { name: 'Cartridge World AU', color: 'Yellow' },
    ],
  });
  assert.match(html, /Ink Depot NZ, Cartridge World AU/);
  assert.match(html, /Cyan/);
  assert.match(html, /Yellow/);
  assert.equal(S.supplierCell({ suppliers: [] }).includes('admin-text-muted'), true);
  assert.equal(S.supplierCell({}).includes('admin-text-muted'), true);
});

test('rendered values are HTML-escaped', () => {
  const cell = S.productSupplierCell({ supplier: '<script>x</script>' });
  assert.ok(!/<script>/.test(cell), 'supplier name must be escaped');
  const order = S.supplierCell({ suppliers: [{ name: '"><img src=x onerror=1>' }] });
  assert.ok(!/<img/.test(order), 'order supplier name must be escaped');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Products page wiring
// ─────────────────────────────────────────────────────────────────────────────

test('the products query selects the columns the cells need', () => {
  const m = PRODUCTS.match(/const selectCols = '([^']+)'/);
  assert.ok(m, 'selectCols must exist');
  for (const col of ['supplier', 'supplier_sku', 'pack_type']) {
    assert.ok(new RegExp(`(^|[ ,])${col}([ ,]|$)`).test(m[1]),
      `selectCols must fetch ${col} — the Origin cell is derived from pack_type + supplier_sku`);
  }
});

test('both columns are registered with the Columns picker and ship visible', () => {
  assert.match(PRODUCTS, /key:\s*'supplier',\s*label:\s*'Supplier'/);
  assert.match(PRODUCTS, /key:\s*'origin',\s*label:\s*'Origin'/);
  const labels = PRODUCTS.match(/const COLUMN_PICKER_LABELS\s*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(labels, 'COLUMN_PICKER_LABELS must exist');
  assert.match(labels[1], /supplier:/, 'Supplier needs a picker label');
  assert.match(labels[1], /origin:/, 'Origin needs a picker label');
  const hidden = PRODUCTS.match(/const DEFAULT_HIDDEN_COLUMNS\s*=\s*\[([^\]]*)\]/);
  assert.ok(hidden, 'DEFAULT_HIDDEN_COLUMNS must exist');
  assert.ok(!/'supplier'|'origin'/.test(hidden[1]),
    'both columns ship visible by default');
});

test('Origin is not sortable — there is no origin column to sort on', () => {
  const col = PRODUCTS.match(/key:\s*'origin',[\s\S]{0,200}?\n\s*\}/);
  assert.ok(col, 'the origin column definition must be findable');
  assert.ok(!/sortable:\s*true/.test(col[0]),
    'Origin is derived client-side; a sortable header would sort on a column the DB does not have');
});

test('both columns declare an explicit width (table-layout:fixed invariant, ERR-036)', () => {
  for (const cls of ['col-w-supplier', 'col-w-origin']) {
    assert.match(PRODUCTS, new RegExp(`className:\\s*'${cls}'`),
      `a column must use ${cls}`);
    assert.match(CSS, new RegExp(`\\.admin-table td\\.${cls}[^{]*\\{[^}]*width:\\s*\\d+px`),
      `${cls} must declare a px width — Name is the only auto-width absorber`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4b. Name must survive the two extra columns (the ERR-123 regression)
// ─────────────────────────────────────────────────────────────────────────────
//
// Adding Supplier + Origin to an already-full owner table pushed the declared
// widths past the container. Under table-layout:fixed a CELL's min-width cannot
// widen the TABLE, so Name — the sole auto column — was handed what was left:
// 42px at a 1512px viewport, i.e. no product name at all. The table now carries
// its own min-width so it can outgrow the wrapper and scroll instead.

test('the colsized table takes its min-width from a CSS variable', () => {
  assert.match(CSS, /\.admin-table--colsized\s*\{[^}]*min-width:\s*var\(--admin-table-min/,
    'without a table min-width, Name collapses once the fixed columns fill the container');
});

test('the min-width is published before the FIRST paint, not just on picker change', () => {
  assert.match(PRODUCTS, /function applyTableMinWidth/);
  // Set for the initial DataTable construction…
  assert.match(PRODUCTS, /applyTableMinWidth\(initialColumns\)[\s\S]{0,200}?new DataTable/,
    'the opening render would otherwise be the collapsed one');
  // …and recomputed whenever the visible set changes.
  assert.match(PRODUCTS, /function applyColumnVisibility\(\)[\s\S]{0,300}?applyTableMinWidth\(visible\)/,
    'hiding/showing a column changes the required width');
});

test('every width in COLUMN_WIDTH_PX matches what admin.css actually declares', () => {
  // The JS map exists only because JS knows which columns are VISIBLE and CSS
  // does not. If the two disagree, the table reserves the wrong width and Name
  // silently shrinks again — so pin every entry against the stylesheet.
  const map = PRODUCTS.match(/const COLUMN_WIDTH_PX\s*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(map, 'COLUMN_WIDTH_PX must exist');
  const entries = [...map[1].matchAll(/'([\w-]+)':\s*(\d+)/g)].map(m => [m[1], Number(m[2])]);
  assert.ok(entries.length >= 12, `expected the full width map, found ${entries.length}`);
  for (const [cls, px] of entries) {
    const selector = cls.startsWith('col-w-')
      ? new RegExp(`\\.admin-table td\\.${cls}[^{]*\\{([^}]*)\\}`)
      : new RegExp(`\\.admin-table \\.${cls}\\s*\\{([^}]*)\\}`);
    const rule = CSS.match(selector);
    assert.ok(rule, `${cls} must have a width rule in admin.css`);
    const declared = rule[1].match(/width:\s*(\d+)px/);
    assert.ok(declared, `${cls} must declare a px width`);
    assert.equal(Number(declared[1]), px,
      `COLUMN_WIDTH_PX['${cls}'] is ${px}px but admin.css says ${declared[1]}px`);
  }
});

test("Name's floor in JS matches its floor in CSS", () => {
  const js = PRODUCTS.match(/const NAME_MIN_PX\s*=\s*(\d+)/);
  assert.ok(js, 'NAME_MIN_PX must exist');
  const css = CSS.match(/\.admin-table--colsized td\.col-w-name[^{]*\{[^}]*min-width:\s*(\d+)px/);
  assert.ok(css, 'the colsized Name rule must declare a min-width');
  assert.equal(Number(js[1]), Number(css[1]),
    'the reserved Name width must equal the width Name is actually given');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The Supplier filter — one vocabulary, and never a silent no-op
// ─────────────────────────────────────────────────────────────────────────────

test('the filter <select> is built from the shared value list', () => {
  assert.match(PRODUCTS, /id="supplier-filter"/, 'the toolbar must ship the filter');
  assert.match(PRODUCTS, /supplierFilterOptions\(_supplierFilter\)/,
    'options must come from the shared builder — a hand-written list is how filter values go dead (ERR-075)');
  const html = S.supplierFilterOptions('augmento');
  assert.match(html, /<option value="">All Suppliers<\/option>/);
  assert.match(html, /<option value="augmento" selected>Augmento<\/option>/);
  assert.match(html, /<option value="unknown">No supplier recorded<\/option>/);
});

test('every filter value is a real products.supplier value', () => {
  // Live counts 2026-07-28: dsnz 3113, augmento 789, okin 18, unknown 104 = 4024.
  assert.deepEqual(S.SUPPLIER_FILTER_VALUES, ['dsnz', 'augmento', 'okin', 'unknown']);
});

test('the supplier filter is applied in Supabase, never silently dropped', () => {
  assert.match(PRODUCTS, /query\.eq\('supplier', _supplierFilter\)/,
    'the filter must reach the query');
  assert.match(PRODUCTS, /supabaseOnlyFilter\s*=\s*!!_packFilter \|\| !!_supplierFilter/,
    'an active supplier filter must force the Supabase path — /api/admin/products has no supplier param');
  assert.match(PRODUCTS, /_supplierFilter\) Toast\.warning\('Supplier filter unavailable/,
    'the backend fallback must SAY the filter was not applied');
});

test('the export path is honest about what it can and cannot filter/carry', () => {
  assert.match(PRODUCTS, /Supplier filter is not applied to \$\{format\.toUpperCase\(\)\} exports/,
    'the CSV export cannot apply the supplier filter — say so');
  assert.match(PRODUCTS, /Supplier \/ Origin appear in the PDF export only/,
    'the CSV is backend-generated and does not carry the columns — say so');
  assert.match(PRODUCTS, /Supplier filter not applied to PDF/,
    'the PDF must warn when the export rows carry no supplier field');
});

test('the products list warns when a view cannot supply the sourcing fields', () => {
  // An em-dash means "unknown". If a whole VIEW lacks the field, "unknown" is the
  // wrong story — it is "not loaded". The difference must be spoken aloud.
  assert.match(PRODUCTS, /function warnIfSourcingFieldsMissing/);
  assert.match(PRODUCTS, /not loaded/, 'the warning must distinguish not-loaded from none');
});
