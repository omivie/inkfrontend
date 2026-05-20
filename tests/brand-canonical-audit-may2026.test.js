/**
 * Brand canonical + category-landing audit — May 2026
 * ====================================================
 *
 * Pins the SPA half of the backend dev's brand-canonical audit. The backend
 * now exclusively nominates `/shop?brand=<slug>` as the brand-hub canonical
 * (sitemap, internal links, prerender canonicals) and `/ink-cartridges` +
 * `/toner-cartridges` as the canonical category landings. For the
 * duplicate-content / canonicalisation work to actually close, the SPA must:
 *
 *   1.  Never serve `/brand/<slug>` as a page (Vercel must 301 it).
 *   2.  Never emit `/brand/<slug>` links from SPA code (only `/shop?brand=…`).
 *   3.  Always include `brand=` when building a printer-hub URL. The bot-
 *       prerender middleware must require both `brand` AND `printer_slug`
 *       for the printer prerender branch — bare `printer_slug` falls through.
 *   4.  Hand-rendered product breadcrumbs route the type level through
 *       `?category=<slug>`, never `?type=<product_type>` (which was always a
 *       404 selector).
 *   5.  Mount the SPA at `/ink-cartridges` and `/toner-cartridges` so the
 *       schema's `collectionPage.url` matches the rendered page URL.
 *
 * These five points are independent enough to keep in one file because they
 * share the audit's intent (one canonical URL per page) and the backend dev
 * delivered them as one handoff.
 *
 * Run with: node --test tests/brand-canonical-audit-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const VERCEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'inkcartridges', 'vercel.json'), 'utf8'));
const MIDDLEWARE = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'middleware.js'), 'utf8');
const UTILS = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'utils.js'), 'utf8');
const SHOP_JS = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'shop-page.js'), 'utf8');
const ACCOUNT_JS = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'account.js'), 'utf8');
const PDP_JS = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'product-detail-page.js'), 'utf8');
const INK_FINDER_JS = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'ink-finder.js'), 'utf8');
const MEGA_NAV_JS = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'mega-nav.js'), 'utf8');
const SEARCH_JS = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'search.js'), 'utf8');

// Eval buildPrinterUrl + slugifyBrand against a minimal jsdom-free scaffold so
// the tests can exercise the actual helper, not a re-implementation. We pull
// just the IIFE-free function bodies out of utils.js.
function loadUtilsHelpers() {
    const ctx = { window: {} };
    // Strip the `if (typeof window !== 'undefined')` global-binding tails so
    // we can `with`/eval the helpers in a tiny sandbox.
    const slugifySrc = UTILS.match(/function\s+slugifyBrand\s*\([\s\S]*?\n\}/)[0];
    const buildSrc = UTILS.match(/function\s+buildPrinterUrl\s*\([\s\S]*?\n\}\n/)[0];
    // eslint-disable-next-line no-new-func
    const factory = new Function(`${slugifySrc}\n${buildSrc}\nreturn { slugifyBrand, buildPrinterUrl };`);
    return factory();
}
const { slugifyBrand, buildPrinterUrl } = loadUtilsHelpers();

// ────────────────────────────────────────────────────────────────────────
// Item 1 — /brand/<slug> 301-redirects to /shop?brand=<slug>
// ────────────────────────────────────────────────────────────────────────

test('vercel.json: /brand/:slug 301-redirects to /shop?brand=:slug (item 1)', () => {
    const r = VERCEL.redirects.find(x => x.source === '/brand/:slug');
    assert.ok(r, '/brand/:slug must have a redirect entry');
    assert.equal(r.destination, '/shop?brand=:slug');
    assert.equal(r.permanent, true, 'must be a 301 (permanent) so canonical signal is strongest');
});

test('vercel.json: /brands/:slug and /brands/:slug/hub also redirect (item 1 — collateral)', () => {
    const a = VERCEL.redirects.find(x => x.source === '/brands/:slug');
    const b = VERCEL.redirects.find(x => x.source === '/brands/:slug/hub');
    assert.ok(a && b, 'both /brands/:slug and /brands/:slug/hub redirect entries must exist');
    assert.equal(a.destination, '/shop?brand=:slug');
    assert.equal(b.destination, '/shop?brand=:slug');
});

test('middleware.js does NOT prerender /brand/<slug> directly (item 1)', () => {
    // /brand/<slug> is gone via 301; middleware should never touch it.
    assert.ok(!/\/brand\//.test(MIDDLEWARE.replace(/\/\/.*\n|\/\*[\s\S]*?\*\//g, '')) ||
              /301-redirect/.test(MIDDLEWARE),
        'middleware must not handle /brand/<slug> paths — they are gone via 301');
});

// ────────────────────────────────────────────────────────────────────────
// Item 2 — No SPA code emits /brand/<slug> as a link target
// ────────────────────────────────────────────────────────────────────────

test('SPA emits zero /brand/<slug>-style hrefs (item 2)', () => {
    // Match `/brand/<anything-non-slash>` as an actual link target. We allow
    // /assets/brands/, /api/.../by-brand/, "/ribbon-brands/...", and
    // comment-only mentions — those are not href values.
    const offending = [];
    const files = [
        ['shop-page.js', SHOP_JS],
        ['account.js', ACCOUNT_JS],
        ['product-detail-page.js', PDP_JS],
        ['ink-finder.js', INK_FINDER_JS],
        ['mega-nav.js', MEGA_NAV_JS],
        ['search.js', SEARCH_JS],
        ['utils.js', UTILS],
    ];
    for (const [name, src] of files) {
        // Look for `"/brand/...` or `'/brand/...` or `` `/brand/... `` (template).
        const matches = src.match(/['"`]\/brand\/[a-z0-9\-]/gi) || [];
        if (matches.length) offending.push(`${name}: ${matches.join(', ')}`);
    }
    assert.equal(offending.length, 0,
        `No SPA file may emit /brand/<slug> links — found:\n  ${offending.join('\n  ')}`);
});

test('mega-nav builds brand cards via /shop?brand=<slug>, not /brand/<slug> (item 2)', () => {
    assert.match(MEGA_NAV_JS, /\/shop\?brand=\$\{[^}]*brand\.slug[^}]*\}/,
        'mega-nav brand-card hrefs must use /shop?brand=<slug>');
});

// ────────────────────────────────────────────────────────────────────────
// Item 3 — Printer URL construction always includes brand
// ────────────────────────────────────────────────────────────────────────

test('slugifyBrand handles common multi-word + caps brand names', () => {
    assert.equal(slugifyBrand('Brother'), 'brother');
    assert.equal(slugifyBrand('HP'), 'hp');
    assert.equal(slugifyBrand('Fuji Xerox'), 'fuji-xerox');
    assert.equal(slugifyBrand('Konica Minolta'), 'konica-minolta');
    assert.equal(slugifyBrand('  OKI  '), 'oki');
    assert.equal(slugifyBrand(''), '');
    assert.equal(slugifyBrand(null), '');
});

test('buildPrinterUrl: flat brand_slug shape (canonical case)', () => {
    const url = buildPrinterUrl({ slug: 'mfc-l2750dw', brand_slug: 'brother' });
    assert.equal(url, '/shop?brand=brother&printer_slug=mfc-l2750dw');
});

test('buildPrinterUrl: nested brand.slug shape (search-printers response)', () => {
    const url = buildPrinterUrl({ slug: 'mfc-l2750dw', brand: { slug: 'brother' } });
    assert.equal(url, '/shop?brand=brother&printer_slug=mfc-l2750dw');
});

test('buildPrinterUrl: nested printer_models.brand_slug (saved-printer join)', () => {
    const url = buildPrinterUrl({
        printer_models: { slug: 'mfc-l2750dw', brand_slug: 'brother' },
    });
    assert.equal(url, '/shop?brand=brother&printer_slug=mfc-l2750dw');
});

test('buildPrinterUrl: brand display-name string falls back to slugify', () => {
    // Saved-printer rows ship `brand` as a plain string. The helper slugifies
    // it so we still emit the canonical branded URL — no `allowUnbranded`
    // needed for the common saved-printer case.
    const url = buildPrinterUrl({ slug: 'mfc-l2750dw', brand: 'Brother' });
    assert.equal(url, '/shop?brand=brother&printer_slug=mfc-l2750dw');
});

test('buildPrinterUrl: brand_name property recognised', () => {
    const url = buildPrinterUrl({ slug: 'pixma-ts3560', brand_name: 'Canon' });
    assert.equal(url, '/shop?brand=canon&printer_slug=pixma-ts3560');
});

test('buildPrinterUrl: no brand info + strict mode returns null', () => {
    const url = buildPrinterUrl({ slug: 'pixma-ts3560' });
    assert.equal(url, null,
        'No brand info + strict mode must return null so callers hide the affordance, not render a non-canonical URL');
});

test('buildPrinterUrl: no brand info + allowUnbranded returns unbranded form', () => {
    const url = buildPrinterUrl({ slug: 'pixma-ts3560' }, { allowUnbranded: true });
    assert.equal(url, '/shop?printer_slug=pixma-ts3560',
        'allowUnbranded last-resort form is /shop?printer_slug=<slug>');
});

test('buildPrinterUrl: missing slug returns null even with brand', () => {
    assert.equal(buildPrinterUrl({ brand_slug: 'brother' }), null);
    assert.equal(buildPrinterUrl(null), null);
    assert.equal(buildPrinterUrl('not-an-object'), null);
});

test('utils.js exposes slugifyBrand on window (used by search.js / account.js inline calls)', () => {
    assert.match(UTILS, /window\.slugifyBrand\s*=\s*slugifyBrand/,
        'slugifyBrand must be exposed on window so callers outside utils.js can use it');
});

test('middleware.js: /shop prerender requires BOTH brand AND printer_slug (item 3)', () => {
    // Strip JS line + block comments so the regex doesn't catch the
    // intent-explainer comments above the actual gate.
    const code = MIDDLEWARE.replace(/\/\/[^\n]*\n|\/\*[\s\S]*?\*\//g, '');
    assert.match(code, /if\s*\(\s*brandSlug\s*&&\s*printerSlug\s*\)\s*\{\s*prerenderPath\s*=\s*`\/api\/prerender\/printer\//,
        'middleware must gate printer prerender on both brand AND printer_slug present');
});

test('middleware.js: /shop?brand= alone still prerenders the brand hub (item 3 — collateral)', () => {
    // The brand-hub prerender stays — it's only the printer prerender that
    // needs the joint gate.
    assert.match(MIDDLEWARE, /\/api\/prerender\/brand\//,
        'brand-hub prerender path must still be wired');
});

test('shop-page.js matched_printer handoff prefers branded URL (item 3)', () => {
    // The matched_printer fallback used to opt straight into allowUnbranded.
    // Now it tries strict-mode buildPrinterUrl first, only falling back when
    // brand truly can't be resolved.
    const m = SHOP_JS.match(/matched_printer[\s\S]{0,2200}?buildPrinterUrl\(p2\)/);
    assert.ok(m, 'matched_printer handoff must call buildPrinterUrl(p2) (strict mode) before any allowUnbranded fallback');
});

test('shop-page.js compat-recovery rail uses strict-mode buildPrinterUrl (item 3)', () => {
    // The "This cartridge fits these printers" rail is publicly indexed
    // through /shop search-result pages — it must never emit a non-canonical
    // <a>. The rail's map(p => { … }) body must call buildPrinterUrl(p) in
    // strict mode (no allowUnbranded opt-in) and hide cards that come back
    // null.
    const block = SHOP_JS.match(/compatible_printers[\s\S]*?recovery-printer-card[^]*?recovery-printer-card__name/);
    assert.ok(block, 'compat-recovery rail block must be findable');
    const src = block[0];
    assert.match(src, /buildPrinterUrl\(p\)\s*\n\s*:\s*null/,
        'compat-recovery rail must call buildPrinterUrl(p) in strict mode (no allowUnbranded option)');
    assert.match(src, /if\s*\(!href\)\s*return\s+['"]['"];/,
        'compat-recovery rail must hide the card when buildPrinterUrl returns null');
});

test('ink-finder Find-Ink CTA emits canonical branded URL (item 3)', () => {
    // selectedBrand is already a brand slug (data-brand attribute), so
    // strict-mode buildPrinterUrl always yields the canonical form here.
    const m = INK_FINDER_JS.match(/buildPrinterUrl\(\s*\{\s*slug:\s*selectedModel,\s*brand_slug:\s*selectedBrand\s*\}\s*\)/);
    assert.ok(m, 'ink-finder must call buildPrinterUrl({ slug, brand_slug }) without allowUnbranded');
});

test('account.js enrichPrintersData lifts brand_slug + brand from nested join (item 3)', () => {
    // Saved-printer rows ship the model nested under printer_models. Lifting
    // brand_slug and brand to the top level lets buildPrinterUrl emit the
    // canonical /shop?brand=&printer_slug= shape for every saved printer.
    assert.match(ACCOUNT_JS, /brand_slug:\s*p\.brand_slug\s*\|\|\s*nested\.brand_slug/,
        'enrichPrintersData must lift brand_slug from the nested join');
    assert.match(ACCOUNT_JS, /brand:\s*p\.brand\s*\|\|\s*nested\.brand_name/,
        'enrichPrintersData must lift brand (display name) from the nested join');
});

// ────────────────────────────────────────────────────────────────────────
// Item 4 — Breadcrumb category-level uses ?category=, never ?type=
// ────────────────────────────────────────────────────────────────────────

test('PDP breadcrumb category link uses ?category=, not ?type= (item 4)', () => {
    // The category-level breadcrumb on the product detail page must route to
    // /shop?brand=...&category=<slug>. The old ?type=<product_type> selector
    // was always a 404 and is documented as gone in the audit.
    assert.match(PDP_JS, /breadcrumb-category[\s\S]{0,400}\?brand=\$\{[^}]+\}&category=\$\{[^}]+\}/,
        'breadcrumb-category innerHTML must build ?brand=…&category=…');
    // No `?type=` URL emission anywhere in the PDP controller.
    assert.equal(/\?type=\$\{/.test(PDP_JS), false,
        'product-detail-page.js must not emit any ?type=<value> URL parameter');
});

test('No customer-facing SPA file emits ?type=<value> URL params (item 4)', () => {
    // Admin code is allowed to filter via product_type (its own listing).
    // Customer-facing JS routes type filtering through `?type=` BODY (as a
    // genuine/compatible filter) and category filtering through `?category=`.
    const offending = [];
    const files = [
        ['shop-page.js', SHOP_JS],
        ['account.js', ACCOUNT_JS],
        ['product-detail-page.js', PDP_JS],
        ['mega-nav.js', MEGA_NAV_JS],
    ];
    for (const [name, src] of files) {
        // We DO allow `?type=` inside template literals where the value is
        // the legitimate genuine/compatible filter — that's a tiny set:
        // `?type=genuine`, `?type=compatible`. Anything else is suspect.
        // For this test we just check no file builds `?type=${something}`
        // referencing product_type/category-style values.
        const re = /\?type=\$\{[^}]*(?:product_type|category)[^}]*\}/g;
        const hits = src.match(re) || [];
        if (hits.length) offending.push(`${name}: ${hits.join(', ')}`);
    }
    assert.equal(offending.length, 0,
        `No SPA file may emit ?type=<product_type or category>:\n  ${offending.join('\n  ')}`);
});

// ────────────────────────────────────────────────────────────────────────
// Item 5 — Category landing at /ink-cartridges and /toner-cartridges
// ────────────────────────────────────────────────────────────────────────

test('vercel.json: /ink-cartridges and /toner-cartridges are REWRITES, not redirects (item 5)', () => {
    const inkRedirect = VERCEL.redirects.find(x => x.source === '/ink-cartridges');
    const tonerRedirect = VERCEL.redirects.find(x => x.source === '/toner-cartridges');
    assert.equal(inkRedirect, undefined,
        '/ink-cartridges must NOT 301-redirect — it must serve the SPA so the schema canonical URL matches the rendered URL');
    assert.equal(tonerRedirect, undefined,
        '/toner-cartridges must NOT 301-redirect — same reason as /ink-cartridges');

    const inkRewrite = VERCEL.rewrites.find(x => x.source === '/ink-cartridges');
    const tonerRewrite = VERCEL.rewrites.find(x => x.source === '/toner-cartridges');
    assert.ok(inkRewrite, '/ink-cartridges must have a rewrite to /html/shop');
    assert.ok(tonerRewrite, '/toner-cartridges must have a rewrite to /html/shop');
    assert.equal(inkRewrite.destination, '/html/shop');
    assert.equal(tonerRewrite.destination, '/html/shop');
});

test('shop-page.js parseURLState seeds category from /ink-cartridges path (item 5)', () => {
    assert.match(SHOP_JS, /pathCategory\s*=\s*\(window\.location\.pathname\s*===\s*['"]\/ink-cartridges['"]/,
        'parseURLState must detect /ink-cartridges in pathname and seed category=ink');
    assert.match(SHOP_JS, /\?\s*['"]toner['"]\s*\n?\s*:\s*null/,
        'parseURLState must detect /toner-cartridges in pathname and seed category=toner');
    assert.match(SHOP_JS, /this\.state\.category\s*=\s*params\.get\(\s*['"]category['"]\s*\)\s*\|\|\s*pathCategory/,
        '?category= query param must win over pathname (so /shop?category=ink still works)');
});

test('shop-page.js updateURL emits /ink-cartridges for category-only state (item 5)', () => {
    assert.match(SHOP_JS, /categoryLandings\s*=\s*\{\s*ink:\s*['"]\/ink-cartridges['"]\s*,\s*toner:\s*['"]\/toner-cartridges['"]\s*\}/,
        'updateURL must map category=ink → /ink-cartridges and category=toner → /toner-cartridges');
    // The updateURL isCategoryOnly check spans multiple lines (one
    // `&& !this.state.X` per filter). Use `.*` with the `s` (dotAll) flag so
    // the regex spans newlines.
    assert.match(SHOP_JS, /isCategoryOnly\s*=\s*!this\.state\.brand[\s\S]*?this\.state\.category;/,
        'updateURL must check isCategoryOnly before switching to the landing path');
});

test('shop-page.js updateSEO canonical points at /ink-cartridges or /toner-cartridges for category-only state (item 5)', () => {
    // The schema's CollectionPage.url and the <link rel="canonical"> must
    // agree — both point at the dedicated landing URL.
    assert.match(SHOP_JS, /isCategoryOnly\s*=\s*!brand\s*&&\s*!code\s*&&\s*!this\.state\.printer\s*&&\s*!this\.state\.search/,
        'updateSEO must detect the category-only state');
    assert.match(SHOP_JS, /canonical\s*=\s*`\$\{BASE\}\$\{categoryLandings\[lc\(category\)\]\}`/,
        'updateSEO canonical must point at the landing URL for category-only state');
});

test('middleware.js prerenders /ink-cartridges and /toner-cartridges for bots (item 5)', () => {
    assert.match(MIDDLEWARE, /path\s*===\s*['"]\/ink-cartridges['"][\s\S]{0,200}\/api\/prerender\/category\/ink/,
        'middleware must map /ink-cartridges to /api/prerender/category/ink for bots');
    assert.match(MIDDLEWARE, /path\s*===\s*['"]\/toner-cartridges['"][\s\S]{0,200}\/api\/prerender\/category\/toner/,
        'middleware must map /toner-cartridges to /api/prerender/category/toner for bots');
    assert.match(MIDDLEWARE, /matcher:\s*\[[\s\S]*?['"]\/ink-cartridges['"][\s\S]*?\]/,
        'middleware matcher must include /ink-cartridges so the function runs on bot requests');
    assert.match(MIDDLEWARE, /matcher:\s*\[[\s\S]*?['"]\/toner-cartridges['"][\s\S]*?\]/,
        'middleware matcher must include /toner-cartridges so the function runs on bot requests');
});

test('No SPA file references /ink (singular, the old 404 path) as a URL target (item 5)', () => {
    const files = [
        ['shop-page.js', SHOP_JS],
        ['account.js', ACCOUNT_JS],
        ['product-detail-page.js', PDP_JS],
        ['ink-finder.js', INK_FINDER_JS],
        ['mega-nav.js', MEGA_NAV_JS],
        ['search.js', SEARCH_JS],
    ];
    const offending = [];
    for (const [name, src] of files) {
        // Match `"/ink"` / `'/ink'` / `` `/ink` `` as full URLs (not as a
        // prefix of /ink-cartridges or /ink-finder etc.).
        const re = /['"`]\/ink['"`]/g;
        const hits = src.match(re) || [];
        if (hits.length) offending.push(`${name}: ${hits.join(', ')}`);
    }
    assert.equal(offending.length, 0,
        `Old /ink (singular) URLs are forbidden (was a 404 path):\n  ${offending.join('\n  ')}`);
});
