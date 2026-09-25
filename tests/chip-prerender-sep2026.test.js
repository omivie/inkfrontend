/**
 * The chip/code prerender, and the mirror that was overwriting it
 * =============================================================================
 * ERR-270.
 *
 * `/shop?brand=<slug>&code=<code>` served Googlebot the GENERIC brand hub. The
 * backend has shipped the code-specific page since Sep 2026; the edge was never
 * asking for it, because the brand arm of middleware.js built the prerender path
 * from the brand slug alone and dropped the rest of the query string.
 *
 * The half that is easy to miss, and the reason this file asserts on TWO
 * sources: `js/seo-meta.js` carries a deliberate mirror of that routing, and
 * `SeoMeta.reconcile()` overwrites the page's <title>/<meta description> with
 * whatever that path returns. Google's render pass executes exactly that. Fixing
 * only the edge would have handed the crawler the LC73 title and then let the
 * SPA overwrite it with the generic one — and the same overwrite was firing on
 * every human load of a ?code= URL, which is a live defect nobody had reported.
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THIS FILE
 * -----------------------------------------------
 * The two sources agreeing is not something either file can state about itself.
 * A future edit to the middleware's allowlist that does not land in seo-meta.js
 * re-opens the overwrite silently: every page still renders, every existing test
 * still passes, and the only symptom is that the indexed title reverts weeks
 * later. §3 is the only thing that catches that.
 *
 * §1 EXECUTES the real middleware rather than grepping it — the brand arm is
 * built at runtime from a URLSearchParams, so a source grep would prove the
 * loop is spelled a certain way and nothing about the URL it produces. This
 * repo has shipped a 21-test suite that was entirely source greps (ERR-224).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const read = (p) => fs.readFileSync(p, 'utf8');

const MIDDLEWARE_SRC = read(path.join(INK, 'middleware.js'));
const SEO_SRC = read(path.join(INK, 'js', 'seo-meta.js'));
const SHOP_SRC = read(path.join(INK, 'js', 'shop-page.js'));

const SeoMeta = require(path.join(INK, 'js', 'seo-meta.js'));
const P = (search) => SeoMeta.prerenderPathForLocation({ pathname: '/shop', search });

const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

// ─────────────────────────────────────────────────────────────────────────────
// Harness — import the REAL middleware and capture the URL it fetches.
//
// middleware.js is an ES module (`export default`) inside a CommonJS package,
// so require() cannot load it and a bare import() would parse it as CJS. We
// copy it to a .mjs alongside itself so its own relative identity is unchanged,
// then import that. `node --check` is a no-op on this file for the same reason
// (it lints it as a script), which is why the repo's convention is to copy to
// .mjs before checking it at all.
// ─────────────────────────────────────────────────────────────────────────────
let middlewareFn = null;
let tmpFile = null;

async function loadMiddleware() {
    if (middlewareFn) return middlewareFn;
    tmpFile = path.join(os.tmpdir(), `ic-middleware-${process.pid}-${Date.now()}.mjs`);
    fs.writeFileSync(tmpFile, MIDDLEWARE_SRC);
    const mod = await import(`file://${tmpFile}`);
    middlewareFn = mod.default;
    return middlewareFn;
}

test.after(() => {
    if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
});

function fakeRequest(url, { ua = GOOGLEBOT, cookie = '' } = {}) {
    return {
        url,
        headers: {
            get(name) {
                const key = String(name).toLowerCase();
                if (key === 'user-agent') return ua;
                if (key === 'cookie') return cookie;
                return null;
            },
        },
    };
}

/**
 * Run the middleware against one URL and report which backend URL it asked for.
 * Returns null when the middleware fell through to the SPA (no prerender).
 */
async function prerenderFetchFor(url, opts) {
    const fn = await loadMiddleware();
    const originalFetch = globalThis.fetch;
    let fetched = null;
    globalThis.fetch = async (target) => {
        fetched = String(target);
        return new Response('<html><head><title>stub</title></head><body></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
        });
    };
    try {
        await fn(fakeRequest(url, opts));
    } finally {
        globalThis.fetch = originalFetch;
    }
    return fetched;
}

const BACKEND = 'https://ink-backend-zaeq.onrender.com';
const SITE = 'https://www.inkcartridges.co.nz';

// ─────────────────────────────────────────────────────────────────────────────
// §1 — the middleware, EXECUTED
// ─────────────────────────────────────────────────────────────────────────────

test('§1 brand+code fetches the code-specific prerender (the reported bug)', async () => {
    assert.equal(
        await prerenderFetchFor(`${SITE}/shop?brand=brother&code=LC73`),
        `${BACKEND}/api/prerender/brand/brother?code=LC73`);
});

test('§1 brand+category fetches the category-scoped brand prerender', async () => {
    assert.equal(
        await prerenderFetchFor(`${SITE}/shop?brand=brother&category=toner`),
        `${BACKEND}/api/prerender/brand/brother?category=toner`);
});

test('§1 bare brand is unchanged — no empty ?', async () => {
    assert.equal(
        await prerenderFetchFor(`${SITE}/shop?brand=brother`),
        `${BACKEND}/api/prerender/brand/brother`);
});

test('§1 ONLY code+category are forwarded — tracking params must not fragment the CDN', async () => {
    // Each distinct URL is its own s-maxage=3600 edge entry AND its own origin
    // fetch. Forwarding url.search verbatim (what the handoff asked for) is
    // *safe* — measured 2026-09-20, the backend ignores unknown params — but it
    // would multiply both for byte-identical content.
    assert.equal(
        await prerenderFetchFor(`${SITE}/shop?brand=brother&utm_source=news&gclid=abc&fbclid=z`),
        `${BACKEND}/api/prerender/brand/brother`);
    assert.equal(
        await prerenderFetchFor(`${SITE}/shop?brand=brother&code=LC73&utm_medium=email`),
        `${BACKEND}/api/prerender/brand/brother?code=LC73`);
});

test('§1 a non-bot gets no prerender fetch at all', async () => {
    assert.equal(
        await prerenderFetchFor(`${SITE}/shop?brand=brother&code=LC73`, { ua: 'Mozilla/5.0 (Macintosh)' }),
        null);
});

test('§1 printer hub still wins over brand and forwards nothing', async () => {
    // Measured 2026-09-20: the printer and category prerenders both ignore
    // ?code=, so forwarding it there would be inert. Precedence is unchanged.
    assert.equal(
        await prerenderFetchFor(`${SITE}/shop?brand=brother&printer_slug=x&code=LC73`),
        `${BACKEND}/api/prerender/printer/brother/x`);
});

test('§1 the sole-filter category arm is untouched by this change', async () => {
    assert.equal(
        await prerenderFetchFor(`${SITE}/shop?category=drums`),
        `${BACKEND}/api/prerender/category/drums`);
    // code present => not a sole filter => no prerender, exactly as before.
    assert.equal(
        await prerenderFetchFor(`${SITE}/shop?category=drums&code=DR2325`),
        null);
});

test('§1 an empty code/category value is not forwarded as an empty param', async () => {
    assert.equal(
        await prerenderFetchFor(`${SITE}/shop?brand=brother&code=`),
        `${BACKEND}/api/prerender/brand/brother`);
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — the SPA mirror, EXECUTED
// ─────────────────────────────────────────────────────────────────────────────

test('§2 seo-meta forwards the same allowlist', () => {
    assert.equal(P('?brand=brother&code=LC73'), '/api/prerender/brand/brother?code=LC73');
    assert.equal(P('?brand=brother&category=toner'), '/api/prerender/brand/brother?category=toner');
    assert.equal(P('?brand=brother'), '/api/prerender/brand/brother');
    assert.equal(P('?brand=brother&utm_source=news'), '/api/prerender/brand/brother');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — THE POINT OF THIS FILE: the two must agree, byte for byte
// ─────────────────────────────────────────────────────────────────────────────

test('§3 middleware and seo-meta build an IDENTICAL prerender URL', async () => {
    const cases = [
        '?brand=brother',
        '?brand=brother&code=LC73',
        '?brand=brother&category=toner',
        '?brand=brother&category=toner&code=LC73',
        '?brand=brother&code=LC73&category=toner',
        '?brand=brother&utm_source=news&code=LC73',
        '?brand=canon&code=PG-540',
    ];
    for (const search of cases) {
        const edge = await prerenderFetchFor(`${SITE}/shop${search}`);
        const spa = P(search);
        assert.equal(edge, `${BACKEND}${spa}`,
            `edge and SPA disagree for ${search} — SeoMeta.reconcile() would overwrite `
            + 'the prerendered title with a DIFFERENT page\'s title (ERR-270)');
    }
});

test('§3 key order is code-then-category on both sides', async () => {
    // Same params, opposite URL order, one canonical output. If these two ever
    // differ the two sides reconcile against different CDN cache entries.
    const a = await prerenderFetchFor(`${SITE}/shop?brand=brother&category=toner&code=LC73`);
    const b = await prerenderFetchFor(`${SITE}/shop?brand=brother&code=LC73&category=toner`);
    assert.equal(a, b);
    assert.match(a, /\?code=LC73&category=toner$/);
    assert.equal(P('?brand=brother&category=toner&code=LC73'), P('?brand=brother&code=LC73&category=toner'));
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — the canonical shop-page emits
// ─────────────────────────────────────────────────────────────────────────────

test('§4 shop-page drops ?category from the canonical once ?code is set', () => {
    assert.match(SHOP_SRC, /if \(category && !code\)\s+params\.set\('category',/,
        'the canonical must omit category when code is present — the backend\'s own '
        + 'prerender canonical does, and Google reads the BACKEND\'s canonical here');
    assert.match(SHOP_SRC, /if \(code\)\s+params\.set\('code',\s+code\);/);
});

test('§4 the measured rule is written down, not just the conclusion', () => {
    // A peer session measured ?category=toner&code=TN2330 -> the TONER page and
    // concluded "category beats code". TN2330 is simply not a code this endpoint
    // RESOLVES — it also falls back to the bare brand page on its own. One
    // unresolved sample reads exactly like the opposite rule, so the table stays
    // in the source where the next person will find it.
    assert.match(SHOP_SRC, /TN2330/,
        'keep the unresolved-code counter-example in the comment — it is the '
        + 'measurement that stops this being re-litigated from one sample');
    assert.match(SHOP_SRC, /LC73XL/,
        'keep the yield-suffix measurement: the backend collapses LC73XL -> LC73 '
        + 'itself, which is why there is no edge copy of collapseYieldSuffix');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — guard the guard
// ─────────────────────────────────────────────────────────────────────────────

test('§5 the sole-filter exclusion grep ia-reorg §6 depends on is still exact', () => {
    // tests/ia-reorg-jul2026.test.js greps this file for
    // `!url.searchParams.get('x')` and asserts the list is EXACTLY these five in
    // this order. The brand arm deliberately uses a different construction
    // (a URLSearchParams allowlist), so it adds no occurrence. If a future edit
    // reaches for `!url.searchParams.get(...)` in the brand arm, that test fails
    // somewhere else entirely and the reason will not be obvious — so it is
    // stated here too, next to the change that has to respect it.
    const found = [...MIDDLEWARE_SRC.matchAll(/!url\.searchParams\.get\('([a-z_]+)'\)/g)].map((m) => m[1]);
    assert.deepEqual(found, ['code', 'q', 'search', 'type', 'printer_model']);
});

test('§5 neither source forwards a wildcard', () => {
    assert.doesNotMatch(MIDDLEWARE_SRC, /prerender\/brand\/\$\{[^}]*\}\$\{?url\.search/,
        'do not append url.search verbatim to the brand prerender path');
    assert.doesNotMatch(SEO_SRC, /prerender\/brand\/\$\{[^}]*\}\$\{?loc\.search/);
});

test('§5 both sources name the allowlist keys literally', () => {
    for (const [label, src] of [['middleware.js', MIDDLEWARE_SRC], ['seo-meta.js', SEO_SRC]]) {
        assert.match(src, /\['code',\s*'category'\]/,
            `${label} must declare the forwarded allowlist as ['code', 'category']`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// ERR-286 — the chips became LINKS once the backend's series shard shipped
// (sitemap-series.xml, 535 brand+code URLs, measured 2026-09-25).
// ─────────────────────────────────────────────────────────────────────────────
{
    const fsX = require('node:fs');
    const pathX = require('node:path');
    const stripX = require('./helpers/strip-comments');
    const SHOP_X = stripX(fsX.readFileSync(pathX.join(__dirname, '..', 'inkcartridges', 'js', 'shop-page.js'), 'utf8'));
    const PDP_X = stripX(fsX.readFileSync(pathX.join(__dirname, '..', 'inkcartridges', 'js', 'product-detail-page.js'), 'utf8'));

    test('ERR-286: code chips are crawlable <a href> links, not buttons', () => {
        const fn = SHOP_X.slice(SHOP_X.indexOf('renderProductCodes(codes) {'), SHOP_X.indexOf('codeChipHref(code) {'));
        assert.match(fn, /document\.createElement\('a'\)/, 'a crawler cannot follow a <button>');
        assert.doesNotMatch(fn, /document\.createElement\('button'\)/);
        assert.match(fn, /box\.href = this\.codeChipHref\(code\)/);
        assert.match(fn, /e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey/, 'a modified click (new tab) belongs to the browser');
        assert.match(fn, /e\.preventDefault\(\);\s*this\.navigateTo\('products', \{ code \}\)/, 'a plain click still navigates in place');
    });

    test('ERR-286: the chip href is the two-param canonical', () => {
        const src = SHOP_X.slice(SHOP_X.indexOf('codeChipHref(code) {'));
        const body = src.slice(0, src.indexOf('\n        },') + 10);
        // eslint-disable-next-line no-new-func
        const make = (state) => new Function('URLSearchParams', `const o = { state: ${JSON.stringify(state)}, ${body} }; return o;`)(URLSearchParams);
        assert.equal(make({ brand: 'brother', category: 'ink' }).codeChipHref('LC73'), '/shop?brand=brother&code=LC73',
            'category is dropped once a brand names the chip — the sitemap/canonical shape');
        assert.equal(make({ brand: 'hp', category: 'ink' }).codeChipHref('C2P+'), '/shop?brand=hp&code=C2P%2B',
            'a + is encoded, or it decodes as a space');
        assert.equal(make({ brand: null, category: 'drums' }).codeChipHref('DR251'), '/shop?category=drums&code=DR251',
            '[CONTROL] a brandless codes view keeps its category so the link lands where the click does');
    });

    test('ERR-286: the PDP breadcrumb links the canonical chip page, URL-encoded', () => {
        assert.match(PDP_X, /\/shop\?brand=\$\{encodeURIComponent\(brandSlug\)\}&amp;code=\$\{encodeURIComponent\(productCode\)\}/);
        assert.doesNotMatch(PDP_X, /&category=\$\{Security\.escapeAttr\(canonCategory\)\}&code=/,
            'the three-param breadcrumb pointed at a noindex page');
    });
}
