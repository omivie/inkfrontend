/**
 * Catalogue pathway — brand → category → code → product (Aug 2026, ERR-187)
 * =========================================================================
 *
 * Every new product now starts by WALKING to where it belongs — the Browse tab
 * on /admin#products — rather than by opening a blank form. Brand, category and
 * code come from the walk, and the /shop chip materialises when the product
 * saves.
 *
 * The pathway is a NAVIGATOR, not a create hierarchy, because three of its four
 * levels are not records: a category is a fixed map over a backend enum, and a
 * code is DERIVED from sku/name at query time (`_enrichSeriesCodes`) with
 * `product_codes` as an override layer only. A code with zero products cannot
 * be stored, so "create a code then fill it" would render a chip that appears
 * nowhere — the ship-it-invisible bug family (ERR-075/125/163).
 *
 * What this file pins, in order of how badly it would hurt to lose:
 *
 *   1. THE TWO MIRRORED CONSTANTS. `SHOP_BRAND_ALLOWLIST` mirrors
 *      shop-page.js's `preferredOrder`, and `CATEGORY_PRODUCT_TYPES_FALLBACK`
 *      mirrors api.js's `_CATEGORY_PRODUCT_TYPES`. Both are copies, and a copy
 *      nobody checks is a copy that drifts. These two tests are the check.
 *   2. THE OVERRIDE TRAP. `needsCodeOverride` must stay FALSE when the SKU
 *      already derives the code. Writing an override materialises a product
 *      into `product_codes`, and from then on its derived codes are ignored
 *      permanently. `mergeCodeIntoEffective` must never drop an existing code —
 *      `setProductCodes` replaces the whole set, so a partial write silently
 *      erases every other chip the product appears under.
 *   3. RIBBONS ARE NEVER DERIVED (ERR-085/086). The owner directive is that
 *      ribbons are not automated in any aspect except page design. A derivation
 *      leaking into the ribbon path reintroduces exactly what was removed.
 *   4. THE BLANK ENTRY POINT STAYS GONE. `+ Add Product` must reach the
 *      pathway, not `openCreateProductModal()` with no context.
 *   5. THE PROBE STAYS READ-ONLY. No write verb, no --record, no baseline.
 *
 * Run with: node --test tests/catalogue-pathway-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'inkcartridges');
const ADMIN = path.join(SITE, 'js', 'admin');
const read = (p) => fs.readFileSync(p, 'utf8');

const shopPageJs = read(path.join(SITE, 'js', 'shop-page.js'));
const apiJs = read(path.join(SITE, 'js', 'api.js'));
const productsJs = read(path.join(ADMIN, 'pages', 'products.js'));
const browseJs = read(path.join(ADMIN, 'pages', 'catalogue-browse.js'));
const pathwayJs = read(path.join(ADMIN, 'utils', 'catalogue-pathway.js'));
const cssSrc = read(path.join(SITE, 'css', 'admin.css'));
const probeSrc = read(path.join(ROOT, 'scripts', 'probe-catalogue-pathway.mjs'));
const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));

/** The ESM module under test, imported once and shared. */
let M;
test.before(async () => {
  M = await import('../inkcartridges/js/admin/utils/catalogue-pathway.js');
});

// ── 1. The mirrored constants ────────────────────────────────────────────────

test('SHOP_BRAND_ALLOWLIST still equals shop-page.js preferredOrder', () => {
  // This is a MIRROR of a hardcoded filter inside renderBrands(). The shop
  // applies it as `sorted.filter(b => preferredOrder.includes(b.slug))` — a
  // brand missing from it renders no tile, with no error anywhere. The admin
  // tells the operator which brands those are, and it can only do that while
  // the two lists agree. If this fails, the shop-page array is the source and
  // catalogue-pathway.js is the stale half.
  const m = shopPageJs.match(/const\s+preferredOrder\s*=\s*\[([^\]]+)\]/);
  assert.ok(m, 'shop-page.js must still declare a preferredOrder array');
  const live = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);

  assert.deepEqual([...M.SHOP_BRAND_ALLOWLIST].sort(), [...live].sort(),
    'SHOP_BRAND_ALLOWLIST has drifted from shop-page.js preferredOrder — '
    + 'the admin would report the wrong brands as hidden from /shop');
});

test('CATEGORY_PRODUCT_TYPES_FALLBACK still equals API._CATEGORY_PRODUCT_TYPES', () => {
  // The node-side mirror of the storefront's category membership. In the
  // browser typesForCategory() reads the live object, so the running admin can
  // never disagree with the running site; this literal only serves the probe
  // and these tests. A drifted copy would certify a membership the site does
  // not have — the audit-carrying-its-own-vocabulary mistake.
  const block = apiJs.match(/_CATEGORY_PRODUCT_TYPES:\s*\{([\s\S]*?)\n\s*\},/);
  assert.ok(block, 'api.js must still declare _CATEGORY_PRODUCT_TYPES');

  const live = {};
  for (const line of block[1].split('\n')) {
    const m = line.match(/(\w+)\s*:\s*\[([^\]]*)\]/);
    if (!m) continue;
    live[m[1]] = m[2].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }

  assert.deepEqual(Object.keys(live).sort(), Object.keys(M.CATEGORY_PRODUCT_TYPES_FALLBACK).sort(),
    'the two category maps offer different categories');
  for (const key of Object.keys(live)) {
    assert.deepEqual(M.CATEGORY_PRODUCT_TYPES_FALLBACK[key], live[key],
      `category "${key}" membership has drifted from api.js`);
  }
});

test('every category in the fallback map is a real SHOP_CATEGORIES value', () => {
  const values = M.SHOP_CATEGORIES.map(c => c.value);
  for (const key of Object.keys(M.CATEGORY_PRODUCT_TYPES_FALLBACK)) {
    assert.ok(values.includes(key), `"${key}" is not offered by SHOP_CATEGORIES`);
  }
});

// ── 2. Category ↔ type ───────────────────────────────────────────────────────

test('typesForCategory returns the members, and a category is not a type', () => {
  // The reason the create form narrows its menu instead of picking a type:
  // walking into "Ink" cannot decide between ink_cartridge and ink_bottle.
  assert.deepEqual(M.typesForCategory('ink'), ['ink_cartridge', 'ink_bottle']);
  assert.ok(M.typesForCategory('drums').length >= 7, 'drums is the catch-all consumable category');
  assert.deepEqual(M.typesForCategory('nonsense'), [], 'an unknown category yields no types, never a throw');
});

test('categoryForType inverts it, and every offered type maps somewhere', () => {
  assert.equal(M.categoryForType('ink_cartridge'), 'ink');
  assert.equal(M.categoryForType('maintenance_box'), 'drums');
  assert.equal(M.categoryForType('typewriter_ribbon'), 'ribbons');
  assert.equal(M.categoryForType(''), '');

  for (const [cat, types] of Object.entries(M.CATEGORY_PRODUCT_TYPES_FALLBACK)) {
    for (const t of types) {
      assert.equal(M.categoryForType(t), cat,
        `${t} is listed under ${cat} but maps back to "${M.categoryForType(t)}"`);
    }
  }
});

test('defaultTypeForCategory is the enum-order primary, not a live count', () => {
  // Deliberately not "the most populated type": a default that moves with the
  // catalogue is a default nobody can predict.
  assert.equal(M.defaultTypeForCategory('ink'), 'ink_cartridge');
  assert.equal(M.defaultTypeForCategory('drums'), 'drum_unit');
  assert.equal(M.defaultTypeForCategory(''), '');
});

test('brandVisibleOnShop is case-insensitive and rejects unknowns', () => {
  assert.equal(M.brandVisibleOnShop('brother'), true);
  assert.equal(M.brandVisibleOnShop('BROTHER'), true);
  assert.equal(M.brandVisibleOnShop('olivetti'), false);
  assert.equal(M.brandVisibleOnShop(''), false);
  assert.equal(M.brandVisibleOnShop(null), false);
});

// ── 3. Codes: normalisation, derivation, the override trap ───────────────────

test('normCode matches the AdminAPI normaliser, slashes included', () => {
  // Pair codes (PG40/CL41) are real backend codes. Three normalisers once
  // stripped the "/", so renaming one rewrote 0 products while reporting
  // success (ERR-061). Any new normaliser must keep it.
  assert.equal(M.normCode('lc-3339'), 'LC3339');
  assert.equal(M.normCode('pg40/cl41'), 'PG40/CL41');
  assert.equal(M.normCode('//PG40//CL41//'), 'PG40/CL41');
  assert.equal(M.normCode('/'), '');
  assert.equal(M.normCode(null), '');
});

/** Install a fake storefront extractor for the derivation tests. */
function withExtractor(fn, impl) {
  const prev = globalThis.window;
  globalThis.window = { API: { _enrichSeriesCodes: impl } };
  try { return fn(); } finally { globalThis.window = prev; }
}
const derivesLC3339 = (p) => { p.series_codes = ['LC3339']; };

test('deriveCodesForSku reuses the storefront extractor', () => {
  withExtractor(() => {
    assert.deepEqual(M.deriveCodesForSku({ sku: 'CLC3339BK', name: 'x', productType: 'ink_cartridge' }), ['LC3339']);
  }, derivesLC3339);
});

test('deriveCodesForSku returns [] for RIBBONS and never calls the extractor', () => {
  // ERR-085/086: ribbons are owner-manual in every aspect except page design.
  // `deriveSeed` returns [] for them in the drawer; the pathway must match, or
  // it reintroduces exactly the auto-fill that was removed.
  let called = false;
  withExtractor(() => {
    for (const t of ['printer_ribbon', 'typewriter_ribbon', 'correction_tape']) {
      assert.deepEqual(M.deriveCodesForSku({ sku: 'C143LOT', name: 'x', productType: t }), []);
    }
  }, () => { called = true; });
  assert.equal(called, false, 'the extractor must never run for a ribbon type');
});

test('deriveCodesForSku survives a throwing extractor', () => {
  // A preview must never throw into a create flow.
  withExtractor(() => {
    assert.deepEqual(M.deriveCodesForSku({ sku: 'X', name: 'Y', productType: 'ink_cartridge' }), []);
  }, () => { throw new Error('boom'); });
});

test('collapseYield mirrors SeriesCodes.collapseYieldSuffix, anchored', () => {
  // The server collapses XL on the chip LABEL (brother · ink offers LC3339,
  // never LC3339XL) while the extractor derives the UNCOLLAPSED form from a SKU.
  // Comparing them raw calls a correctly-placed product a mismatch.
  assert.equal(M.collapseYield('LC3339XL'), 'LC3339');
  assert.equal(M.collapseYield('604XXL'), '604');
  assert.equal(M.collapseYield('LC3339'), 'LC3339');
  // Anchored: a raw SKU body must NOT collapse — only canonical codes do.
  assert.equal(M.collapseYield('604XLBK'), '604XLBK');
  // Codes that merely end in L/XL-looking text but are not the yield suffix.
  assert.equal(M.collapseYield('73N'), '73N');

  // And it must equal the shipped implementation's pattern.
  const utilsSrc = read(path.join(SITE, 'js', 'utils.js'));
  const m = utilsSrc.match(/const YIELD_SUFFIX = (\/\^.*?\/);/);
  assert.ok(m, 'utils.js must still declare YIELD_SUFFIX');
  assert.ok(pathwayJs.includes(m[1]),
    `the mirrored yield pattern has drifted from utils.js (${m[1]})`);
});

test('codeMatchesChip is the ONLY comparison — a bare === is the bug', () => {
  assert.equal(M.codeMatchesChip('LC3339XL', 'LC3339'), true, 'XL derives onto the collapsed chip');
  assert.equal(M.codeMatchesChip('LC3339', 'LC3339XL'), true, 'and the reverse');
  assert.equal(M.codeMatchesChip('LC3341', 'LC3339'), false, 'a real mismatch is still a mismatch');
  assert.equal(M.codeMatchesChip('', 'LC3339'), false);
});

test('an XL product does NOT get an override written — the trap stays shut', () => {
  // Every one of LC3339's twelve live products is an LC3339XL* SKU. Without the
  // collapse, needsCodeOverride returned true for all of them, so the create
  // flow would have written a product_codes row on every save — materialising
  // each into the override layer, where its derived codes are ignored
  // PERMANENTLY. Caught in a browser on 2026-08-30, not by a unit test.
  withExtractor(() => {
    assert.equal(M.needsCodeOverride({
      sku: 'CLC3339XLPB', name: 'x', productType: 'ink_cartridge', expectedCode: 'LC3339',
    }), false, 'an XL SKU already lands on the collapsed chip — nothing to override');
    assert.equal(M.previewCodeForSku({
      sku: 'CLC3339XLPB', name: 'x', productType: 'ink_cartridge', expectedCode: 'LC3339',
    }).state, 'match', 'and the operator must not be warned about it');
  }, (p) => { p.series_codes = ['LC3339XL']; });
});

test('previewCodeForSku distinguishes match, mismatch, none and manual', () => {
  withExtractor(() => {
    const base = { sku: 'CLC3339BK', name: 'x', productType: 'ink_cartridge' };
    assert.equal(M.previewCodeForSku({ ...base, expectedCode: 'LC3339' }).state, 'match');

    // The failure this whole feature exists to catch: a mistyped SKU derives a
    // DIFFERENT code and silently mints a one-product chip on /shop.
    const wrong = M.previewCodeForSku({ ...base, expectedCode: 'LC3341' });
    assert.equal(wrong.state, 'mismatch');
    assert.deepEqual(wrong.derived, ['LC3339']);

    assert.equal(M.previewCodeForSku({ ...base, expectedCode: '' }).state, 'none');
    assert.equal(M.previewCodeForSku({ ...base, productType: 'printer_ribbon', expectedCode: 'ABC' }).state, 'manual');
  }, derivesLC3339);
});

test('needsCodeOverride is FALSE when the SKU already derives the code', () => {
  // THE OVERRIDE TRAP. Writing to product_codes makes a product's derived
  // series_codes ignored ENTIRELY, from then on, forever — and a later
  // catalogue import that fixes its derivation would no longer reach it. A
  // product that lands correctly on its own must stay out of that table.
  withExtractor(() => {
    assert.equal(M.needsCodeOverride({ sku: 'CLC3339BK', name: 'x', productType: 'ink_cartridge', expectedCode: 'LC3339' }), false);
    assert.equal(M.needsCodeOverride({ sku: 'CLC3339BK', name: 'x', productType: 'ink_cartridge', expectedCode: 'LC3341' }), true);
    assert.equal(M.needsCodeOverride({ sku: 'x', name: 'x', productType: 'ink_cartridge', expectedCode: '' }), false);
    // Ribbons carry only what we assign, so an assignment is always a write.
    assert.equal(M.needsCodeOverride({ sku: 'C143LOT', name: 'x', productType: 'printer_ribbon', expectedCode: 'LOT143' }), true);
  }, derivesLC3339);
});

test('mergeCodeIntoEffective never drops an existing code', () => {
  // setProductCodes REPLACES the whole set. Passing a bare [code] silently
  // erases every other chip the product appears under — the most destructive
  // mistake available in this area, and a completely silent one.
  assert.deepEqual(M.mergeCodeIntoEffective(['LC3339', 'LC3337'], 'LC3341'), ['LC3339', 'LC3337', 'LC3341']);
  assert.deepEqual(M.mergeCodeIntoEffective(['LC3339'], 'LC3339'), ['LC3339'], 'no duplicate');
  assert.deepEqual(M.mergeCodeIntoEffective([], 'LC3341'), ['LC3341']);
  assert.deepEqual(M.mergeCodeIntoEffective(null, 'LC3341'), ['LC3341'], 'null input is not a throw');
  assert.deepEqual(M.mergeCodeIntoEffective(['lc-3339'], 'lc3341'), ['LC3339', 'LC3341'], 'normalised on the way in');
  assert.deepEqual(M.mergeCodeIntoEffective(['LC3339'], 'X'), ['LC3339'], 'a 1-char code is not storable and is dropped');
});

// ── 4. Reachability facets ───────────────────────────────────────────────────

test('reachabilityFacets names each way a product goes invisible', () => {
  withExtractor(() => {
    const good = {
      sku: 'CLC3339BK', name: 'x', product_type: 'ink_cartridge',
      brand_id: 'b1', brand: { slug: 'brother' }, is_active: true, series_codes: ['LC3339'],
    };
    assert.equal(M.reachabilityFacets(good).reachable, true);

    const facetsOf = (p) => M.reachabilityFacets(p).failures.map(f => f.facet);

    assert.deepEqual(facetsOf({ ...good, is_active: false }), ['is_active']);
    assert.deepEqual(facetsOf({ ...good, brand_id: null, brand: null }), ['brand_id']);
    assert.deepEqual(facetsOf({ ...good, product_type: '' }), ['product_type']);
    assert.deepEqual(facetsOf({ ...good, product_type: 'not_a_type' }), ['product_type']);

    // The invisible one: the brand exists but /shop renders no tile for it.
    assert.deepEqual(facetsOf({ ...good, brand: { slug: 'olivetti' } }), ['brand_on_shop']);

    // A code can come from any of three places; absent all three, no chip.
    const codeless = { ...good, sku: '???', series_codes: [] };
    assert.ok(M.reachabilityFacets(codeless).failures.some(f => f.facet === 'code'));
    assert.equal(M.reachabilityFacets(codeless, { overrideCodes: ['LC3339'] }).reachable, true,
      'a product_codes override is a valid third source');
  }, (p) => { if (String(p.sku).includes('LC3339')) p.series_codes = ['LC3339']; });
});

test('reachabilityFacets reports several failures at once', () => {
  withExtractor(() => {
    const { reachable, failures } = M.reachabilityFacets(
      { sku: '', name: '', product_type: '', brand: { slug: 'olivetti' }, is_active: false });
    assert.equal(reachable, false);
    assert.ok(failures.length >= 3, 'a product can fail more than one facet, and all must be named');
  }, () => {});
});

// ── 5. The Browse tab is wired, and the blank entry point is gone ────────────

test('Products page ships a Browse tab that lazy-loads catalogue-browse.js', () => {
  assert.match(productsJs, /data-prod-tab="browse"/, 'the tab button must exist');
  assert.match(productsJs, /import\('\.\/catalogue-browse\.js'\)/,
    'Browse must be lazy-loaded the same way printers.js is');
  assert.match(productsJs, /tab === 'browse'/, 'switchProductTab must handle it');
});

test('+ Add Product opens the pathway, never a blank create modal', () => {
  // The whole point: a product never starts with three empty dropdowns.
  const m = productsJs.match(/#add-product-btn'\)\?\.addEventListener\('click',\s*\(\)\s*=>\s*([^;]+);/);
  assert.ok(m, 'the Add Product handler must still exist');
  assert.match(m[1], /switchProductTab\('browse'\)/,
    '+ Add Product must reach the Browse pathway');
  assert.doesNotMatch(m[1], /openCreateProductModal\(\s*\)/,
    'the blank-form entry point must stay removed');
});

test('the create modal accepts a pathway context and narrows the type menu', () => {
  assert.match(productsJs, /function openCreateProductModal\(context = null\)/);
  assert.match(productsJs, /typesForCategory\(ctx\.category\)/,
    'the type menu must narrow to the category being added to');
  assert.match(productsJs, /previewCodeForSku\(/, 'the live code preview must be wired');
  assert.match(productsJs, /landProductUnderCode\(/, 'the post-create code write must be called');
});

test('the locked brand submits its value — it is not a disabled select', () => {
  // A disabled <select> submits nothing, so brand_id would arrive null and the
  // product would land nowhere, silently, while the field looked filled in.
  assert.match(productsJs, /<input type="hidden" id="edit-brand"/,
    'the locked brand must be a hidden input that still submits');
  assert.doesNotMatch(productsJs, /id="edit-brand"[^>]*\sdisabled/,
    'the brand field must never be disabled');
  assert.match(productsJs, /id="edit-brand-change"/, 'the lock must be escapable');
});

test('catalogue-browse.js never imports back into products.js', () => {
  // A cycle between the two would resolve one side to a half-initialised
  // namespace and fail only for whichever loaded second. The create/open
  // functions arrive as hooks instead.
  assert.doesNotMatch(browseJs, /from '\.\/products\.js'/,
    'the pathway must not import the module that lazy-loads it');
  assert.match(browseJs, /onAddProduct/, 'it takes the create hook by injection');
  assert.match(productsJs, /onAddProduct:\s*\(context\)/, 'products.js supplies it');
});

test('the pathway resets its state on BOTH init and destroy', () => {
  // Module-level state cleared only on the way out means last visit's brand
  // silently carries into the next one, and a slice reads as the whole
  // catalogue — the bug the Product Codes page had to fix.
  const init = browseJs.match(/async init\(container, hooks = \{\}\)\s*\{[\s\S]*?\n  \}/);
  const destroy = browseJs.match(/destroy\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(init && destroy, 'both lifecycle methods must exist');
  assert.match(init[0], /resetState\(\)/, 'init must reset');
  assert.match(destroy[0], /resetState\(\)/, 'destroy must reset');
});

test('the pathway reads the storefront, and does not invent a chip list', () => {
  assert.match(browseJs, /window\.API\.getShopData\(/,
    'levels must read the same function /shop calls');
  assert.doesNotMatch(browseJs, /_CATEGORY_PRODUCT_TYPES\s*=/,
    'it must not declare its own category membership');
});

test('ribbon brands take the /ribbons route, not the /shop drilldown', () => {
  // A ribbon brand is the PRINTER brand, linked through product_ribbon_brands —
  // not products.brand_id. Measured live: /api/shop?brand=adler returns
  // ok:false. Sending ribbons down the drilldown would report every one of
  // them as empty.
  assert.match(browseJs, /getRibbons\(\{\s*printer_brand/,
    'ribbon brands must be read through /api/ribbons');
  assert.match(browseJs, /ribbon-products/, 'ribbons get their own level');
});

test('"+ New code" exists, and does not pretend to store anything', () => {
  // A code is not a record: `series_codes` is derived at query time and
  // `product_codes` only overrides it for a product that already exists. So
  // naming a code must leave nothing behind, and the modal has to SAY that
  // rather than implying a save — otherwise the operator names one, walks away,
  // and has built a chip that renders on no page.
  assert.ok(browseJs.includes('cb-new-code'), 'the codes level must offer a new-code button');
  assert.ok(browseJs.includes('function promptNewCode'), 'and a handler');
  // Match a run with no \uXXXX escapes in it — the source spells the
  // apostrophe as \u2019, so a regex over the raw file cannot use ".".
  assert.ok(browseJs.includes('stored on its own'),
    'the modal must state that naming a code saves nothing by itself');
  assert.ok(browseJs.includes('saves nothing by itself'),
    'and say it in the words the operator reads');
  assert.ok(browseJs.includes('isValidProductCode'),
    'the code must be validated against the table CHECK before it is used');
  assert.ok(browseJs.includes('AdminAPI.normalizeProductCode'),
    'and normalised through the ONE normaliser — a local copy is ERR-061');
});

test('the new-code modal offers BOTH routes, and does not rebuild membership editing', () => {
  // Two genuinely different jobs: give a new code its first product (this
  // page), or tag products that already exist (the Product Codes page's
  // membership drawer). Rebuilding the second here would be a second surface
  // writing the same override table — how two normalisers drifted apart before.
  assert.ok(browseJs.includes('Add its first product'));
  assert.ok(browseJs.includes('Tag existing products'));
  assert.ok(browseJs.includes("'#product-codes'"),
    'the tagging route must hand off to the page that owns membership');
  assert.ok(!browseJs.includes('setCodeMembership'),
    'the pathway must not write membership itself');
});

test('the new-code modal does NOT ask for brand or category', () => {
  // The Product Codes page has to ask — it lists every code in the catalogue
  // and a chip has to be born somewhere. Here the operator is already standing
  // in one brand+category, which is the entire point of having walked to it.
  const fn = browseJs.slice(browseJs.indexOf('function promptNewCode'),
                            browseJs.indexOf('function runReachabilityCheck'));
  assert.ok(!/SHOP_CATEGORIES\.map|_brands\.map/.test(fn),
    'brand/category pickers must not reappear inside the pathway');
  assert.ok(fn.includes('_brand.name') && fn.includes('categoryLabel(_category)'),
    'the scope is stated, not asked for');
});

test('a code already on this page is refused, and says where to find it', () => {
  // "Already exists" is a different answer from "invalid", and sending the
  // operator to the tile they are looking at beats a second way in.
  assert.ok(/already exists in \$\{scopeLabel\}/.test(browseJs));
  assert.ok(/click its tile/.test(browseJs));
});

test('counts are labelled as the customer view, not the catalogue', () => {
  // An unlabelled count that quietly excludes inactive rows is the
  // absence-read-as-zero mistake with a friendly face.
  assert.match(browseJs, /function liveCountNote/);
  assert.match(browseJs, /inactive products are not included/i);
});

test('the shop counts payload is read with both key spellings', () => {
  // Measured 2026-08-30: /api/shop returns `label` and `ribbon`; shop-page.js
  // also tolerates `label_tape`. Reading one spelling and getting undefined
  // renders a populated category as "no products yet".
  assert.match(browseJs, /counts\.label_tape \|\| counts\.label/);
  assert.match(browseJs, /counts\.ribbons \|\| counts\.ribbon/);
});

test('"could not look" is its own state on the reachability check', () => {
  // A skip is not a pass. A failed check must never render as a clean one.
  assert.match(browseJs, /Could not check/);
  assert.match(browseJs, /not a clean result/i);
});

test('admin.css carries the pathway styles the page emits', () => {
  for (const cls of [
    '.admin-cb-crumbs', '.admin-cb-tile', '.admin-cb-grid', '.admin-cb-product',
    '.admin-cb-reach', '.admin-cb-context', '.admin-locked', '.admin-code-preview',
  ]) {
    assert.ok(cssSrc.includes(cls), `admin.css is missing ${cls}`);
  }
});

// ── 6. The probe stays a probe ───────────────────────────────────────────────

test('probe:catalogue-pathway is registered', () => {
  assert.equal(pkg.scripts['probe:catalogue-pathway'], 'node scripts/probe-catalogue-pathway.mjs');
});

test('the probe has no write path at all', () => {
  // A probe that can record is a probe that can pass because it just overwrote
  // what it was comparing against — how sweep:b2b ate a committed fixture on
  // 2026-08-12.
  // Scope the flag check to the code, not the banner — the banner says the
  // words "--record" precisely to explain that no such flag exists.
  const code = probeSrc.slice(probeSrc.indexOf("import fs from 'node:fs'"));
  assert.ok(!/'--record'|'--update-baseline'/.test(code), 'no record flag may be parsed');
  assert.ok(!/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i.test(code), 'no write verb');
  assert.ok(!/writeFileSync|appendFileSync/.test(code), 'the probe must not write files');
  assert.ok(/MODE: .*READ-ONLY/.test(probeSrc), 'the mode must be printed on every run');
});

test('the probe exits 2 for "could not look", never 1', () => {
  // "We could not look" and "we looked and it was fine" are different
  // sentences, and collapsing them is the mistake the probe exists to catch.
  assert.ok(/function cannotRun[\s\S]*?process\.exit\(2\)/.test(probeSrc),
    'cannotRun() must exit 2');
  assert.ok(/if \(findings\.length\) process\.exit\(1\)/.test(probeSrc),
    'real findings exit 1');
  assert.ok(/process\.exit\(0\)/.test(probeSrc),
    'a fully-measured clean run exits 0');
});

test('the probe MEASURES reachability, it does not infer it from codes', () => {
  // A chip-LABEL match is not the question. GLC38CMY carries LC38, brother · ink
  // HAS an LC38 chip, and clicking it returns six products — not that one. Only
  // a diff against the SKUs /shop really serves sees that; the label test called
  // it reachable and it is not.
  assert.ok(probeSrc.includes('loadServedSkus'), 'the probe must diff the served set');
  assert.ok(probeSrc.includes('not_served'), 'and report what is not served');
  assert.ok(/has_next === false/.test(probeSrc),
    'the served walk must run to exhaustion — a partial walk invents unreachable products');
});

test('a 429 is a request to wait, not a finding and not a failed run', () => {
  assert.ok(probeSrc.includes('RATE_LIMIT_BACKOFF_MS'), 'rate limits must back off and retry');
  assert.ok(/res\.status === 429/.test(probeSrc));
});

test('the probe loads the SHIPPED extractor rather than carrying its own', () => {
  // Reading only the API's series_codes reported 96 reachable compatibles as
  // codeless: the backend extractor reads manufacturer_part_number, which
  // compatibles do not have, so the browser derives their codes instead.
  assert.ok(probeSrc.includes('vm.runInContext'), 'it must evaluate the shipped modules');
  assert.ok(probeSrc.includes('_enrichSeriesCodes'), 'it must use the real extractor');
  assert.ok(!/const\s+COLOR_SUFFIX\s*=/.test(probeSrc), 'it must not re-implement the extractor');
});

test('a flaky request is UNMEASURED, never a finding', () => {
  // One transient failure on a sequential walk once turned into "662 products
  // unreachable" — the could-not-look mistake with the sign flipped. A scope is
  // retried; if it still fails its products are counted as unmeasured, and a
  // run that found nothing but could not read everything exits 2, not 0.
  assert.ok(/attempt === 0.*continue/s.test(probeSrc), 'a failed scope must be retried');
  assert.ok(probeSrc.includes('unmeasuredScopes'), 'unreadable scopes are tracked separately');
  assert.ok(probeSrc.includes('These are unmeasured, not broken'), 'and reported as such');
  assert.ok(/if \(unmeasured\) \{[\s\S]*?process\.exit\(2\)/.test(probeSrc),
    'a partial sweep with no findings must exit 2, not 0');
  assert.ok(/if \(findings\.length\) process\.exit\(1\)/.test(probeSrc),
    'real findings must still win, so a flake can never hide them');
});

test('"no such page" is distinguished from "could not read"', () => {
  // The endpoint answering ok:false is a real result about a real gap; a
  // network failure is not. Collapsing them makes one of the two a lie.
  assert.ok(probeSrc.includes("'no-such-scope'"), 'a real "no such page" answer is its own state');
  assert.ok(probeSrc.includes('no_shop_page'), 'and it is reported as a finding, not a flake');
});

test('the probe exempts paper and ribbons for stated reasons', () => {
  // /shop has no code level for paper, and ribbons route via /ribbons. Both
  // exemptions are REPORTED, not silent — a count that quietly excludes a
  // population is the same mistake as one that quietly includes one.
  assert.ok(probeSrc.includes("category === 'paper'"), 'paper skips the code check');
  assert.ok(probeSrc.includes('paperSkipped'), 'and the exemption is counted');
  assert.ok(probeSrc.includes('ribbonWithCodes'), 'ribbons are counted separately too');
});

test('the utils module states why the pathway is not a create hierarchy', () => {
  // This is the fact the whole feature is shaped around. If it is ever deleted,
  // the next person rebuilds the empty-chip bug.
  assert.match(pathwayJs, /not records/i);
  assert.match(pathwayJs, /cannot exist/i);
});
