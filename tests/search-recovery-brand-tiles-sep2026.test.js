/**
 * Zero-results recovery: the brand rail (Sep 2026, ERR-211)
 * =========================================================
 *
 * When a search returns nothing, `/shop?search=…` renders recovery rails. Rail 3
 * was a hardcoded six-item `popular` array — Brother Ink, HP Toner, Canon Ink,
 * Epson Ink, Samsung Toner, OKI Toner — six brands out of twenty-seven, frozen at
 * whatever was typed there in May 2026.
 *
 * That is the SAME defect ERR-192 removed from /shop's own brand grid three
 * thousand lines up the same file, and it survived that fix because nothing
 * connects the two surfaces: `show_on_shop` moved one and not the other, and no
 * instrument anywhere could say the zero-results page disagreed with the shop.
 *
 * Rail 3 now calls `_shopBrandTiles()` — the single membership rule that /shop's
 * `renderBrands()` also calls. What this file pins:
 *
 *   1. The rail asks _shopBrandTiles(); it never filters brand rows itself. A
 *      second copy of the rule is how the first hardcoded list came back.
 *   2. The tiles are ANCHORS to /shop?brand=<slug>. renderBrands() emits a
 *      <button> that calls navigateTo(), which only works inside the drilldown
 *      state machine; this page is publicly indexed and must survive a
 *      middle-click.
 *   3. The six category tiles STILL EXIST, reachable only from the else branch.
 *      Removing a fallback is a behaviour change, not cleanup (ERR-158) — it
 *      stopped being the default, that is all.
 *   4. That else branch is LOUD. A frozen brand list that renders a plausible
 *      page is exactly how the allowlist filtered the database for months.
 *   5. No per-brand counts. _loadBrandCounts() would fire up to twenty-seven
 *      /api/products/counts requests off an error page.
 *
 * Every assertion that checks for an ABSENCE carries a positive control, because
 * a matcher that can never fire proves nothing (ERR-186).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'inkcartridges');

const read = (p) => fs.readFileSync(p, 'utf8');
const shopPageJs = read(path.join(SITE, 'js', 'shop-page.js'));
const searchCss = read(path.join(SITE, 'css', 'search.css'));

/**
 * Strip // and block comments.
 *
 * Every absence assertion below runs against STRIPPED source. The first draft of
 * this file did not, and two assertions failed against the very comments that
 * explain why the thing is absent ("Deliberately NO per-brand count:
 * _loadBrandCounts() would fire…"). A test that a prose edit can break is not
 * measuring the code.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

/** The body of renderZeroResultsRecovery(), which is where rail 3 lives. */
function recoveryBody() {
  const start = shopPageJs.indexOf('async renderZeroResultsRecovery(query, navVersion, smartData) {');
  assert.notEqual(start, -1, 'renderZeroResultsRecovery must still exist');
  const end = shopPageJs.indexOf('getColorStyle(colorName) {', start);
  assert.notEqual(end, -1, 'the function-end anchor must still exist');
  return shopPageJs.slice(start, end);
}

// ── 1. One membership rule, asked from both surfaces ─────────────────────────

test('the recovery rail reads the SAME brand rule /shop reads', () => {
  const body = recoveryBody();

  assert.match(body, /this\._shopBrandTiles\(\)/,
    'rail 3 must ask _shopBrandTiles() — the one place that answers "which brands do we show?"');
  // Pin the RULE, not the word. The `else` branch's DebugLog message names
  // `show_on_shop` on purpose — that is the diagnostic telling the owner which of
  // the two failures they are looking at, and it is not a second copy of anything.
  // What must never appear here is a comparison or a filter on the field.
  const RULE = /show_on_shop\s*===|\.filter\([^)]*show_on_shop/;
  assert.doesNotMatch(stripComments(body), RULE,
    'the recovery rail must hold NO copy of the membership rule');

  // Positive controls — both halves of the matcher can fire.
  assert.match('if (b.show_on_shop === true) {}', RULE, 'positive control — comparison');
  assert.match('rows.filter(b => b.show_on_shop)', RULE, 'positive control — filter');
});

test('_shopBrandTiles is TRI-STATE — offline is null, never an empty grid', () => {
  const start = shopPageJs.indexOf('_shopBrandTiles(rows = this.cache.brands) {');
  assert.notEqual(start, -1, '_shopBrandTiles must exist');
  const body = shopPageJs.slice(start, shopPageJs.indexOf('renderBrands(brands) {', start));

  assert.match(body, /if \(this\._brandsAreOffline\) return null;/,
    'the offline fallback rows carry no show_on_shop — they cannot answer the question, '
    + 'and filtering them on a field they lack renders an EMPTY grid');
  assert.match(body, /show_on_shop === true/,
    'an ABSENT field must not read as visible');
});

test('both surfaces are fed by one fetch, not two', () => {
  assert.match(shopPageJs, /async _ensureBrandsLoaded\(navVersion\) \{/,
    '_ensureBrandsLoaded must exist — loadBrands() drives /shop chrome that a search view has none of');
  assert.match(recoveryBody(), /this\._ensureBrandsLoaded\(navVersion\)/,
    'the recovery rail must load brands through the shared loader');
  assert.doesNotMatch(stripComments(recoveryBody()), /API\.getBrands\(\)/,
    'the rail must not call the API directly — that is a second copy of the fallback rules');

  // Positive control.
  assert.match('const response = await API.getBrands();', /API\.getBrands\(\)/, 'positive control');
});

test('the brand fetch runs ALONGSIDE the rail fetches, not after them', () => {
  const body = recoveryBody();
  const start = body.indexOf('const [results] = await Promise.all([');
  assert.notEqual(start, -1,
    'brands must be awaited in the same Promise.all as the rail promises — a cold '
    + 'brand fetch must not add a serial round trip to a page the customer already failed on');
  const block = body.slice(start, start + 300);
  assert.match(block, /Promise\.all\(railPromises\)/, 'the rail promises stay in that batch');
  assert.match(block, /this\._ensureBrandsLoaded\(navVersion\)/, 'brands join that batch');
});

// ── 2. Anchors, because this page is indexed ─────────────────────────────────

test('brand tiles are anchors to /shop?brand=<slug>, not drilldown buttons', () => {
  const body = recoveryBody();

  assert.match(body, /<a class="recovery-tile recovery-tile--brand" href="\/shop\?brand=\$\{encodeURIComponent\(slug\)\}"/,
    'the canonical brand URL shape, as an <a> — renderBrands() emits a <button> whose '
    + 'click handler only works inside the drilldown state machine');
  assert.doesNotMatch(stripComments(body), /navigateTo\(/,
    'the recovery rail must not depend on the drilldown state machine');

  // Positive control.
  assert.match("this.navigateTo('categories', { brand: brandId })", /navigateTo\(/, 'positive control');
});

test('a brand name is never rendered unescaped, and a logo URL is sanitized', () => {
  const body = recoveryBody();

  assert.match(body, /Security\.escapeHtml\(displayName\)/,
    'the text tile must escape the brand name');
  assert.match(body, /Security\.sanitizeUrl\(this\.brandLogo\(slug\), ''\)/,
    "logo_url is admin-writable; sanitize with an EMPTY fallback, not sanitizeUrl's "
    + "default '#', so a rejected URL renders the NAME rather than <img src=\"#\">");
  assert.match(body, /this\.brandName\(slug\)/,
    'the display name must resolve row → map → titleised slug, never a bare slug');
});

test('renderBrands got the same logo hardening', () => {
  // Same admin-writable field, same page, one line apart in behaviour. Fixing it
  // on the new surface only would have left the older one as the exposed half.
  assert.match(shopPageJs, /Security\.sanitizeUrl\(this\.brandLogo\(brandId\), ''\)/,
    '/shop’s own brand grid must sanitize its logo URL too');
});

// ── 3. The fallback survives, and it is loud ─────────────────────────────────

test('the six category tiles are KEPT — as the fallback, not the default', () => {
  const body = recoveryBody();

  for (const label of ['Brother Ink', 'HP Toner', 'Canon Ink', 'Epson Ink', 'Samsung Toner', 'OKI Toner']) {
    assert.ok(body.includes(label),
      `"${label}" must survive — removing a fallback is a behaviour change, not cleanup (ERR-158)`);
  }

  // Reachable ONLY from the else branch: the brand rail is what renders normally.
  const elseAt = body.indexOf('} else {');
  const popularAt = body.indexOf('const popular = [');
  assert.notEqual(elseAt, -1, 'the fallback must live behind an else');
  assert.ok(popularAt > elseAt,
    'the six tiles must render only when the brand grid could not be read');

  const brandRailAt = body.indexOf('Browse by brand');
  assert.ok(brandRailAt !== -1 && brandRailAt < popularAt,
    'the brand rail is the primary; the category tiles come after it');
});

test('a degraded brand list is never silent', () => {
  const body = recoveryBody();
  const elseAt = body.indexOf('} else {');
  const fallback = body.slice(elseAt, body.indexOf('const popular = [', elseAt));

  assert.match(fallback, /DebugLog\.error/,
    'a rail frozen at the last deploy must say so — a silent fallback that renders a '
    + 'plausible page is how the allowlist filtered the database for months (ERR-158)');
  assert.match(fallback, /_brandsAreOffline/,
    'the message must distinguish "/api/brands unreadable" from "no row has show_on_shop" — '
    + 'the second means /shop’s own grid is empty too');
});

// ── 4. No count storm off an error page ──────────────────────────────────────

test('the recovery rail issues no per-brand count requests', () => {
  const body = recoveryBody();

  const code = stripComments(body);
  assert.doesNotMatch(code, /_loadBrandCounts/,
    'up to twenty-seven /api/products/counts requests off a page the customer reached '
    + 'by failing, against a limiter shared with the whole storefront');
  assert.doesNotMatch(code, /data-count=/, 'no count slot means no temptation to fill it');

  // Positive control.
  assert.match('this._loadBrandCounts(inkBrands);', /_loadBrandCounts/, 'positive control');
});

// ── 5. The CSS the tiles depend on ───────────────────────────────────────────

test('the brand tile reuses the shop logo class rather than restyling logos', () => {
  const body = recoveryBody();
  assert.match(body, /class="drilldown-box__logo drilldown-box__logo--\$\{Security\.escapeAttr\(slug\)\}"/,
    'reusing .drilldown-box__logo is what gives these tiles the per-slug heights AND '
    + 'the base max-height cap — without the cap an unknown brand renders at natural '
    + 'size (Brother’s PNG is 3461x809)');

  assert.match(searchCss, /\.recovery-tile--brand \{/, 'the brand tile variant must be styled');
  assert.match(searchCss, /\.search-recovery__rail-grid--brands \{/,
    'twenty-seven tiles need a tighter track than the six-tile default');
});
