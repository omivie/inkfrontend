/**
 * Series page honours `&source=` on ad landing pages
 * ==================================================
 *
 * backend-docs/inbox/series-page-source-filter-FE-handoff-oct2026.md
 * (2026-10-08, FE master checklist item 21). The owner's "Winners" and
 * "Exclusive" Search ad groups land on
 * `/shop?brand=…&code=…&source=compatible|genuine`. The series page ignored
 * `source`: both /api/shop requests (LC3319XL and the yield-less LC3319) went
 * out without it, and all 12 LC3319 products showed where the ad paid for 6.
 *
 * Found on the way (see errors.md):
 *   - the filter already existed under the URL name `type`, unvalidated
 *     (`?type=foo` would have labelled the page "Compatible Only");
 *   - its chip had been DEAD since Mar 2026 — renderActiveFilters wrote into
 *     #active-filters, which shop.html no longer has, so it returned early.
 *
 *   §1 _sourceFilterFrom — `source` first, legacy `type`, only the two values
 *      /api/shop accepts (anything else is a 400 VALIDATION_FAILED there)
 *   §2 updateURL writes `source`, never `type`; { replace } ⇒ replaceState
 *   §3 removeFilter('type') replaces the history entry; other chips push
 *   §4 renderActiveFilters owns #source-filter-chip: label, aria, hidden,
 *      click; product type only — no price wording (invariant 13)
 *   §5 loadProducts sends `source` on BOTH /api/shop calls
 *   §6 the canonical never carries `source` or `type`
 *   §7 shop.html: the chip sits in the breadcrumb row and ships hidden
 *
 * The rendered page (requests, card count, chip click, geometry) is measured
 * by `npm run probe:series-source`, which a source test cannot see.
 *
 * Run: node --test tests/series-source-filter-oct2026.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, 'inkcartridges', p), 'utf8');

const SHOP_SRC = read('js/shop-page.js');
const SHOP_CODE = stripComments(SHOP_SRC);
const SHOP_HTML = read('html/shop.html');
const PAGES_CSS = read('css/pages.css');

/** Lift `name(args) { … }` out of an object literal, brace-matched from its body. */
function liftMethod(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start >= 0, `${signature} must exist in the shipped source`);
    let i = src.indexOf('(', start), pd = 0;
    for (; i < src.length; i++) {
        if (src[i] === '(') pd++;
        else if (src[i] === ')') { pd--; if (!pd) break; }
    }
    let depth = 0, end = i;
    for (i = src.indexOf('{', i); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (!depth) { end = i; break; } }
    }
    return src.slice(start, end + 1);
}

function liftInto(signatures, globals) {
    const sandbox = Object.assign({ console, URLSearchParams }, globals);
    vm.createContext(sandbox);
    vm.runInContext(`globalThis.__lifted = {\n${signatures.map((s) => liftMethod(SHOP_SRC, s)).join(',\n')}\n};`, sandbox);
    return sandbox.__lifted;
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 the parser
// ─────────────────────────────────────────────────────────────────────────────

test('§1 _sourceFilterFrom: source, then legacy type, only genuine|compatible', () => {
    const { _sourceFilterFrom } = liftInto(['_sourceFilterFrom(params) {'], {});
    const of = (qs) => _sourceFilterFrom(new URLSearchParams(qs));
    assert.equal(of('brand=brother&code=LC3319XL&source=compatible'), 'compatible');
    assert.equal(of('source=genuine'), 'genuine');
    assert.equal(of('type=compatible'), 'compatible', 'old ?type= links keep working');
    assert.equal(of('source=genuine&type=compatible'), 'genuine', 'source wins');
    assert.equal(of('source=bogus&type=genuine'), 'genuine', 'an invalid source does not mask a valid type');
    assert.equal(of('source=%20Compatible%20'), 'compatible', 'case and whitespace normalised');
    // /api/shop answers any other value with 400 VALIDATION_FAILED (measured
    // 2026-10-08) — forwarding one would blank the page. Ignored instead.
    for (const qs of ['', 'source=', 'source=bogus', 'type=foo', 'source=all', 'source=genuine,compatible']) {
        assert.equal(of(qs), null, `"${qs}" must be ignored`);
    }
});

test('§1 parseURLState reads the filter ONLY through _sourceFilterFrom', () => {
    const body = liftMethod(SHOP_CODE, 'parseURLState() {');
    assert.match(body, /this\.state\.type = this\._sourceFilterFrom\(params\);/);
    assert.doesNotMatch(body, /params\.get\('type'\)|params\.get\('source'\)/,
        'a raw read would let an unvalidated value back into state.type');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 / §3 the address bar
// ─────────────────────────────────────────────────────────────────────────────

function urlHarness(state) {
    const calls = [];
    const history = {
        pushState: (_s, _t, url) => calls.push(['push', url]),
        replaceState: (_s, _t, url) => calls.push(['replace', url]),
    };
    const window = { location: { pathname: '/shop', search: '' } };
    const lifted = liftInto(['updateURL({ replace = false } = {}) {', 'removeFilter(filterType) {'], { history, window });
    const ctx = {
        state: Object.assign({ brand: 'brother', category: null, code: 'LC3319', type: null, sort: 'recommended', inStock: false, search: null, page: 1, level: 'products' }, state),
        CATEGORY_CANONICAL_BY_INTERNAL: {},
        _freshIntent: () => null,
        cache: { products: { stale: 1 } },
        navigationVersion: 0,
        loadCurrentLevel() {},
        renderActiveFilters() { ctx.rendered = (ctx.rendered || 0) + 1; },
    };
    ctx.updateURL = lifted.updateURL.bind(ctx);
    ctx.removeFilter = lifted.removeFilter.bind(ctx);
    return { ctx, calls };
}

test('§2 updateURL writes source=, never type=; pushState by default, replaceState on request', () => {
    const { ctx, calls } = urlHarness({ type: 'compatible' });
    ctx.updateURL();
    ctx.updateURL({ replace: true });
    assert.deepEqual(calls, [
        ['push', '/shop?brand=brother&code=LC3319&source=compatible'],
        ['replace', '/shop?brand=brother&code=LC3319&source=compatible'],
    ]);
    const plain = urlHarness({});
    plain.ctx.updateURL();
    assert.deepEqual(plain.calls, [['push', '/shop?brand=brother&code=LC3319']]);
});

test('§3 removing the source chip replaces the entry, drops source and reloads', () => {
    const { ctx, calls } = urlHarness({ type: 'compatible' });
    ctx.removeFilter('type');
    assert.equal(ctx.state.type, null);
    assert.deepEqual(calls, [['replace', '/shop?brand=brother&code=LC3319']]);
    assert.equal(Object.keys(ctx.cache.products).length, 0, 'cache invalidated so the unfiltered family is fetched');
    assert.equal(ctx.navigationVersion, 1, 'the grid reloads');
    assert.equal(ctx.rendered, 1, 'the chip re-renders (and hides)');

    const other = urlHarness({ search: 'lc3319', level: 'search-results' });
    other.ctx.removeFilter('search');
    assert.equal(other.calls[0][0], 'push', 'every other chip keeps its history entry');
});

test('§2 the search form carries the filter as source', () => {
    const body = liftMethod(SHOP_CODE, 'setupSearchForm() {');
    assert.match(body, /upsertHidden\('source', this\.state\.type\)/);
    assert.doesNotMatch(body, /upsertHidden\('type'/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 the chip
// ─────────────────────────────────────────────────────────────────────────────

function chipHarness(type) {
    const chip = {
        hidden: true, innerHTML: '', textContent: '', onclick: null, attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
    };
    const document = { getElementById: (id) => (id === 'source-filter-chip' ? chip : null) };
    const { renderActiveFilters } = liftInto(['renderActiveFilters() {'], { document });
    const removed = [];
    const ctx = { state: { type }, removeFilter: (t) => removed.push(t) };
    renderActiveFilters.call(ctx);
    return { chip, removed };
}

test('§4 the chip names the filter, is removable, and hides when there is none', () => {
    for (const [type, label] of [['compatible', 'Compatible only'], ['genuine', 'Genuine only']]) {
        const { chip, removed } = chipHarness(type);
        assert.equal(chip.hidden, false, `${type}: chip shown`);
        assert.match(chip.innerHTML, new RegExp(`<span>${label}</span><svg`));
        assert.equal(chip.attrs['aria-label'], `Remove filter: ${label}`);
        chip.onclick();
        assert.deepEqual(removed, ['type']);
    }
    for (const type of [null, undefined, 'foo']) {
        const { chip } = chipHarness(type);
        assert.equal(chip.hidden, true, `${type}: no chip`);
        assert.equal(chip.textContent, '');
    }
});

test('§4 invariant 13: the chip says product type only — no price wording', () => {
    const body = liftMethod(SHOP_CODE, 'renderActiveFilters() {');
    const strings = [...body.matchAll(/'([^']*)'|`([^`]*)`/g)].map((m) => m[1] || m[2] || '');
    for (const s of strings) {
        assert.doesNotMatch(s, /\b(cheap\w*|lowest|best|price|save|saving|deal)\b/i, `"${s}"`);
    }
});

test('§4 the dead #active-filters writer is gone (the bar left shop.html in 19580524)', () => {
    const body = liftMethod(SHOP_CODE, 'renderActiveFilters() {');
    assert.doesNotMatch(body, /active-filters/);
    assert.doesNotMatch(SHOP_HTML, /id="active-filters"/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 the requests
// ─────────────────────────────────────────────────────────────────────────────

test('§5 loadProducts sends source on BOTH /api/shop calls (fan-out + stem reload)', () => {
    const body = liftMethod(SHOP_CODE, 'async loadProducts(navVersion) {');
    assert.match(body, /const sourceFilter = this\.state\.type \|\| null;/);
    const calls = body.split('API.getShopData(').slice(1);
    assert.equal(calls.length, 2, 'loadProducts makes exactly two getShopData calls — re-check this test if that changed');
    for (const [i, call] of calls.entries()) {
        const literal = call.slice(0, call.indexOf('}).catch'));
        assert.match(literal, /\.\.\.\(sourceFilter \? \{ source: sourceFilter \} : \{\}\)/, `getShopData call #${i + 1} must carry source`);
        assert.match(literal, /\.\.\.\(packFilter \? \{ pack: packFilter \} : \{\}\)/, `getShopData call #${i + 1} keeps pack (value-pack ads)`);
    }
    assert.match(body, /\$\{typeKey\}-products-\$\{code\}/, 'the per-code cache key carries the filter');
});

test('§5 the chip-grid level already sent source; it still validates', () => {
    const body = liftMethod(SHOP_CODE, 'async loadProductCodes(navVersion) {');
    const sends = body.match(/apiParams\.source = this\.state\.type;/g) || [];
    assert.equal(sends.length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 canonical
// ─────────────────────────────────────────────────────────────────────────────

test('§6 the canonical never carries source or type (search engines see ONE page)', () => {
    const body = liftMethod(SHOP_CODE, 'updateSEO() {');
    assert.match(body, /params\.set\('code',\s*code\)/);
    assert.doesNotMatch(body, /params\.set\('(source|type)'/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 markup + style
// ─────────────────────────────────────────────────────────────────────────────

test('§7 the chip ships hidden, in the breadcrumb row, as a button', () => {
    const left = SHOP_HTML.slice(SHOP_HTML.indexOf('<div class="drilldown-header__left">'), SHOP_HTML.indexOf('<div class="drilldown-header__right-group">'));
    assert.match(left, /<button type="button" class="drilldown-header__chip" id="source-filter-chip" hidden><\/button>/);
    assert.match(PAGES_CSS, /\.drilldown-header__chip\[hidden\] \{ display: none; \}/,
        'an author display rule would beat the UA [hidden] rule');
});
