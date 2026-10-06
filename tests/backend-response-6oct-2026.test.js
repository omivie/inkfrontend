/**
 * BACKEND RESPONSE TO THE FE REPLIES — 6 Oct 2026 (backend-docs/inbox/
 * fe-replies-oct2026-backend-response.md)
 * =====================================================================
 *
 * Most of what that response changed is pinned next to the code it touches:
 *   BF-094 printer names     round2 / four-replies / conversion-fixes / turnaround
 *   BF-095 business apply    business-apply-sep2026 §4 (409 codes, per-account copy)
 *   BF-096 printer search    turnaround-fixes §2, compat-wrong-family §3
 *   BF-099 consent withdraw  ad-clicks-to-orders §4
 *   BF-100 wallet region     checkout-funnel item 2
 *   BF-101 service row       fe-master-checklist-oct2026 §5
 *
 * This file holds what has no older home:
 *   §1 GA4 + Ads are OFF on /admin (owner, via the backend) — executed against
 *      gtag.js with a POSITIVE CONTROL on a storefront path, plus the admin HTML.
 *   §2 PrinterName's contract break is LOUD: a row without display_name prints
 *      the raw name and warns ONCE; a row with it never warns.
 *   §3 One request per printer lookup (BF-096), in BOTH places that used to fan out.
 *
 * Run: node --test tests/backend-response-6oct-2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripComments } = require('./helpers/strip-comments');

const INK = path.join(__dirname, '..', 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(INK, rel), 'utf8');
const GTAG_SRC = read('js/gtag.js');

/** Run gtag.js at a path; return the gtag('config', id) ids it pushed. */
function configsAt(pathname) {
    const store = new Map();
    const ctx = {
        console,
        location: { pathname },
        localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); } },
        document: {
            createElement: () => ({}),
            head: { appendChild() {} },
            documentElement: { appendChild() {} },
        },
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(GTAG_SRC, ctx, { filename: 'gtag.js' });
    return Array.from(ctx.dataLayer || [])
        .map((args) => Array.from(args))
        .filter((a) => a[0] === 'config')
        .map((a) => a[1]);
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 GA4 + Ads off on /admin
// ─────────────────────────────────────────────────────────────────────────────

test('§1 POSITIVE CONTROL — a storefront page configures GA4 AND the Ads tag', () => {
    for (const p of ['/', '/products/x/SKU1', '/cart', '/business']) {
        assert.deepEqual(configsAt(p).sort(), ['AW-18032498762', 'G-SDQELG0FGD'], p);
    }
});

test('§1 an /admin path configures NOTHING (no GA4 pageview, no Ads "All visitors")', () => {
    for (const p of ['/admin', '/admin/', '/admin/index.html', '/admin/orders', '/admin/products']) {
        assert.deepEqual(configsAt(p), [], p);
    }
});

test('§1 no admin HTML page loads the Google tag, gtag.js, or the consent banner it needs', () => {
    const dir = path.join(INK, 'html', 'admin');
    const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
    assert.ok(pages.length >= 5, `expected the admin pages, found ${pages.length}`);
    for (const f of pages) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
        assert.doesNotMatch(src, /googletagmanager\.com/, `${f}: Google tag bundle`);
        assert.doesNotMatch(src, /\/js\/gtag\.js/, `${f}: gtag.js`);
        // A banner with no gtag gates nothing (consent-mode-sep2026 §1 orphan rule).
        assert.doesNotMatch(src, /\/js\/consent-banner\.js/, `${f}: consent banner with nothing to consent to`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 PrinterName contract break is loud
// ─────────────────────────────────────────────────────────────────────────────

/** utils.js in a VM on "localhost", so DebugLog is live; console.warn is captured. */
function loadPrinterName() {
    const warns = [];
    const ctx = {
        console: { ...console, warn: (...a) => warns.push(a.join(' ')) },
        window: { location: { hostname: 'localhost', pathname: '/', search: '' }, addEventListener() {} },
        document: { addEventListener() {}, readyState: 'complete', querySelector: () => null, querySelectorAll: () => [] },
        localStorage: { getItem: () => null, setItem() {} },
        module: { exports: {} },
    };
    vm.createContext(ctx);
    vm.runInContext(read('js/utils.js'), ctx, { filename: 'utils.js' });
    return { P: ctx.module.exports.PrinterName, warns, restore() {} };
}

test('§2 display_name present ⇒ printed verbatim, NO warning', () => {
    const { P, warns, restore } = loadPrinterName();
    try {
        assert.equal(P.of({ display_name: ' Brother MFC-J5930DW ', full_name: 'Brother MFC J5930DW' }), 'Brother MFC-J5930DW');
        assert.deepEqual(warns, []);
    } finally { restore(); }
});

test('§2 display_name absent ⇒ RAW name (never re-cased) and ONE warning naming BF-094', () => {
    const { P, warns, restore } = loadPrinterName();
    try {
        assert.equal(P.of({ full_name: 'Brother MFC J5930DW' }), 'Brother MFC J5930DW');
        assert.equal(P.of({ full_name: 'HP COLOR LASERJET 5500' }), 'HP COLOR LASERJET 5500');
        assert.equal(warns.length, 1, 'warn once per page, not once per row');
        assert.match(warns[0], /display_name/);
        assert.match(warns[0], /BF-094/);
    } finally { restore(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 one request per printer lookup (BF-096)
// ─────────────────────────────────────────────────────────────────────────────

test('§3 the printer-model resolver asks /api/printers/search ONCE (was five spellings)', () => {
    const code = stripComments(read('js/shop-page.js'));
    const start = code.indexOf('async resolvePrinterModelSlug(');
    const end = code.indexOf('async loadPrinterModelProducts(', start);
    assert.ok(start > 0 && end > start, 'resolver located');
    const body = code.slice(start, end);
    assert.equal((body.match(/API\.searchPrinters\(/g) || []).length, 1);
    assert.match(body, /API\.searchPrinters\(printerModel, brandSlug \|\| null\)/);
    assert.doesNotMatch(body, /spellings|Promise\.allSettled/);
});
