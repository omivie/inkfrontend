/**
 * Catalogue Engagement — ERR-204, job 2
 * =====================================
 *
 * The backend shipped GET /api/admin/analytics/catalog/{products,brands} and a
 * hand-off describing them. Three of its rendering rules turned out to need
 * more care than they were given, all measured against production 2026-09-03
 * before any UI was written:
 *
 *  (a) "`view_to_sale_rate: null` is not zero." True, and much bigger than it
 *      sounds: 51 of 257 rows (20%) are null — every one a product with
 *      views = 0 and clicks > 0. A further 155 rows carry a REAL 0. So both
 *      branches are live, in volume, and must render differently.
 *
 *  (b) "`meta.offshore_bounce_views_excluded` reports the count either way."
 *      It does not. Measured:
 *          /catalog/products                            → 8   (257 rows)
 *          /catalog/products?include_offshore_bounces=1 → 0   (265 rows)
 *          /catalog/brands                              → KEY ABSENT
 *      Three different answers. A UI that prints "0 excluded" for the last two
 *      invents a measurement it was never given.
 *
 *  (c) `?offset=` is a DECOY — accepted and ignored, alongside product_type,
 *      sort and search. There is therefore NO pagination, and a Next button
 *      would silently re-serve page one. `total_products_engaged` is the
 *      pre-limit count and the only honest source for "50 of 257".
 *
 * Every assertion below runs the REAL shipped module (a dynamic import of
 * utils/catalog-engagement.js), not a copy, so an import-graph break fails here
 * too. Positive and negative controls are labelled.
 *
 *   1. view → sale: four states, four answers
 *   2. the offshore filter's three states
 *   3. counting rows without inventing a total
 *   4. dead brand links surface
 *   5. engagement stays a sort key
 *   6. coverage prose is passed through, never paraphrased
 *   7. the page + api + app wiring
 *   8. POSITIVE / NEGATIVE controls
 *
 * Run with: node --test tests/catalog-engagement-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = path.join(ROOT, 'inkcartridges', 'js', 'admin');
const R = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
/**
 * Source with comments removed. Several assertions below scan for the NAME of a
 * decoy param or a dead code form — and this feature's own comments quote those
 * names to explain why they are absent. Scanning the whole file would flag the
 * documentation as the defect it documents.
 */
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const mod = import(pathToFileURL(path.join(ADMIN, 'utils', 'catalog-engagement.js')).href);

const PAGE = R('inkcartridges', 'js', 'admin', 'pages', 'catalog-engagement.js');
const API = R('inkcartridges', 'js', 'admin', 'api.js');
const APP = R('inkcartridges', 'js', 'admin', 'app.js');
const CSS = R('inkcartridges', 'css', 'admin.css');

/** A real row from production, verbatim. */
const LIVE_ROW = {
  sku: 'CTN2445BK', name: 'TN2445BK Compatible Toner Cartridge for Brother TN2445 Black',
  brand: 'Brother', views: 6, clicks: 4, source: 'compatible', revenue: 204.3,
  brand_slug: 'brother', engagement: 10, product_id: '0a74423e-1a83-4a87-ba05-941a69dfc3fb',
  units_sold: 5, product_type: 'toner_cartridge', retail_price: 46.99,
  unique_viewers: 5, unique_clickers: 3, view_to_sale_rate: 0.8333,
};
/** One of the 51 null-rate rows, verbatim. */
const LIVE_NULL_ROW = {
  sku: 'CLC233BK', name: 'LC233BK Compatible Ink Cartridge for Brother LC233 Black',
  brand: 'Brother', views: 0, clicks: 3, source: 'compatible', revenue: 0,
  engagement: 3, units_sold: 0, unique_viewers: 0, unique_clickers: 1,
  view_to_sale_rate: null,
};

// ── 1. view → sale: four states ─────────────────────────────────────────────

test('§1 view_to_sale_rate resolves to four distinct answers', async (t) => {
  const { readViewToSaleRate, formatRate, MISSING } = await mod;

  await t.test('a measured rate is known', () => {
    const i = readViewToSaleRate(LIVE_ROW);
    assert.equal(i.known, true);
    assert.equal(i.rate, 0.8333);
  });

  await t.test('a REAL zero stays a zero — 155 live rows depend on this', () => {
    const i = readViewToSaleRate({ views: 6, units_sold: 0, view_to_sale_rate: 0 });
    assert.equal(i.known, true, 'viewed-but-never-bought is a measurement, not an absence');
    assert.equal(i.rate, 0);
    assert.equal(formatRate(i), '0.0%', 'and it must PRINT as zero, not as an em-dash');
  });

  await t.test('null is unknown, not zero — 51 live rows (20%)', () => {
    const i = readViewToSaleRate(LIVE_NULL_ROW);
    assert.equal(i.known, false);
    assert.equal(i.rate, null);
    assert.equal(i.reason, 'no-views');
    assert.equal(formatRate(i), MISSING);
  });

  await t.test('an ABSENT key is its own reason, not folded into null', () => {
    // `undefined !== null` and `undefined == null` are both true, so either
    // obvious gate is wrong in one direction (ERR-199). hasOwnProperty is the
    // only reader that separates them.
    const i = readViewToSaleRate({ sku: 'X', views: 3 });
    assert.equal(i.known, false);
    assert.equal(i.reason, 'absent', 'a dropped field is a contract regression, not "no views"');
  });

  await t.test('the two unknown reasons produce DIFFERENT copy', () => {
    // If they read the same, the operator cannot tell "nothing was viewed" from
    // "the backend stopped sending the field", and one of those needs a fix.
    const a = readViewToSaleRate(LIVE_NULL_ROW);
    const b = readViewToSaleRate({ sku: 'X' });
    assert.notEqual(a.reason, b.reason);
  });
});

test('§1b the tooltips say which kind of unknown it is', async () => {
  const { readViewToSaleRate, viewToSaleTooltip } = await mod;
  const noViews = viewToSaleTooltip(readViewToSaleRate(LIVE_NULL_ROW));
  const absent = viewToSaleTooltip(readViewToSaleRate({ sku: 'X' }));
  assert.match(noViews, /no views/i);
  assert.match(absent, /did not send/i);
  assert.notEqual(noViews, absent);
  for (const t of [noViews, absent]) {
    assert.match(t, /not a 0% conversion|no rate to compute/i,
      'the tooltip must say explicitly that this is not a zero');
  }
});

test('§1c formatRate never turns a sub-1% rate into "0%"', async () => {
  const { readViewToSaleRate, formatRate } = await mod;
  const tiny = formatRate(readViewToSaleRate({ view_to_sale_rate: 0.004 }));
  assert.equal(tiny, '0.40%');
  assert.notEqual(tiny, '0%', 'rounding a real rate to zero is the same lie as rendering null as zero');
  assert.equal(formatRate(readViewToSaleRate({ view_to_sale_rate: 0.0769 })), '7.7%');
  assert.equal(formatRate(readViewToSaleRate({ view_to_sale_rate: 0.8333 })), '83%');
});

test('§1d over-100% is REAL and is flagged, never capped', async () => {
  const { readViewToSaleRate, formatRate, overUnityTooltip } = await mod;
  // Measured 2026-09-03: view_to_sale_rate === units_sold / views on all 208
  // rows that have views. It is a UNITS-PER-VIEW ratio, not a conversion rate,
  // so 7 of 259 rows legitimately exceed 1 — up to 3.0 (C564BK: 1 view, 3 sold).
  const i = readViewToSaleRate({ views: 1, units_sold: 3, view_to_sale_rate: 3 });
  assert.equal(i.known, true);
  assert.equal(i.rate, 3, 'the value must never be capped — capping invents a measurement');
  assert.equal(i.overUnity, true);
  assert.equal(formatRate(i), '300%');
  assert.match(overUnityTooltip(i), /units sold/i, 'and the cell must explain why 300% is not a bug');
  assert.match(overUnityTooltip(i), /not a per-visitor conversion rate/i);

  // NEGATIVE CONTROL — an ordinary rate is not flagged.
  const ok = readViewToSaleRate({ view_to_sale_rate: 0.5 });
  assert.equal(ok.overUnity, false);
  assert.equal(overUnityTooltip(ok), '');
  assert.equal(overUnityTooltip(readViewToSaleRate({ view_to_sale_rate: 1 })), '',
    'exactly 100% is the boundary and is not flagged');
});

test('§1e the page marks the over-unity cell and defines the metric', async () => {
  const { RATE_DEFINITION } = await mod;
  assert.match(PAGE, /ce-rate--over/);
  assert.match(PAGE, /overUnityTooltip/);
  assert.match(PAGE, /RATE_DEFINITION/, 'the notes block must say what the column measures');
  assert.match(RATE_DEFINITION, /units sold . product-page views/i);
  assert.match(RATE_DEFINITION, /can exceed 100%/i);
  assert.match(CSS, /\.ce-rate--over/);
  // The definition belongs only on the panel that has the column.
  assert.match(PAGE, /_panel === 'products'\s*\n?\s*\? `<div class="ce-note">\$\{esc\(RATE_DEFINITION\)\}/);
});

// ── 2. the offshore filter's three states ───────────────────────────────────

test('§2 the scraper filter has three states, not a number', async (t) => {
  const { readOffshoreExcluded, offshoreDisclosure, OFFSHORE_STATE } = await mod;

  await t.test('filtered + reported = measured', () => {
    const i = readOffshoreExcluded({ offshore_bounce_views_excluded: 8 }, { includeBounces: false });
    assert.equal(i.state, OFFSHORE_STATE.MEASURED);
    assert.equal(i.count, 8);
    assert.match(offshoreDisclosure(i), /8 offshore single-page views removed/);
    assert.match(offshoreDisclosure(i), /New Zealand traffic/, 'the NZ guarantee is the reassuring half');
  });

  await t.test('THE TRAP: unfiltered reports 0, which is not a count', () => {
    // Measured: include_offshore_bounces=true returns 0 here while the row count
    // RISES 257 → 265. The 8 were included, not absent.
    const i = readOffshoreExcluded({ offshore_bounce_views_excluded: 0 }, { includeBounces: true });
    assert.equal(i.state, OFFSHORE_STATE.SUPPRESSED);
    const copy = offshoreDisclosure(i);
    assert.match(copy, /filter OFF/i);
    assert.doesNotMatch(copy, /\b0 offshore/, 'must never report "0 excluded" for an unfiltered view');
  });

  await t.test('brands omits the key entirely = unknown', () => {
    const i = readOffshoreExcluded({ ranked_by: 'engagement', total_brands_engaged: 18 }, { includeBounces: false });
    assert.equal(i.state, OFFSHORE_STATE.UNKNOWN);
    assert.equal(i.count, null);
    assert.match(offshoreDisclosure(i), /unknown, not zero/);
  });

  await t.test('a genuine filtered zero still reads as a measurement', () => {
    // POSITIVE CONTROL for the SUPPRESSED branch: with the filter ON, a 0 IS a
    // count, and must not be downgraded to "unknown".
    const i = readOffshoreExcluded({ offshore_bounce_views_excluded: 0 }, { includeBounces: false });
    assert.equal(i.state, OFFSHORE_STATE.MEASURED);
    assert.match(offshoreDisclosure(i), /no offshore single-page views were removed/);
  });

  await t.test('the three states produce three different sentences', () => {
    const s = [
      offshoreDisclosure(readOffshoreExcluded({ offshore_bounce_views_excluded: 8 }, { includeBounces: false })),
      offshoreDisclosure(readOffshoreExcluded({ offshore_bounce_views_excluded: 0 }, { includeBounces: true })),
      offshoreDisclosure(readOffshoreExcluded({}, { includeBounces: false })),
    ];
    assert.equal(new Set(s).size, 3, 'a state the operator cannot distinguish is a state they will be misled by');
  });
});

// ── 3. counting rows ────────────────────────────────────────────────────────

test('§3 the row count comes from meta, never from data.length', async (t) => {
  const { rowCountLabel } = await mod;

  await t.test('the pre-limit total drives the label', () => {
    const c = rowCountLabel(new Array(50), { total_products_engaged: 257 }, 'product');
    assert.equal(c.label, 'Showing 50 of 257 engaged products');
    assert.equal(c.truncated, true);
  });

  await t.test('brands uses its own meta key', () => {
    const c = rowCountLabel(new Array(18), { total_brands_engaged: 18 }, 'brand');
    assert.equal(c.total, 18);
    assert.equal(c.truncated, false, '18 of 18 is not truncated');
  });

  await t.test('NEGATIVE CONTROL — with no meta it refuses to claim a total', () => {
    const c = rowCountLabel(new Array(50), {}, 'product');
    assert.equal(c.total, null);
    assert.match(c.label, /total not reported/);
    assert.doesNotMatch(c.label, /of 50/, 'data.length must never stand in for the real total');
  });
});

test('§3b the page offers no pager, because offset is a decoy', () => {
  // A Next button here would re-serve page one and look like it worked.
  const code = codeOf(PAGE);
  assert.doesNotMatch(code, /onPageChange/, 'the endpoint ignores ?offset= — there is no page 2');
  assert.doesNotMatch(code, /\boffset\b/, 'offset must not be sent at all');
  assert.match(PAGE, /raise .Show. to see more/,
    'the caption must tell the operator how to actually see more rows');
  // ...and the reason must survive in the docblock, so nobody "adds the missing
  // pagination" later.
  assert.match(PAGE, /accepted by both endpoints and completely[\s\S]{0,40}ignored/,
    'the decoy finding must stay documented in the page');
});

test('§3c only VERIFIED filters are sent', () => {
  // product_type / sort / search are accepted and silently ignored (measured).
  // Sending one would put a control on screen that does nothing.
  const code = codeOf(PAGE);
  for (const decoy of ["'product_type'", "'sort'", "'search'"]) {
    assert.ok(!code.includes(decoy), `${decoy} is a decoy param and must not be sent`);
  }
  for (const real of ['source', 'brand_id', 'limit', 'include_offshore_bounces']) {
    assert.ok(PAGE.includes(real), `${real} is honoured and should be offered`);
  }
});

// ── 4. dead brand links ─────────────────────────────────────────────────────

test('§4 unmatched_brand_slugs surfaces as a warning', async (t) => {
  const { readUnmatchedBrandSlugs } = await mod;

  await t.test('reported-empty is not the same as not reported', () => {
    assert.deepEqual(readUnmatchedBrandSlugs({ unmatched_brand_slugs: [] }), { reported: true, slugs: [] });
    assert.deepEqual(readUnmatchedBrandSlugs({}), { reported: false, slugs: [] });
  });

  await t.test('slugs come through for display', () => {
    const i = readUnmatchedBrandSlugs({ unmatched_brand_slugs: ['kyocera-mita', 'lexmarkk'] });
    assert.deepEqual(i.slugs, ['kyocera-mita', 'lexmarkk']);
  });

  await t.test('the page names them rather than counting them', () => {
    assert.match(PAGE, /no brand record/i);
    assert.match(PAGE, /dead link/i, 'the operator needs to know what the consequence is');
    assert.match(PAGE, /info\.slugs\.map/, 'each slug must be printed, not just tallied');
  });
});

// ── 5. engagement is a sort key ─────────────────────────────────────────────

test('§5 engagement is decomposed, never presented alone', async (t) => {
  const { engagementParts } = await mod;

  await t.test('products = views + clicks', () => {
    const i = engagementParts(LIVE_ROW, 'product');
    assert.equal(i.total, 10);
    assert.deepEqual(i.parts.map((p) => p.value), [6, 4]);
    assert.equal(i.reconciles, true);
  });

  await t.test('brands = hub views + product views + product clicks', () => {
    // The real Brother row: 311 + 131 + 103 = 545.
    const i = engagementParts({ brand_page_views: 311, product_views: 131, product_clicks: 103, engagement: 545 }, 'brand');
    assert.equal(i.total, 545);
    assert.equal(i.reconciles, true);
  });

  await t.test('NEGATIVE CONTROL — a changed formula is flagged, not absorbed', () => {
    const i = engagementParts({ views: 6, clicks: 4, engagement: 99 }, 'product');
    assert.equal(i.reconciles, false);
  });

  await t.test('the brand table keeps hub views and product views as separate columns', () => {
    // The hand-off is explicit: Canon draws nearly as many hub visits as Epson
    // but under half the product views. One merged column erases that.
    const cols = PAGE.slice(PAGE.indexOf('function brandColumns'), PAGE.indexOf('/* ── chrome'));
    assert.match(cols, /key: 'brand_page_views'/);
    assert.match(cols, /key: 'product_views'/);
    assert.match(PAGE, /Kept SEPARATE deliberately/, 'and the reason must stay written down');
  });

  await t.test('engagement is styled as a muted sort key, not a headline', () => {
    assert.match(CSS, /\.ce-engagement\s*\{[^}]*--text-muted/,
      'engagement must not read as the primary metric');
  });
});

// ── 6. coverage prose ───────────────────────────────────────────────────────

test('§6 meta.coverage is rendered verbatim', async (t) => {
  const { readCoverage } = await mod;

  await t.test('present entries come through unchanged', () => {
    const c = readCoverage({ coverage: { views: 'Complete.', clicks: 'Partial.', bots: 'Excluded.' } });
    assert.equal(c.length, 3);
    assert.deepEqual(c.map((x) => x.text), ['Complete.', 'Partial.', 'Excluded.']);
  });

  await t.test('absent or empty entries are dropped, not rendered blank', () => {
    assert.equal(readCoverage({ coverage: { views: '   ' } }).length, 0);
    assert.equal(readCoverage({}).length, 0);
  });

  await t.test('the page escapes it — it is backend text on our page', () => {
    assert.match(PAGE, /esc\(c\.text\)/);
  });
});

// ── 7. wiring ───────────────────────────────────────────────────────────────

test('§7 api.js exposes both endpoints through the LOUD helper', () => {
  assert.match(API, /async getCatalogProductEngagement\(/);
  assert.match(API, /async getCatalogBrandEngagement\(/);
  assert.match(API, /analytics\/catalog\/products/);
  assert.match(API, /analytics\/catalog\/brands/);
  const block = API.slice(API.indexOf('async getCatalogProductEngagement('), API.indexOf('async getAcquisitionSummary('));
  assert.match(block, /analyticsHttpGetShared/,
    'must NOT use analyticsHttpGet — it collapses a 429 into null, which renders as an empty catalogue');
  assert.doesNotMatch(block, /analyticsQuery/,
    'these endpoints key on from/to, not the date_from/date_to analyticsQuery emits');
});

test('§7b the rate limit is reported, with the seconds from the HEADER', () => {
  assert.match(API, /rateLimited: true/);
  assert.match(API, /retry-after/, 'the 429 body carries no retry_after — the header does');
  assert.match(API, /ratelimit-policy: 20;w=60|20 requests|20;w=60/,
    'the measured budget must be written down where the next reader will find it');
  assert.match(PAGE, /Analytics is rate-limited/);
  assert.match(PAGE, /not<\/strong> an empty catalogue|not.{0,30}empty catalogue/,
    'the rate-limited state must say it is not a measurement of zero');
});

test('§7c app.js registers the page, owner-only, under Catalog', () => {
  assert.match(APP, /key: 'catalog-engagement'/);
  const catalogIdx = APP.indexOf("section: 'Catalog'");
  const dataOpsIdx = APP.indexOf("section: 'Data Operations'");
  const ceIdx = APP.indexOf("key: 'catalog-engagement'");
  assert.ok(catalogIdx !== -1 && ceIdx > catalogIdx && ceIdx < dataOpsIdx,
    'must sit in the Catalog section');
  assert.match(APP.slice(ceIdx, ceIdx + 140), /ownerOnly: true/);
});

test('§7d the page follows the house lifecycle contract', () => {
  assert.match(PAGE, /export default/);
  assert.match(PAGE, /async init\s*\(/);
  assert.match(PAGE, /destroy\s*\(\)/);
  assert.match(PAGE, /_renderSeq/, 'race guard');
  assert.match(PAGE, /mySeq !== _renderSeq/);
  assert.match(PAGE, /_renderSeq\+\+/, 'destroy must invalidate an in-flight render');
  assert.match(PAGE, /FilterState\.showBar\(false\)/);
  assert.match(PAGE, /FilterState\.showBar\(true\)/);
  assert.match(PAGE, /admin-page--reloading/);
  assert.match(PAGE, /removeEventListener/, 'delegated listeners must be torn down');
  assert.match(PAGE, /_dt\?\.destroy\?\.\(\)/, 'the DataTable must be destroyed, not orphaned');
});

test('§7e imports are house-legal', () => {
  assert.match(PAGE, /import \{ AdminAPI, FilterState, esc \} from '\.\.\/app\.js'/,
    'app.js exports are imported, never typeof-guarded');
  assert.doesNotMatch(PAGE, /^import[^\n]*\?v=/m, 'no ?v= on a static import (ERR-124)');
  assert.doesNotMatch(PAGE, /typeof AdminAPI|typeof FilterState/);
});

test('§7f the CSS exists, in theme tokens', () => {
  for (const cls of [
    '.ce-subtitle', '.ce-controls', '.ce-filter', '.ce-toggle', '.ce-caption',
    '.ce-product', '.ce-src--genuine', '.ce-src--compatible', '.ce-engagement',
    '.ce-notes', '.ce-note--warn', '.ce-coverage', '.ce-warning', '.ce-missing',
  ]) {
    assert.ok(CSS.includes(cls), `admin.css is missing ${cls}`);
  }
  const block = CSS.slice(CSS.indexOf('CATALOGUE ENGAGEMENT (ce-*)'));
  assert.doesNotMatch(block, /:\s*#[0-9a-fA-F]{3,6}\s*[;}]/,
    'no hardcoded hex — both themes redefine the custom properties');
});

test('§7g the missing-value marker is visibly deliberate', () => {
  // A bare em-dash is indistinguishable from a rendering bug, and this page puts
  // one in up to a fifth of its View→sale cells on purpose.
  assert.match(CSS, /\.ce-missing[\s\S]{0,120}border-bottom: 1px dotted/);
  assert.match(CSS, /\.ce-missing[\s\S]{0,160}cursor: help/);
});

// ── 8. controls ─────────────────────────────────────────────────────────────

test('§8 POSITIVE CONTROL — the readers are not constant functions', async () => {
  const { readViewToSaleRate, readOffshoreExcluded, rowCountLabel } = await mod;
  // Each of the above suites would still pass if a reader always returned its
  // "safe" answer. These prove the readers actually discriminate.
  assert.notDeepEqual(
    readViewToSaleRate({ view_to_sale_rate: 0.5 }),
    readViewToSaleRate({ view_to_sale_rate: null }),
  );
  assert.notEqual(
    readOffshoreExcluded({ offshore_bounce_views_excluded: 8 }, { includeBounces: false }).state,
    readOffshoreExcluded({ offshore_bounce_views_excluded: 8 }, { includeBounces: true }).state,
  );
  assert.notEqual(
    rowCountLabel([1, 2], { total_products_engaged: 9 }, 'product').label,
    rowCountLabel([1, 2], { total_products_engaged: 2 }, 'product').label,
  );
});

test('§8b NEGATIVE CONTROL — garbage in does not become a confident answer', async () => {
  const { readViewToSaleRate, readOffshoreExcluded, engagementParts, readCoverage } = await mod;
  assert.equal(readViewToSaleRate(null).known, false);
  assert.equal(readViewToSaleRate({ view_to_sale_rate: 'lots' }).reason, 'unreadable');
  assert.equal(readViewToSaleRate({ view_to_sale_rate: NaN }).known, false, 'NaN is not a rate');
  assert.equal(readOffshoreExcluded(null, {}).state, 'unknown');
  assert.equal(readOffshoreExcluded({ offshore_bounce_views_excluded: 'eight' }, {}).state, 'unknown');
  assert.deepEqual(engagementParts(null, 'product').parts, []);
  assert.deepEqual(readCoverage({ coverage: 'nope' }), []);
});
