/**
 * Product-type vocabulary — Aug 2026 (`maintenance_box`)
 * =====================================================
 *
 * The backend added a `product_type` on 2026-08-13 (a8fff8f, migration 136) for
 * waste-ink collectors: `maintenance_box`. The handoff called it "~2 small
 * changes (one <option>, one error-toast tweak)".
 *
 * It was not. The frontend was carrying SIX independent product-type
 * vocabularies, and the new value was missing from all six:
 *
 *   1. admin/utils/product-types.js  — the "All Types" filter menu
 *   2. admin/pages/products.js       — the New Product modal's type <select>
 *   3. admin/pages/products.js       — the Edit modal's type <select> (a
 *                                      byte-for-byte copy of #2)
 *   4. admin/pages/products.js       — generateSEO()'s private label map
 *   5. api.js                        — _CATEGORY_PRODUCT_TYPES.drums
 *   6. shop-page.js                  — three longhand `consumable` predicates
 *      (+ product-detail-page.js, shipping.js, admin/utils/product-codes.js)
 *
 * None of them throw on an unknown type. They return zero rows, or an empty
 * label, or quietly file the product under "ink" — which is why the same class
 * of bug has now been logged four times: ERR-075 (`drum`/`paper` filter values
 * matching nothing for months), ERR-132 (a type falling through to the wrong
 * category), ERR-150 and ERR-160 (one feature vanishing twice, at a parser and
 * then at a call site).
 *
 * The lesson from ERR-160, verbatim: "every surface calls X" is a list nobody
 * maintains — put enrolment in a TEST. This is that test. A new product_type
 * that is not enrolled everywhere fails here, by name, before it ships.
 *
 * The same run also pins the two facts that made the Aug 2026 report confusing:
 *   - `maintenance_kit` is a PHANTOM (0 rows live, not in the backend enum) and
 *     must never be offered again — but must still render a label if a row
 *     turns up, because removing a fallback is a behaviour change, not cleanup.
 *   - buildSelect() must keep its legacy branch, which is the only reason
 *     GT502's type was NOT silently rewritten to `ink_cartridge` on save while
 *     the option was missing.
 *
 * Live counts behind the assertions (Supabase, 2026-08-14):
 *   maintenance_box 4 · maintenance_kit 0 · fuser_kit 50 · waste_toner 41 ·
 *   belt_unit 11 · drum_unit 183 · fax_film 5 · fax_film_refill 2
 * `npm run audit:types` re-checks that against production on demand.
 *
 * Run: node --test tests/product-type-vocabulary-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const READ = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const TYPES_SRC    = READ('inkcartridges/js/admin/utils/product-types.js');
const CODES_SRC    = READ('inkcartridges/js/admin/utils/product-codes.js');
const PRODUCTS_SRC = READ('inkcartridges/js/admin/pages/products.js');
const ADMIN_API    = READ('inkcartridges/js/admin/api.js');
const API_SRC      = READ('inkcartridges/js/api.js');
const SHOP_SRC     = READ('inkcartridges/js/shop-page.js');
const PDP_SRC      = READ('inkcartridges/js/product-detail-page.js');
const SHIPPING_SRC = READ('inkcartridges/js/shipping.js');

const TYPES_MODULE = path.join(ROOT, 'inkcartridges/js/admin/utils/product-types.js');

/**
 * The enum the API accepts, transcribed from the backend handoff
 * (maintenance-box-product-type-aug2026.md §"The full enum"). Declared HERE and
 * nowhere else in the test: if the shipped vocabulary and this list disagree,
 * the disagreement is the failure. Order is the backend's own.
 */
const BACKEND_ENUM = [
  'ink_cartridge', 'ink_bottle',
  'toner_cartridge', 'drum_unit', 'waste_toner', 'maintenance_box', 'belt_unit', 'fuser_kit',
  'fax_film', 'fax_film_refill',
  'printer_ribbon', 'typewriter_ribbon', 'correction_tape', 'label_tape', 'photo_paper',
  'printer',
];

/** Every non-cartridge consumable — the /shop "Drums & Supplies" tile. */
const DRUMS_FAMILY = [
  'drum_unit', 'waste_toner', 'maintenance_box', 'belt_unit', 'fuser_kit',
  'fax_film', 'fax_film_refill',
];

// Extract a top-level function (or object method) body by brace matching.
function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `signature not found: ${signature}`);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const esc = (s) => String(s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The array literal assigned to `name` in `src`, as string values. */
function arrayLiteral(src, name) {
  const m = src.match(new RegExp(`${name}\\s*[:=]\\s*\\[([^\\]]*)\\]`));
  assert.ok(m, `${name} must be an array literal`);
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The shipped vocabulary IS the backend enum
// ─────────────────────────────────────────────────────────────────────────────

test('PRODUCT_TYPE_OPTIONS is the backend enum, in the backend order', async () => {
  const { PRODUCT_TYPE_OPTIONS, PRODUCT_TYPES } = await import(TYPES_MODULE);
  assert.deepEqual(PRODUCT_TYPES, BACKEND_ENUM,
    'the editor menu must offer exactly what POST/PUT /api/admin/products accepts — no more (a value the API rejects), no less (a product nobody can create)');
  assert.equal(PRODUCT_TYPE_OPTIONS.length, BACKEND_ENUM.length);
  for (const o of PRODUCT_TYPE_OPTIONS) {
    assert.ok(o.label && o.label !== o.value,
      `${o.value} needs a human label — a raw enum string in a dropdown is not a label`);
  }
});

test('Maintenance Box sits directly after Waste Toner, as the brief specifies', async () => {
  const { PRODUCT_TYPES } = await import(TYPES_MODULE);
  assert.equal(PRODUCT_TYPES[PRODUCT_TYPES.indexOf('waste_toner') + 1], 'maintenance_box');
  const { PRODUCT_TYPE_OPTIONS } = await import(TYPES_MODULE);
  assert.equal(PRODUCT_TYPE_OPTIONS.find(o => o.value === 'maintenance_box').label, 'Maintenance Box',
    'the customer-facing type label in names and SEO is "Maintenance Box"');
});

test('every enum member has an admin (plural) label too', async () => {
  const { PRODUCT_TYPE_LABELS } = await import(TYPES_MODULE);
  for (const t of BACKEND_ENUM) {
    assert.ok(PRODUCT_TYPE_LABELS[t], `PRODUCT_TYPE_LABELS is missing ${t} — the drawer would print the raw enum`);
  }
});

test('the menus really emit the option — not just the data behind them', async () => {
  const { productTypeOptions, typeFilterOptions } = await import(TYPES_MODULE);
  assert.match(productTypeOptions(), /<option value="maintenance_box">Maintenance Box<\/option>/);
  assert.match(productTypeOptions('maintenance_box'), /<option value="maintenance_box" selected>/);
  assert.match(typeFilterOptions(), /<option value="maintenance_box">Maintenance Box<\/option>/,
    'the products-list type filter is a separate hardcoded list — the brief asks for the option there too');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. maintenance_kit — retired LOUDLY, never offered
// ─────────────────────────────────────────────────────────────────────────────

test('maintenance_kit is offered by nothing', async () => {
  const { PRODUCT_TYPES, TYPE_FILTER_OPTIONS, PRODUCT_TYPE_LABELS } = await import(TYPES_MODULE);
  assert.ok(!PRODUCT_TYPES.includes('maintenance_kit'),
    'maintenance_kit is not in the backend enum — "Maintenance Kit"/"Maint Kit" feed names classify as fuser_kit');
  assert.ok(!TYPE_FILTER_OPTIONS.some(o => o.value === 'maintenance_kit'),
    'it matched ZERO rows every time it was offered — the drum/paper trap (ERR-075) with a different name');
  assert.ok(!PRODUCT_TYPE_LABELS.maintenance_kit,
    'a retired type does not belong in the canonical label map');
});

test('but a row still carrying it renders a human label, marked retired', async () => {
  const { productTypeLabel } = await import(TYPES_MODULE);
  assert.equal(productTypeLabel('maintenance_kit'), 'Maintenance Kit (retired)',
    'removing a fallback is a behaviour change, not cleanup (ERR-158) — retire it loudly, do not make it disappear');
  assert.equal(productTypeLabel('maintenance_box'), 'Maintenance Boxes');
  assert.equal(productTypeLabel('who_knows'), 'who_knows', 'an unknown type shows itself rather than vanishing');
  assert.equal(productTypeLabel(''), '');
});

test('no live code path anywhere still names maintenance_kit', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8');
        // Strip comments — the retirement is documented in several of them.
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const rel = path.relative(ROOT, p);
        if (rel.endsWith('utils/product-types.js')) continue;   // the RETIRED map, by design
        if (/maintenance_kit/.test(code)) offenders.push(rel);
      }
    }
  };
  walk(path.join(ROOT, 'inkcartridges/js'));
  assert.deepEqual(offenders, [],
    `these files still reference the phantom type: ${offenders.join(', ')}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Enrolment — every surface that names a type family names this one
// ─────────────────────────────────────────────────────────────────────────────

test('admin editor modals build from the shared vocabulary, not a hand-written list', () => {
  assert.match(PRODUCTS_SRC, /import \{[\s\S]*?PRODUCT_TYPE_OPTIONS[\s\S]*?\} from '\.\.\/utils\/product-types\.js'/,
    'products.js must import the editor menu');

  // BOTH modals must still build the type <select>, and neither may hand-write
  // its options. Aug 2026 (ERR-187): the New Product modal now passes
  // `typeOptions` rather than PRODUCT_TYPE_OPTIONS directly, because the
  // catalogue pathway narrows the menu to the types the category being added to
  // actually contains (walking into "Ink" must not offer toner). That is still
  // the shared vocabulary — it is a FILTER OF IT, asserted below — so the
  // enrolment guarantee this test exists for is intact: a new enum member
  // reaches both menus through PRODUCT_TYPE_OPTIONS and nowhere else.
  const uses = PRODUCTS_SRC.match(/buildSelect\('edit-type', (\w+)/g) || [];
  assert.equal(uses.length, 2,
    'BOTH the New Product and Edit modals must build the type <select> via buildSelect');
  assert.ok(uses.includes("buildSelect('edit-type', PRODUCT_TYPE_OPTIONS"),
    'the Edit modal must offer the full vocabulary — an existing row can hold any type');
  assert.ok(uses.includes("buildSelect('edit-type', typeOptions"),
    'the New modal must offer the pathway-narrowed menu');

  // The narrowing must be derived, never re-declared. A literal here is exactly
  // how modals #2 and #3 drifted in the first place.
  assert.match(PRODUCTS_SRC, /const typeOptions = ctxTypes\.length\s*\n?\s*\? PRODUCT_TYPE_OPTIONS\.filter/,
    'typeOptions must be a filter of PRODUCT_TYPE_OPTIONS');
  assert.match(PRODUCTS_SRC, /:\s*PRODUCT_TYPE_OPTIONS;/,
    'with no pathway context the New modal must fall back to the FULL vocabulary, '
    + 'or a brandless one-off could not be given an unlisted type');

  assert.ok(!/value:\s*'ink_cartridge'/.test(PRODUCTS_SRC),
    'a hand-written product-type option array is exactly how modals #2 and #3 drifted — there must be none left in products.js');
});

test('generateSEO takes its type noun from the vocabulary', () => {
  assert.ok(!/typeLabel = \{[\s\S]*?ink_cartridge:/.test(PRODUCTS_SRC),
    'generateSEO must not carry a private label map');
  assert.match(PRODUCTS_SRC, /const typeLabel = type === 'ribbon' \? 'Printer Ribbon' : productTypeNoun\(type\)/);
});

test('api.js and shop-page.js agree on the drums family, to the value', () => {
  const apiDrums = arrayLiteral(API_SRC, 'drums');
  const shopDrums = arrayLiteral(SHOP_SRC, 'const CONSUMABLE_PRODUCT_TYPES');
  assert.deepEqual(apiDrums, DRUMS_FAMILY,
    'API._CATEGORY_PRODUCT_TYPES.drums drives the manual-code recovery path');
  assert.deepEqual(shopDrums, DRUMS_FAMILY,
    'shop-page CONSUMABLE_PRODUCT_TYPES drives the brand facet COUNT — a count that disagrees with the query it labels is a wrong number, not a missing one');
  assert.deepEqual(apiDrums, shopDrums, 'request side and facet side must be the same membership');
});

test('shop-page has no longhand consumable predicate left', () => {
  assert.ok(!/categoryId === 'consumable'\) return productType ===/.test(SHOP_SRC),
    'the three longhand predicates are why one missed type became three wrong answers');
  const uses = SHOP_SRC.match(/CONSUMABLE_PRODUCT_TYPES\.includes\(/g) || [];
  assert.equal(uses.length, 3, 'all three consumable predicates must read the shared constant');
});

test('the drawer code-picker maps every drums-family type to a category', () => {
  for (const t of DRUMS_FAMILY) {
    assert.match(CODES_SRC, new RegExp(`${t}:\\s*'drums'`),
      `PRODUCT_TYPE_TO_SHOP_CATEGORY is missing ${t} — the code picker would have nothing to scope against`);
  }
});

test('every enum member is enrolled in a shop category or is deliberately exempt', () => {
  // `printer` has its own admin tab and its own /shop treatment; it is the only
  // enum member with no code-drilldown category. Everything else must map.
  const EXEMPT = new Set(['printer']);
  for (const t of BACKEND_ENUM) {
    if (EXEMPT.has(t)) continue;
    assert.match(CODES_SRC, new RegExp(`\\b${t}:\\s*'(ink|toner|drums|label|paper|ribbons)'`),
      `${t} has no /shop category — add it to PRODUCT_TYPE_TO_SHOP_CATEGORY or to the exemption list with a reason`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. buildSelect — the guard that stopped GT502 being silently retyped
// ─────────────────────────────────────────────────────────────────────────────

function loadBuildSelect() {
  const src = extractFunction(PRODUCTS_SRC, 'function buildSelect(');
  return new Function('esc', `${src}; return buildSelect;`)(esc);
}

test('a known type selects its real option, with no "(legacy)" anywhere', async () => {
  const { PRODUCT_TYPE_OPTIONS } = await import(TYPES_MODULE);
  const html = loadBuildSelect()('edit-type', PRODUCT_TYPE_OPTIONS, 'maintenance_box');
  assert.match(html, /<option value="maintenance_box" selected>Maintenance Box<\/option>/,
    'opening GT502 must show "Maintenance Box" selected — this is acceptance item 1');
  assert.ok(!/legacy/.test(html), 'a canonical value must not render as a legacy carry-over');
});

test('an UNKNOWN type is preserved, never silently swapped for the first option', async () => {
  const { PRODUCT_TYPE_OPTIONS } = await import(TYPES_MODULE);
  const html = loadBuildSelect()('edit-type', PRODUCT_TYPE_OPTIONS, 'some_future_type');
  assert.match(html, /<option value="some_future_type" selected>some_future_type \(legacy\)<\/option>/,
    'without this branch the browser auto-selects option #1 and Save writes ink_cartridge over the real value — the corruption the brief was worried about');
  assert.ok(!/<option value="ink_cartridge" selected>/.test(html));
});

test('the retired type still round-trips rather than being rewritten', async () => {
  const { PRODUCT_TYPE_OPTIONS } = await import(TYPES_MODULE);
  const html = loadBuildSelect()('edit-type', PRODUCT_TYPE_OPTIONS, 'maintenance_kit');
  assert.match(html, /<option value="maintenance_kit" selected>/,
    'retiring a value from the MENU must not change what a save writes for a row that has it');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. generateSEO — executed, because the bug was an empty string
// ─────────────────────────────────────────────────────────────────────────────

async function loadGenerateSEO() {
  const { productTypeNoun } = await import(TYPES_MODULE);
  const src = extractFunction(PRODUCTS_SRC, 'function generateSEO(');
  return new Function('productTypeNoun', `${src}; return generateSEO;`)(productTypeNoun);
}

test('a maintenance box gets a product noun in its meta title and description', async () => {
  const generateSEO = await loadGenerateSEO();
  const seo = generateSEO({
    sku: 'GT502', name: 'Epson Genuine T502 Maintenance Box',
    brand: 'Epson', product_type: 'maintenance_box', source: 'genuine', color: null,
  });
  assert.match(seo.meta_title, /Maintenance Box/,
    'the type noun is the whole point of the title pattern');
  assert.match(seo.meta_description, /maintenance box/);
  assert.ok(!/ {2}/.test(seo.meta_title),
    'a missing type label used to leave a doubled space where the noun should be');
  assert.ok(!/ {2}/.test(seo.meta_description));
});

test('a too-long title drops the source qualifier before it drops the noun', async () => {
  const generateSEO = await loadGenerateSEO();
  // Full pattern = 65 chars, so something has to go. What goes is " - Genuine",
  // not the words that say what the product is.
  const seo = generateSEO({
    name: 'Epson Genuine T502 Maintenance Box', brand: 'Epson',
    product_type: 'maintenance_box', source: 'genuine',
  });
  assert.equal(seo.meta_title, 'Buy Epson T502 Maintenance Box NZ | InkCartridges.co.nz');
  assert.ok(seo.meta_title.length <= 60);

  // Every enum member must name itself WHENEVER THE NOUN FITS. The 60-char cap
  // is the shipped SEO rule and still wins — "Buy Brother LC3317 Typewriter
  // Ribbon NZ | …" is 61 — but nothing may be dropped with room to spare.
  const { productTypeNoun } = await import(TYPES_MODULE);
  for (const t of BACKEND_ENUM) {
    const s = generateSEO({ name: 'Brother LC3317 Thing', brand: 'Brother', product_type: t, source: 'compatible' });
    const withNoun = `Buy Brother LC3317 ${productTypeNoun(t)} NZ | InkCartridges.co.nz`;
    if (withNoun.length <= 60) {
      assert.ok(s.meta_title.includes(productTypeNoun(t)),
        `${t}: "${s.meta_title}" (${s.meta_title.length} chars) dropped its type noun when it fitted in ${withNoun.length}`);
    }
    assert.ok(s.meta_title.length <= 60, `${t}: title exceeded the 60-char budget`);
  }
});

test('every enum member produces a noun — no silent blanks left', async () => {
  const generateSEO = await loadGenerateSEO();
  for (const t of BACKEND_ENUM) {
    const seo = generateSEO({ name: 'Brand X123 Thing', brand: 'Brand', product_type: t, source: 'genuine' });
    assert.ok(!/ {2}/.test(seo.meta_title), `${t} produced a doubled space in the title — its label is missing`);
    assert.ok(!/ {2}/.test(seo.meta_description), `${t} produced a doubled space in the description`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Storefront — the PDP must not call a maintenance box an ink cartridge
// ─────────────────────────────────────────────────────────────────────────────

function loadNormalizeProductType() {
  const src = extractFunction(PDP_SRC, 'normalizeProductType(pt) {');
  return new Function(`const o = { ${src} }; return o.normalizeProductType;`)();
}

test('the PDP files a maintenance box under the drums family', () => {
  const normalize = loadNormalizeProductType();
  for (const t of DRUMS_FAMILY) {
    assert.equal(normalize(t), 'drum',
      `${t} must resolve to 'drum' — falling through reaches normalizeCategory('CON-INK') → 'ink' and Related Products queries the wrong family (ERR-132)`);
  }
  assert.equal(normalize('ink_cartridge'), 'ink');
  assert.equal(normalize('toner_cartridge'), 'toner');
  assert.equal(normalize('maintenance_kit'), null, 'the phantom resolves to nothing, as it should');
});

function loadInferProductType() {
  const drumTypes = PDP_SRC.slice(PDP_SRC.indexOf('const DRUM_TYPES = ['));
  const decl = drumTypes.slice(0, drumTypes.indexOf('\n') + 1);
  const fn = extractFunction(PDP_SRC, 'const inferProductType = (p) => {');
  return new Function(`${decl}${fn}; return inferProductType;`)();
}

test('related-products grids bucket the drums family as drums', () => {
  const infer = loadInferProductType();
  assert.equal(infer({ product_type: 'maintenance_box', name: 'Epson Genuine T502 Maintenance Box' }), 'drum');
  assert.equal(infer({ product_type: 'drum_unit', name: 'Brother DR-2425 Drum Unit' }), 'drum');
  assert.equal(infer({ product_type: 'ink_cartridge', name: 'Epson T502BK' }), 'ink');
  assert.equal(infer({ product_type: 'toner_cartridge', name: 'HP CF400A' }), 'toner');
  assert.equal(infer({ product_type: 'printer_ribbon', name: 'Epson ERC-38' }), 'ribbon');
  // No product_type at all — the name has to carry it.
  assert.equal(infer({ name: 'Canon MC-G01 Maintenance Cart' }), 'drum');
  assert.equal(infer({ name: 'Epson S2100 Maintenance Tank' }), 'drum');
  assert.equal(infer({ name: 'OKI C831N Transfer Belt' }), 'drum');
});

test('the drums grid is rendered, under the /shop category name', () => {
  assert.match(PDP_SRC, /productType === 'drum' \? 'Drums & Supplies'/,
    'a grid of maintenance boxes and drums headed "<Brand> Ink Cartridges" is a false statement about the product, on the product\'s own page (ERR-165)');
  assert.match(PDP_SRC, /\$\{buildTypeGrid\(drums, 'drum'\)\}/,
    'bucketing them is pointless if the grid is never rendered — a hidden section is a claim (ERR-134)');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Shipping
// ─────────────────────────────────────────────────────────────────────────────

test('a maintenance box counts as a drum for split-shipment detection', () => {
  const src = extractFunction(SHIPPING_SRC, 'maySplitShipment(items) {');
  const maySplit = new Function(`const o = { ${src} }; return o.maySplitShipment;`)();
  assert.equal(maySplit([
    { product_type: 'maintenance_box', name: 'Epson Genuine T502 Maintenance Box' },
    { product_type: 'ink_cartridge', name: 'Epson T502BK' },
  ]), true, 'drum-family + ink is the split-shipment case; a maintenance box used to fall through to "accessory"');
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Write errors carry the backend's own message
// ─────────────────────────────────────────────────────────────────────────────

test('product create and update build their Error from the envelope helper', () => {
  assert.match(ADMIN_API, /const resp = await window\.API\.post\('\/api\/admin\/products', data\);\s*\n\s*if \(resp && resp\.ok === false\) throw productWriteError\(resp, 'Create failed'\)/,
    'createProduct threw a BARE new Error(msg) — no code, no status, no request_id (ERR-164)');
  assert.match(ADMIN_API, /await window\.API\.put\(`\/api\/admin\/products\/\$\{productId\}`, data\);\s*\n\s*if \(resp && resp\.ok === false\) throw productWriteError\(resp, 'Update failed'\)/);
  assert.match(ADMIN_API, /function productWriteError\(resp, fallbackMessage\) \{\s*\n\s*const e = errorFromEnvelope\(resp, fallbackMessage\);/,
    'the product-write helper must extend errorFromEnvelope, not replace it');
});

test('productWriteError keeps the code, the ref and the per-field details', () => {
  const src = extractFunction(ADMIN_API, 'function errorFromEnvelope(resp, fallbackMessage)')
    + '\n' + extractFunction(ADMIN_API, 'function productWriteError(resp, fallbackMessage)');
  const productWriteError = new Function(`${src}; return productWriteError;`)();

  // The 500 that hid the real problem on 2026-08-13.
  const generic = productWriteError(
    { ok: false, error: 'Failed to create product', code: 'INTERNAL_ERROR', status: 500, request_id: 'abcdef1234567890' },
    'Create failed');
  assert.equal(generic.message, 'Failed to create product (ref abcdef12)');
  assert.equal(generic.code, 'INTERNAL_ERROR');
  assert.equal(generic.status, 500);

  // What the backend answers now.
  const grammar = "SKU 'E502' doesn't match the site SKU grammar. Singles/value packs: G or C + model code.";
  const typed = productWriteError({ ok: false, error: { code: 'BAD_REQUEST', message: grammar }, status: 400 }, 'Create failed');
  assert.equal(typed.message, grammar, 'the actionable sentence must survive intact');
  assert.equal(typed.code, 'BAD_REQUEST', 'without a code there is nothing to branch on but English prose (ERR-077/132)');

  // A validation list is user copy and gets appended; an object is payload and does not.
  const listed = productWriteError({ ok: false, error: 'Invalid product', details: [{ message: 'name: required' }, 'sku: too long'] }, 'Create failed');
  assert.equal(listed.message, 'Invalid product: name: required, sku: too long');
  const payload = productWriteError({ ok: false, error: 'Invalid product', details: { suggestion: { code: 'X' } } }, 'Create failed');
  assert.equal(payload.message, 'Invalid product', 'a details OBJECT must never be stringified into user copy');
  assert.deepEqual(payload.details, { suggestion: { code: 'X' } }, 'but it must still be attached for callers');

  // Never "[object Object]", whatever shape arrives.
  const weird = productWriteError({ ok: false, error: { code: 'ODD' } }, 'Create failed');
  assert.ok(!/\[object Object\]/.test(weird.message));
});

test('both save handlers route failures through showProductWriteError', () => {
  const uses = PRODUCTS_SRC.match(/showProductWriteError\(modal, '(Create failed|Save failed)', e\)/g) || [];
  assert.equal(uses.length, 2, 'the create modal and the edit modal must both surface the backend message');
  assert.ok(!/Toast\.error\(`Create failed: \$\{e\.message\}`\)/.test(PRODUCTS_SRC),
    'the hardcoded toast is what hid the real problem on 2026-08-13');
  assert.match(PRODUCTS_SRC, /Toast\.error\(text, message\.length > 90 \? 16000 : undefined\)/,
    'a ~250-character validation sentence needs longer than the 6s default to read');
  assert.match(PRODUCTS_SRC, /el\.closest\('\.admin-product-modal__tab-panel'\)\?\.dataset\.panel/,
    'the tab to reveal must come from the field itself — the two modals have different tab orders');
});
