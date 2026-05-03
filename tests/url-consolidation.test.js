/**
 * URL Consolidation (May 2026) — Storefront Contract Pin
 * =======================================================
 *
 * Pins the storefront-side contract documented in
 *   ~/Downloads/url-consolidation-may2026.md
 *
 * Backend already shipped:
 *   - /brand/<slug>, /brands/<slug>, /brands/<slug>/hub  → 301 → /shop?brand=<slug>
 *   - Every /html/<path>                                 → 301 → /<path>
 *   - GET /api/landing-pages/index, GET /api/brand-hubs/* removed
 *   - VERCEL_DEPLOY_HOOK ping helper removed
 *
 * The storefront's job is:
 *   1. Stop building static brand pages (delete the SSG output and the script).
 *   2. Replace internal links to /brand/, /brands/, /html/ with their canonical form.
 *   3. Install Vercel-side defense-in-depth redirects (faster than a Render hop).
 *   4. Emit a clean lowercase canonical tag from /shop for ?brand=, ?category=,
 *      ?printer_slug= variants.
 *
 * These tests grep the static contents (vercel.json, source files, filesystem)
 * because the storefront is plain HTML/JS served statically — there is no
 * server-side handler to call. A regression here is a regression in the
 * config files themselves, which is exactly what we read.
 *
 * Run with: node --test tests/url-consolidation.test.js
 *           or `npm test` from inkcartridges/
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const VERCEL_JSON = path.join(INK, 'vercel.json');
const PACKAGE_JSON = path.join(INK, 'package.json');

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readText(file) {
    return fs.readFileSync(file, 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) Build pipeline cleanup
// ─────────────────────────────────────────────────────────────────────────────

test('package.json — build script does NOT call build-brand-pages.js', () => {
    const pkg = readJson(PACKAGE_JSON);
    assert.ok(pkg.scripts && pkg.scripts.build, 'build script must exist');
    assert.ok(
        !/build-brand-pages/.test(pkg.scripts.build),
        `build-brand-pages must be removed from build script. Got: "${pkg.scripts.build}"`,
    );
});

test('scripts/build-brand-pages.js — file is deleted', () => {
    const file = path.join(INK, 'scripts', 'build-brand-pages.js');
    assert.equal(
        fs.existsSync(file),
        false,
        'scripts/build-brand-pages.js must be deleted (the SSG it powered no longer exists)',
    );
});

test('scripts/README-deploy-hook.md — file is deleted', () => {
    const file = path.join(INK, 'scripts', 'README-deploy-hook.md');
    assert.equal(
        fs.existsSync(file),
        false,
        'scripts/README-deploy-hook.md must be deleted (the deploy hook flow is gone)',
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) Static SSG cleanup
// ─────────────────────────────────────────────────────────────────────────────

test('inkcartridges/brand/ — directory is deleted (Vercel serves static files first; lingering files would shadow redirects)', () => {
    const dir = path.join(INK, 'brand');
    assert.equal(fs.existsSync(dir), false,
        'inkcartridges/brand/ must be deleted — static files take precedence over redirects in Vercel');
});

test('css/brand-hub.css — file is deleted (only loaded by the deleted SSG pages)', () => {
    const file = path.join(INK, 'css', 'brand-hub.css');
    assert.equal(fs.existsSync(file), false);
});

test('css/pages.css — dead .brand-hub-* selectors removed', () => {
    const css = readText(path.join(INK, 'css', 'pages.css'));
    assert.ok(!/\.brand-hub-/.test(css),
        'css/pages.css must not contain dead .brand-hub-* selectors after the SSG removal');
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) Internal links — no stale /brand/<slug>, /brands/<slug>, or /html/* in source
// ─────────────────────────────────────────────────────────────────────────────

function collectFiles(dir, exts, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // Skip vendor / build / config-asset directories.
            if (entry.name === 'node_modules' || entry.name === '.vercel' || entry.name === '.git') continue;
            collectFiles(full, exts, acc);
        } else if (exts.has(path.extname(entry.name))) {
            acc.push(full);
        }
    }
    return acc;
}

test('mega-nav.js — brand cards link to /shop?brand=<slug>, not /brand/<slug>', () => {
    const src = readText(path.join(INK, 'js', 'mega-nav.js'));
    assert.ok(/\/shop\?brand=\$\{Security\.escapeAttr\(brand\.slug\)\}/.test(src),
        'mega-nav.js must emit /shop?brand=<slug> for brand cards');
    assert.ok(!/`\/brand\/\$\{/.test(src),
        'mega-nav.js must NOT emit /brand/<slug> URLs (the SSG pages are gone)');
});

test('source HTML/JS — no internal links to /brand/<slug>', () => {
    const files = [
        ...collectFiles(path.join(INK, 'html'), new Set(['.html'])),
        ...collectFiles(path.join(INK, 'js'),   new Set(['.js'])),
        path.join(INK, 'index.html'),
        path.join(INK, '404.html'),
    ];
    const offenders = [];
    for (const f of files) {
        const txt = readText(f);
        // Match /brand/<something> in href/src/string-template, but NOT /brands/
        // (which is intercepted by a separate redirect).
        const matches = txt.match(/["'`]\/brand\/[a-z0-9-]+/gi);
        if (matches) offenders.push({ file: path.relative(INK, f), matches });
    }
    assert.deepEqual(offenders, [],
        `Found stale /brand/<slug> internal links: ${JSON.stringify(offenders, null, 2)}`);
});

test('source HTML/JS — no /html/* internal links (link/href/src/window.location)', () => {
    const files = [
        ...collectFiles(path.join(INK, 'html'), new Set(['.html'])),
        ...collectFiles(path.join(INK, 'js'),   new Set(['.js'])),
        path.join(INK, 'index.html'),
        path.join(INK, '404.html'),
    ];
    // middleware.js is a route MATCHER (not a link emitter); it intentionally
    // matches /html/product as a back-compat fallback for direct scanner hits.
    // Scripts at scripts/ are dev tooling, not deployed pages — skip those too.
    const SKIP_SUBSTR = ['/middleware.js', '/scripts/'];
    const offenders = [];
    for (const f of files) {
        if (SKIP_SUBSTR.some((s) => f.includes(s))) continue;
        const txt = readText(f);
        // href/src attribute pointing at /html/, OR window.location-style strings.
        const matches = txt.match(/(href|src)=["']\/html\/|["'`]\/html\/[a-z0-9_-]/gi);
        if (matches) offenders.push({ file: path.relative(INK, f), matches });
    }
    assert.deepEqual(offenders, [],
        `Found stale /html/* internal links: ${JSON.stringify(offenders, null, 2)}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) vercel.json — defense-in-depth redirects
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_REDIRECTS = [
    { source: '/brand/:slug',         destination: '/shop?brand=:slug', permanent: true },
    { source: '/brands/:slug/hub',    destination: '/shop?brand=:slug', permanent: true },
    { source: '/brands/:slug',        destination: '/shop?brand=:slug', permanent: true },
    { source: '/html/:path*',         destination: '/:path*',           permanent: true },
];

test('vercel.json — all four canonical consolidation redirects present', () => {
    const cfg = readJson(VERCEL_JSON);
    for (const required of REQUIRED_REDIRECTS) {
        const found = cfg.redirects.find(
            (r) => r.source === required.source &&
                   r.destination === required.destination &&
                   r.permanent === required.permanent,
        );
        assert.ok(found, `Missing canonical redirect: ${JSON.stringify(required)}`);
    }
});

test('vercel.json — no per-page /html/<path> redirect rules (only the wildcard)', () => {
    const cfg = readJson(VERCEL_JSON);
    const stale = cfg.redirects.filter((r) =>
        r.source.startsWith('/html/') && r.source !== '/html/:path*',
    );
    assert.deepEqual(stale, [],
        `Per-page /html/<path> redirects must be replaced by the single /html/:path* wildcard. ` +
        `Found: ${JSON.stringify(stale, null, 2)}`);
});

test('vercel.json — no per-brand /brands/<path> redirect rules outside the three canonical ones', () => {
    const cfg = readJson(VERCEL_JSON);
    const allowed = new Set(['/brands/:slug/hub', '/brands/:slug']);
    const stale = cfg.redirects.filter((r) =>
        (r.source.startsWith('/brands/') || r.source === '/brands') && !allowed.has(r.source),
    );
    assert.deepEqual(stale, [],
        `Stale /brands/* redirects: ${JSON.stringify(stale, null, 2)}`);
});

test('vercel.json — /html/:path* wildcard is the ONLY /html/ redirect (proves "replace, don\'t append")', () => {
    const cfg = readJson(VERCEL_JSON);
    const htmlRules = cfg.redirects.filter((r) => r.source.startsWith('/html'));
    assert.equal(htmlRules.length, 1,
        `Expected exactly one /html/ redirect (the wildcard). Got ${htmlRules.length}: ` +
        JSON.stringify(htmlRules, null, 2));
});

test('vercel.json — no /api/landing-pages/* redirect rules (the backend endpoint is gone)', () => {
    const cfg = readJson(VERCEL_JSON);
    const stale = cfg.redirects.filter((r) => r.source.startsWith('/api/landing-pages'));
    assert.deepEqual(stale, []);
});

test('vercel.json — /product-by-name rewrites to backend (so /html/product-by-name 301 → /product-by-name → backend keeps working)', () => {
    const cfg = readJson(VERCEL_JSON);
    const rewrite = cfg.rewrites.find((r) => r.source === '/product-by-name');
    assert.ok(rewrite, '/product-by-name rewrite missing — without this, the /html/:path* wildcard would 301 ' +
        '/html/product-by-name → /product-by-name and 404, breaking the backend-served route');
    assert.ok(/ink-backend.*\/html\/product-by-name/.test(rewrite.destination),
        'rewrite must target the backend /html/product-by-name route (the backend keeps that URL per spec)');
});

test('vercel.json — admin noindex header is on /admin/* (not the legacy /html/admin/*)', () => {
    const cfg = readJson(VERCEL_JSON);
    const noindexRule = cfg.headers.find((h) =>
        Array.isArray(h.headers) &&
        h.headers.some((kv) => kv.key === 'X-Robots-Tag' && /noindex/.test(kv.value)),
    );
    assert.ok(noindexRule, 'admin noindex header rule must exist');
    assert.equal(noindexRule.source, '/admin/(.*)',
        'admin noindex must be on /admin/(.*) since /html/admin/* now 301s away before headers apply');
});

test('vercel.json — admin route still rewrites to /html/admin (the on-disk location is unchanged)', () => {
    const cfg = readJson(VERCEL_JSON);
    const rewrite = cfg.rewrites.find((r) => r.source === '/admin/:path*');
    assert.ok(rewrite, '/admin/:path* rewrite must remain so /admin/foo serves /html/admin/foo from disk');
    assert.equal(rewrite.destination, '/html/admin/:path*');
});

// ─────────────────────────────────────────────────────────────────────────────
// (5) Canonical tag emission on /shop
// ─────────────────────────────────────────────────────────────────────────────
//
// updateSEO() writes the <link rel="canonical"> on shop.html. Per the spec:
// canonical must be lowercase for ?brand=, ?category=, and ?printer_slug=
// permutations; ?printer_slug must be present when the page is in
// printer-products mode.

function makeShopPageEnv() {
    const navigations = [];
    const metaWrites = {};
    const sandbox = {
        console,
        navigations,
        metaWrites,
        window: {},
        history: { pushState() {} },
        document: {
            title: '',
            head: { appendChild() {} },
            addEventListener() {},
            createElement() {
                return { setAttribute() {}, addEventListener() {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } };
            },
            getElementById(id) {
                return new Proxy({ id }, {
                    set(target, prop, value) {
                        metaWrites[id] = metaWrites[id] || {};
                        metaWrites[id][prop] = value;
                        target[prop] = value;
                        return true;
                    },
                    get(target, prop) {
                        if (prop === 'textContent') return target.textContent;
                        return target[prop];
                    },
                });
            },
            querySelector() { return null; },
            querySelectorAll() { return []; },
        },
        localStorage: {
            getItem() { return null; },
            setItem() {},
            removeItem() {},
        },
        location: {
            _href: 'http://localhost/shop',
            get href() { return this._href; },
            set href(v) { navigations.push(v); this._href = v; },
            pathname: '/shop',
            search: '',
        },
        Intl,
        URL,
        URLSearchParams,
        encodeURIComponent,
        decodeURIComponent,
        setTimeout,
        clearTimeout,
        JSON,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    return sandbox;
}

function loadShopPageController() {
    // shop-page.js depends on a few globals. We only need the controller's
    // updateSEO() to be reachable, so stub the bare minimum and read the
    // source via a sandbox.
    const env = makeShopPageEnv();
    const ctx = vm.createContext(env);
    const src = fs.readFileSync(path.join(INK, 'js', 'shop-page.js'), 'utf8');

    // Stub the API/Filters/Cart/Auth/Search/Security globals the file expects.
    vm.runInContext(`
        var API = { getShopData: () => ({}), getRibbons: () => null };
        var Filters = { applyFilters: (x) => x, sortProducts: (x) => x, getActiveFilters: () => ({}) };
        var Cart = { add() {}, isInCart: () => false };
        var Auth = { isLoggedIn: () => false };
        var Search = {};
        var Security = { escapeHtml: String, escapeAttr: String, sanitizeURL: String };
        var ProductColors = {};
        var Products = {};
        var Favourites = { isFavourite: () => false, toggle() {} };
        var Config = {};
        var formatPrice = (n) => '$' + n;
        var fetchAllProducts = async () => [];
        var buildPrinterUrl = () => null;
    `, ctx);
    // shop-page.js declares `const DrilldownNav = { ... }` at script scope.
    // `const` does not bind onto globalThis inside a vm context, so append a
    // line that re-exposes it. This is the only behavioral coupling.
    vm.runInContext(src + '\nglobalThis.DrilldownNav = DrilldownNav;', ctx, { filename: 'shop-page.js' });
    return env;
}

test('shop-page.js — updateSEO emits canonical with lowercase brand', () => {
    const env = loadShopPageController();
    const SP = env.DrilldownNav;
    assert.ok(SP, 'DrilldownNav controller must be exposed for testing');
    SP.state = { brand: 'Canon', category: null, code: null, printer: null, search: null, level: 'categories' };
    SP.brandInfo = { canon: { name: 'Canon' }, Canon: { name: 'Canon' } };
    SP.updateSEO();
    const canonical = env.metaWrites['canonical-url']?.href;
    assert.ok(canonical, 'canonical href must be set');
    assert.ok(/[?&]brand=canon(&|$)/.test(canonical),
        `brand must be lowercased in canonical. Got: ${canonical}`);
    assert.ok(!/[?&]brand=Canon/.test(canonical),
        `mixed-case brand must not appear in canonical. Got: ${canonical}`);
});

test('shop-page.js — updateSEO emits canonical with lowercase category', () => {
    const env = loadShopPageController();
    const SP = env.DrilldownNav;
    SP.state = { brand: 'hp', category: 'INK', code: null, printer: null, search: null, level: 'codes' };
    SP.brandInfo = { hp: { name: 'HP' } };
    SP.updateSEO();
    const canonical = env.metaWrites['canonical-url']?.href;
    assert.ok(/[?&]category=ink(&|$)/.test(canonical),
        `category must be lowercased in canonical. Got: ${canonical}`);
});

test('shop-page.js — updateSEO includes printer_slug in canonical when set (was missing pre-consolidation)', () => {
    const env = loadShopPageController();
    const SP = env.DrilldownNav;
    SP.state = {
        brand: null, category: null, code: null,
        printer: 'canon-laser-shot-lbp5200',
        search: null,
        level: 'printer-products',
    };
    SP.brandInfo = {};
    SP.updateSEO();
    const canonical = env.metaWrites['canonical-url']?.href;
    assert.ok(/[?&]printer_slug=canon-laser-shot-lbp5200(&|$)/.test(canonical),
        `printer_slug must appear in canonical for printer-products pages. Got: ${canonical}`);
});

test('shop-page.js — updateSEO emits canonical with lowercase printer_slug', () => {
    const env = loadShopPageController();
    const SP = env.DrilldownNav;
    SP.state = {
        brand: null, category: null, code: null,
        printer: 'CANON-LASER-SHOT-LBP5200',  // unusual but legal capitalization in URL
        search: null,
        level: 'printer-products',
    };
    SP.brandInfo = {};
    SP.updateSEO();
    const canonical = env.metaWrites['canonical-url']?.href;
    assert.ok(/[?&]printer_slug=canon-laser-shot-lbp5200(&|$)/.test(canonical),
        `printer_slug must be lowercased. Got: ${canonical}`);
});

test('shop-page.js — updateSEO does NOT include user search query in canonical lowercasing (q preserves user input)', () => {
    const env = loadShopPageController();
    const SP = env.DrilldownNav;
    SP.state = {
        brand: 'canon', category: null, code: null, printer: null,
        search: 'PG-540 XL',
        level: 'search-results',
    };
    SP.brandInfo = { canon: { name: 'Canon' } };
    SP.updateSEO();
    const canonical = env.metaWrites['canonical-url']?.href;
    // URLSearchParams encodes spaces as +; verify the case is preserved.
    assert.ok(/q=PG-540(\+|%20)XL/.test(canonical),
        `q should preserve case (it is user input, not a slug). Got: ${canonical}`);
});

test('shop-page.js — updateSEO uses canonical https://www.inkcartridges.co.nz origin', () => {
    const env = loadShopPageController();
    const SP = env.DrilldownNav;
    SP.state = { brand: 'canon', category: null, code: null, printer: null, search: null, level: 'categories' };
    SP.brandInfo = { canon: { name: 'Canon' } };
    SP.updateSEO();
    const canonical = env.metaWrites['canonical-url']?.href;
    assert.ok(canonical.startsWith('https://www.inkcartridges.co.nz/shop'),
        `canonical must use the production origin. Got: ${canonical}`);
});
