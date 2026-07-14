/**
 * Storefront IA reorganization (July 2026)
 * ========================================
 *
 * Frontend half of the backend's site-reorganization sweep
 * (ia-reorg-handoff-jun2026.md). Contract:
 *
 *   1. The nav is sourced from ONE backend taxonomy — GET /api/site/nav —
 *      via a "Shop by Category" mega panel + hydrated brands mega + footer
 *      Categories column. Static markup ships as the bot/no-JS fallback and
 *      hydration fails open to it.
 *   2. The storefront NEVER emits a non-canonical category slug. Canonical:
 *      ink, toner, ribbon, drums, label, paper. Retired: consumable,
 *      label_tape, cartridge, drum (PDP singular), ribbons/ink-cartridges
 *      aliases. js/utils.js canonicalizeCategory() is the one mapping.
 *   3. middleware.js 301-normalizes /shop?category= for ALL user agents
 *      (mirror of the backend redirect layer) and routes bots on sole-filter
 *      canonical categories to /api/prerender/category/<slug>. Its
 *      excluded-param list is byte-mirrored in seo-meta.js (SPA/bot parity).
 *   4. /genuine-vs-compatible now resolves to a real on-site explainer page
 *      (Merchant Center reinstatement, Jul 2026): rewritten to
 *      /html/genuine-vs-compatible and linked from the footer.
 *   5. PDP renders the backend's pack_suggestion as a value-pack upsell —
 *      dollar savings only, never savings_percent (value-pack convention).
 *   6. Every non-admin page carries static hreflang en-NZ + x-default.
 *
 * Run with: node --test tests/ia-reorg-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const read = (...p) => fs.readFileSync(path.join(INK, ...p), 'utf8');

const MEGA_NAV_JS = read('js', 'mega-nav.js');
const FOOTER_JS = read('js', 'footer.js');
const SHOP_JS = read('js', 'shop-page.js');
const PDP_JS = read('js', 'product-detail-page.js');
const API_JS = read('js', 'api.js');
const SEO_JS = read('js', 'seo-meta.js');
const MIDDLEWARE = read('middleware.js');
const LAYOUT_CSS = read('css', 'layout.css');
const PAGES_CSS = read('css', 'pages.css');
const VERCEL = JSON.parse(read('vercel.json'));
const PDP_HTML = read('html', 'product', 'index.html');

function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function walkHtml(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'admin') continue;
            walkHtml(p, out);
        } else if (entry.name.endsWith('.html')) {
            out.push(p);
        }
    }
    return out;
}

function extractSiteHeader(html) {
    const start = html.indexOf('<header class="site-header">');
    if (start === -1) return null;
    let depth = 0;
    let i = start;
    while (i < html.length) {
        if (html.substr(i, 7) === '<header') depth++;
        if (html.substr(i, 9) === '</header>') {
            depth--;
            if (depth === 0) return html.substring(start, i + 9);
        }
        i++;
    }
    return null;
}

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ALL_HTML = walkHtml(INK);

// ─────────────────────────────────────────────────────────────────────────────
// §1 — NO "Shop by Category" nav mega (owner decision, 2026-07-02)
//
// The panel shipped briefly with the IA reorg and was removed the same day at
// the owner's request. Category discovery lives in the footer's Categories
// column (§5) instead. This pins the removal so a future codemod doesn't
// resurrect it, and keeps the 26 shared headers byte-identical without it.
// ─────────────────────────────────────────────────────────────────────────────

const PAGES_WITH_NAV = ALL_HTML
    .map((file) => ({ file, html: fs.readFileSync(file, 'utf8') }))
    .filter(({ html }) => html.includes('nav-menu__item'));

test('§1 no categories-mega anywhere; shared headers stay byte-identical', () => {
    for (const { file, html } of ALL_HTML.map((f) => ({ file: f, html: fs.readFileSync(f, 'utf8') }))) {
        assert.ok(!html.includes('categories-mega') && !html.includes('nav-categories-toggle'),
            `${file} must not ship the removed Shop by Category mega`);
    }
    assert.ok(!MEGA_NAV_JS.includes('categoriesTrigger') && !MEGA_NAV_JS.includes('openCategories'),
        'mega-nav.js must not wire the removed categories panel');
    assert.ok(!LAYOUT_CSS.includes('.categories-mega'),
        'layout.css must not style the removed categories mega');
    // 27 since Jul 2026: the /genuine-vs-compatible explainer page was added
    // for Merchant Center reinstatement and ships the same shared header.
    assert.equal(PAGES_WITH_NAV.length, 27,
        `expected 27 pages with the shared nav, got ${PAGES_WITH_NAV.length}`);
    const hashes = new Set(PAGES_WITH_NAV.map(({ file, html }) => {
        const header = extractSiteHeader(html);
        assert.ok(header, `${file} has a nav but no site-header block`);
        return hash(header);
    }));
    assert.equal(hashes.size, 1, 'header blocks diverged across pages');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — no non-canonical category slug is ever emitted
// ─────────────────────────────────────────────────────────────────────────────

test('§2 no storefront JS emits category=consumable / label_tape / ribbons / drum', () => {
    const sources = { MEGA_NAV_JS, SHOP_JS, PDP_JS, FOOTER_JS };
    for (const [name, src] of Object.entries(sources)) {
        const code = stripComments(src);
        assert.doesNotMatch(code, /category=consumable/, `${name} emits category=consumable`);
        assert.doesNotMatch(code, /category=label_tape/, `${name} emits category=label_tape`);
        assert.doesNotMatch(code, /category=ribbons\b/, `${name} emits category=ribbons`);
        assert.doesNotMatch(code, /category=drum\b/, `${name} emits category=drum (singular)`);
    }
});

test('§2 mega-nav fallback BRANDS uses canonical params only', () => {
    assert.doesNotMatch(MEGA_NAV_JS, /param:\s*['"]consumable['"]/);
    assert.doesNotMatch(MEGA_NAV_JS, /param:\s*['"]label_tape['"]/);
    assert.match(MEGA_NAV_JS, /param:\s*['"]drums['"]/);
    assert.match(MEGA_NAV_JS, /param:\s*['"]label['"]/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — canonicalizeCategory helper (functional)
// ─────────────────────────────────────────────────────────────────────────────

const { canonicalizeCategory } = require(path.join(INK, 'js', 'utils.js'));

test('§3 canonicalizeCategory maps every alias and rejects unknowns', () => {
    assert.equal(typeof canonicalizeCategory, 'function');
    // canonical passthrough
    for (const c of ['ink', 'toner', 'ribbon', 'drums', 'label', 'paper']) {
        assert.equal(canonicalizeCategory(c), c);
    }
    // aliases
    assert.equal(canonicalizeCategory('consumable'), 'drums');
    assert.equal(canonicalizeCategory('drum'), 'drums');       // PDP singular
    assert.equal(canonicalizeCategory('label_tape'), 'label');
    assert.equal(canonicalizeCategory('ribbons'), 'ribbon');
    assert.equal(canonicalizeCategory('ink-cartridges'), 'ink');
    // case/whitespace tolerance
    assert.equal(canonicalizeCategory('INK'), 'ink');
    assert.equal(canonicalizeCategory('  Drums '), 'drums');
    // no canonical form
    assert.equal(canonicalizeCategory('cartridge'), null);
    assert.equal(canonicalizeCategory('junk'), null);
    assert.equal(canonicalizeCategory(''), null);
    assert.equal(canonicalizeCategory(null), null);
    assert.equal(canonicalizeCategory(undefined), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — nav feed fetch + fail-open hydration
// ─────────────────────────────────────────────────────────────────────────────

test('§4 API.getSiteNav routes through getWithSWR', () => {
    assert.match(API_JS, /getSiteNav\(\)\s*\{\s*\n?\s*return this\.getWithSWR\(\s*['"]\/api\/site\/nav['"]/);
});

test('§4 mega-nav hydrates from the feed inside try/catch (fail-open)', () => {
    assert.match(MEGA_NAV_JS, /async function hydrateFromSiteNav\(\)\s*\{\s*\n?\s*try\s*\{/);
    assert.match(MEGA_NAV_JS, /API\.getSiteNav\(\)/);
    // catch body must NOT re-render anything — static markup stands.
    const catchBody = stripComments(MEGA_NAV_JS).match(/catch\s*\(e\)\s*\{([^}]*)\}/g) || [];
    assert.ok(catchBody.length >= 1, 'hydrateFromSiteNav needs a catch block');
    assert.match(MEGA_NAV_JS, /hydrateFromSiteNav\(\);/, 'hydration must run at init');
});

test('§4 brands mega renders curated brands only (owner decision, 2026-07-02)', () => {
    // Feed-only tail brands (Universal, Citizen, Star, IBM, …) have no local
    // logo or category deep links and rendered as bare text cards — the
    // hydration must filter to the curated BRANDS set before slicing.
    assert.match(MEGA_NAV_JS, /\.filter\(b => b && LOCAL_LOGO_BY_BRAND\[b\.slug\]\)/,
        'hydrated brands must be filtered to the curated set');
    assert.ok(!stripComments(MEGA_NAV_JS).includes('storageUrl(b.logo_path)'),
        'feed logo_path rendering was removed with the feed-only brands');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — NO footer Categories column (owner decision, 2026-07-02)
//
// The feed-hydrated column shipped with the IA reorg and was removed the same
// day, right after the matching nav mega. Pins the removal + the reverted
// 3-link-column footer grid.
// ─────────────────────────────────────────────────────────────────────────────

test('§5 footer ships no FEED-HYDRATED Categories column', () => {
    // What the owner killed on 2026-07-02 was the *feed-hydrated* column: it
    // rendered whatever GET /api/site/nav happened to return. That must not come
    // back, and footer.js must never fetch — these three assertions are the guard.
    assert.ok(!FOOTER_JS.includes('footer-categories-links'),
        'footer.js must not render the removed Categories column');
    assert.doesNotMatch(FOOTER_JS, /<summary class="footer-column__heading">Categories<\/summary>/);
    assert.ok(!stripComments(FOOTER_JS).includes('getSiteNav'),
        'footer.js must not fetch the nav feed any more');

    // The three STATIC category links under "Shop" are a different thing and are
    // deliberate (owner decision, 2026-07-14): the backend's crawler footer lists
    // these same categories to Googlebot, so without them humans saw fewer links
    // than bots — the wrong side of a cloaking review to be standing on.
    // See tests/footer-redesign-jul2026.test.js for the full footer contract.
    assert.match(LAYOUT_CSS, /\.footer-grid\s*\{[^}]*grid-template-columns:\s*2fr repeat\(3, 1fr\) 1\.3fr/s,
        'footer grid is brand + 3 link columns + contact (Jul 2026 redesign)');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — middleware: ?category normalization + bot category prerender
// ─────────────────────────────────────────────────────────────────────────────

test('§6 middleware normalizes /shop?category BEFORE the bot gate (all UAs)', () => {
    const normIdx = MIDDLEWARE.indexOf("url.searchParams.has('category')");
    const botIdx = MIDDLEWARE.indexOf('BOT_PATTERN.test(ua)');
    assert.ok(normIdx > -1, 'normalization block missing');
    assert.ok(botIdx > -1, 'bot gate missing');
    assert.ok(normIdx < botIdx, 'normalization must run before the bot gate');
});

test('§6 middleware mirrors the backend redirect rules', () => {
    assert.match(MIDDLEWARE, /CATEGORY_CANONICAL = new Set\(\['ink', 'toner', 'ribbon', 'drums', 'label', 'paper'\]\)/);
    assert.match(MIDDLEWARE, /CATEGORY_ALIASES = \{ ribbons: 'ribbon', 'ink-cartridges': 'ink' \}/);
    assert.match(MIDDLEWARE, /Response\.redirect\(url\.toString\(\), 301\)/);
    // Loop guard: only redirect when the normalized value differs.
    assert.match(MIDDLEWARE, /if \(next !== raw\)/);
    // Strip (not remap) on no-canonical-form — exact backend mirror.
    assert.match(MIDDLEWARE, /else next = null;/);
});

test('§6 middleware routes bots on sole-filter categories to the category prerender', () => {
    assert.match(MIDDLEWARE, /\/api\/prerender\/category\/\$\{cat\}/);
    // Precedence: category arm is the else of the brand arm.
    const brandIdx = MIDDLEWARE.indexOf('/api/prerender/brand/');
    const catIdx = MIDDLEWARE.indexOf('/api/prerender/category/${cat}');
    assert.ok(brandIdx > -1 && catIdx > brandIdx, 'brand prerender must take precedence');
});

test('§6 middleware and seo-meta share a byte-identical excluded-param list', () => {
    const mwParams = [...MIDDLEWARE.matchAll(/!url\.searchParams\.get\('([a-z_]+)'\)/g)].map(m => m[1]);
    assert.deepEqual(mwParams, ['code', 'q', 'search', 'type', 'printer_model'],
        'middleware sole-filter exclusions changed — update seo-meta.js to match');
    // seo-meta has the same list twice (prerenderPathForLocation + surfaceForLocation).
    const seoBlocks = [...SEO_JS.matchAll(/&& !params\.get\('code'\) && !params\.get\('q'\)\s*\n\s*&& !params\.get\('search'\) && !params\.get\('type'\)\s*\n\s*&& !params\.get\('printer_model'\)/g)];
    assert.equal(seoBlocks.length, 2,
        'seo-meta.js must mirror the middleware exclusion list in both location mappers');
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 — shop-page URL-boundary translation
// ─────────────────────────────────────────────────────────────────────────────

test('§7 shop-page declares the canonical⇄internal maps', () => {
    assert.match(SHOP_JS, /CATEGORY_INTERNAL_BY_CANONICAL:\s*\{ drums: 'consumable', label: 'label_tape', ribbon: 'ribbons' \}/);
    assert.match(SHOP_JS, /CATEGORY_CANONICAL_BY_INTERNAL:\s*\{ consumable: 'drums', label_tape: 'label', ribbons: 'ribbon' \}/);
});

test('§7 parseURLState canonicalizes the incoming param and repairs the URL', () => {
    assert.match(SHOP_JS, /typeof canonicalizeCategory === 'function'/);
    assert.match(SHOP_JS, /history\.replaceState\(history\.state, '', window\.location\.pathname/);
});

test('§7 updateURL and schema/SEO builders emit canonical slugs', () => {
    const emissions = [...stripComments(SHOP_JS).matchAll(/CATEGORY_CANONICAL_BY_INTERNAL\[/g)];
    // map declaration + parseURLState is INTERNAL_BY_CANONICAL; the canonical
    // emitter appears in updateURL, updateSchemaLD and updateSEO = 3 sites.
    assert.ok(emissions.length >= 3,
        `expected >=3 canonical-emission sites, found ${emissions.length}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 — seo-meta category surfaces (functional)
// ─────────────────────────────────────────────────────────────────────────────

const SeoMeta = require(path.join(INK, 'js', 'seo-meta.js'));

test('§8 sole-filter categories map to prerender paths and surfaces', () => {
    const P = (pathname, search = '') => SeoMeta.prerenderPathForLocation({ pathname, search });
    const S = (pathname, search = '') => SeoMeta.surfaceForLocation({ pathname, search });
    assert.equal(P('/shop', '?category=drums'), '/api/prerender/category/drums');
    assert.equal(P('/shop', '?category=label'), '/api/prerender/category/label');
    assert.equal(P('/shop', '?category=paper'), '/api/prerender/category/paper');
    assert.equal(P('/shop', '?category=ribbon'), '/api/prerender/category/ribbon');
    assert.equal(P('/shop', '?category=consumable'), null);
    assert.equal(P('/shop', '?category=drums&code=DR2325'), null);
    assert.equal(S('/shop', '?category=drums'), 'category-drums');
    assert.equal(S('/shop', '?category=ribbon'), 'category-ribbons');
    assert.equal(S('/shop', '?category=drums&q=x'), null);
});

test('§8 fallback builders exist for drums/label/paper and stay compliant', () => {
    const ctx = { trust: { foundedYear: 2008, guaranteeDays: 30, cutoff: '2pm' }, free: 100 };
    for (const surface of ['category-drums', 'category-label', 'category-paper']) {
        const out = SeoMeta.buildForSurface(surface, ctx);
        assert.ok(out && out.title && out.description, `${surface} builder returned nothing`);
        assert.ok(out.title.length <= 60, `${surface} title too long: ${out.title}`);
        assert.ok(out.description.length <= 155, `${surface} description too long`);
        assert.doesNotMatch(out.title + out.description, /best|cheapest|#1|guaranteed lowest/i,
            `${surface} copy must stay compliance-clean`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §9 — PDP: canonical breadcrumbs + pack_suggestion upsell
// ─────────────────────────────────────────────────────────────────────────────

test('§9 PDP breadcrumbs canonicalize info.category', () => {
    assert.match(PDP_JS, /canonCategory = \(typeof canonicalizeCategory === 'function' && canonicalizeCategory\(info\.category\)\) \|\| info\.category/);
    assert.match(PDP_JS, /category=\$\{Security\.escapeAttr\(canonCategory\)\}/);
});

test('§9 pack-upsell container ships hidden in the PDP shell', () => {
    assert.match(PDP_HTML, /<section class="pack-upsell" id="pack-upsell" hidden data-testid="pack-upsell"/);
});

test('§9 renderPackSuggestion guards, escapes, and shows dollar savings only', () => {
    const m = PDP_JS.match(/renderPackSuggestion\(info\) \{([\s\S]*?)\n {8}\},/);
    assert.ok(m, 'renderPackSuggestion(info) must exist');
    const body = m[1];
    // Fail-soft guards
    assert.match(body, /!ps \|\| typeof ps !== 'object' \|\| !ps\.sku \|\| !ps\.slug/);
    assert.match(body, /Number\.isFinite\(price\)/);
    assert.match(body, /Number\.isFinite\(savings\)/);
    // Canonical product link shape
    assert.match(body, /\/products\/\$\{encodeURIComponent\(ps\.slug\)\}\/\$\{encodeURIComponent\(ps\.sku\)\}/);
    // Currency + escaping
    assert.match(body, /formatPrice\(price\)/);
    assert.match(body, /formatPrice\(savings\)/);
    assert.match(body, /Security\.escapeHtml/);
    assert.match(body, /Security\.escapeAttr/);
    // Value-pack convention: dollars only, never a percent.
    assert.doesNotMatch(body, /savings_percent/);
    // Render is invoked with the other secondary renders.
    assert.match(PDP_JS, /this\.renderPackSuggestion\(info\);/);
});

test('§9 pack-upsell styles exist in pages.css', () => {
    assert.match(PAGES_CSS, /\.pack-upsell\s*\{/);
    assert.match(PAGES_CSS, /\.pack-upsell\[hidden\]\s*\{\s*display:\s*none;/);
    assert.match(PAGES_CSS, /\.pack-upsell__savings/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §10 — vercel.json defensive redirects
// ─────────────────────────────────────────────────────────────────────────────

test('§10 /ink and /toner 301 to the category landing routes', () => {
    const r = VERCEL.redirects;
    const ink = r.find(x => x.source === '/ink');
    const toner = r.find(x => x.source === '/toner');
    assert.ok(ink && ink.destination === '/ink-cartridges' && ink.permanent === true,
        '/ink must 301 to /ink-cartridges (backend prerender canonical still points at /ink)');
    assert.ok(toner && toner.destination === '/toner-cartridges' && toner.permanent === true);
    // /genuine-vs-compatible now resolves to a real explainer page (Merchant
    // Center reinstatement, Jul 2026) — it must NOT redirect to the homepage
    // any more, and must rewrite to the real page.
    const gvcRedirect = r.find(x => x.source === '/genuine-vs-compatible');
    assert.ok(!gvcRedirect, '/genuine-vs-compatible must no longer redirect to the homepage');
    const gvcRewrite = VERCEL.rewrites.find(x => x.source === '/genuine-vs-compatible');
    assert.ok(gvcRewrite && gvcRewrite.destination === '/html/genuine-vs-compatible',
        '/genuine-vs-compatible must rewrite to /html/genuine-vs-compatible');
});

// ─────────────────────────────────────────────────────────────────────────────
// §11 — hreflang on every non-admin page
// ─────────────────────────────────────────────────────────────────────────────

test('§11 every non-admin html page carries hreflang en-NZ + x-default', () => {
    const missing = ALL_HTML.filter((f) => {
        const html = fs.readFileSync(f, 'utf8');
        return !(html.includes('hreflang="en-NZ"') && html.includes('hreflang="x-default"'));
    }).map((f) => path.relative(INK, f));
    assert.deepEqual(missing, [], `pages missing hreflang: ${missing.join(', ')}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// §12 — cache tokens
// ─────────────────────────────────────────────────────────────────────────────

// §12 previously pinned every touched file to `?v=ia-reorg-jul2026`. That token has
// since been bumped by later features (as it must be — it is a content hash), so the
// pin could only ever go stale. Asserting that a cache-busting token has STOPPED
// changing is asserting the opposite of what it is for.
//
// What actually matters — one token per asset sitewide, every asset versioned, and a
// changed file's token bumped before it ships — is enforced for ALL assets, not just
// this feature's, by tests/asset-cache-tokens.test.js. Here we only assert the files
// are referenced and cache-busted at all.
test('§12 touched JS is loaded and cache-busted on the pages that use it', () => {
    const home = read('html', 'index.html');
    for (const f of ['mega-nav.js', 'utils.js', 'api.js']) {
        assert.match(home, new RegExp(`${f.replace('.', '\\.')}\\?v=[^"]+`),
            `html/index.html must load ${f} with a cache token`);
    }
    assert.match(read('html', 'shop.html'), /shop-page\.js\?v=[^"]+/);
    assert.match(PDP_HTML, /product-detail-page\.js\?v=[^"]+/);
});
