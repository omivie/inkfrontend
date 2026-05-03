/**
 * Value Pack + Product URL Contract (May 2026) — Storefront Pin
 * ==============================================================
 *
 * Pins the storefront-side contract documented in
 *   ~/Downloads/value-pack-and-product-url-contract.md
 *
 * Backend already shipped:
 *   - 9 genuine value packs backfilled with compare_price (2026-05-03)
 *   - GET /p/:sku → 301 to /products/<slug>/<SKU>
 *   - canonical_url field on every product list endpoint
 *   - GET /api/products/:sku/jsonld dedicated endpoint
 *   - GET /api/schema/site, /api/schema/collection, /api/schema/printer/:slug
 *   - free_shipping_remaining / qualifies_for_free_shipping / free_shipping_message
 *     on cart summary
 *   - POST /api/cart/coupon/preview for inline validation
 *
 * The storefront's job is:
 *   1. Add /p/* and /html/p/* Vercel rewrites pointing to Render (§2)
 *   2. Render savings line from original_price / discount_amount / discount_percent (§5.1)
 *   3. Use product.canonical_url for every <a href> (§5.2)
 *   4. Read free-shipping nudge from cart summary (§5.4)
 *   5. Debounce coupon preview at 300ms; handle RATE_LIMITED + EMAIL_NOT_VERIFIED (§5.5)
 *   6. Embed JSON-LD endpoints into <head> (§5.6)
 *   7. Render "Notify me" instead of disabled cart button when out-of-stock (§5.8)
 *   8. Map error.code → friendly UX (§6)
 *
 * These tests are static-analysis checks against the source files (since the
 * storefront is plain HTML/JS served statically — there is no server-side
 * handler to call). A regression here is a regression in the source itself.
 *
 * Run: `node --test tests/value-pack-and-product-url-contract.test.js`
 *      or   `node --test tests/`
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const VERCEL_JSON = path.join(INK, 'vercel.json');
const RENDER_BASE = 'https://ink-backend-zaeq.onrender.com';

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function readText(file) { return fs.readFileSync(file, 'utf8'); }

function collectFiles(dir, exts, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.vercel' || entry.name === '.git') continue;
            collectFiles(full, exts, acc);
        } else if (exts.has(path.extname(entry.name))) {
            acc.push(full);
        }
    }
    return acc;
}

// ─────────────────────────────────────────────────────────────────────────────
// (§2) Vercel rewrites — /p/:sku and /html/p/:sku → Render
// ─────────────────────────────────────────────────────────────────────────────

test('vercel.json — /p/:sku rewrites to Render backend, not the SPA', () => {
    const cfg = readJson(VERCEL_JSON);
    const rule = cfg.rewrites.find(r => r.source === '/p/:sku');
    assert.ok(rule, 'vercel.json must have a /p/:sku rewrite');
    assert.equal(
        rule.destination,
        `${RENDER_BASE}/p/:sku`,
        '/p/:sku must proxy to Render — Vercel can\'t compute the slug from the SKU at the edge',
    );
});

test('vercel.json — /html/p/:sku rewrites to Render backend (legacy share links)', () => {
    const cfg = readJson(VERCEL_JSON);
    const rule = cfg.rewrites.find(r => r.source === '/html/p/:sku');
    assert.ok(rule, 'vercel.json must have a /html/p/:sku rewrite');
    assert.equal(rule.destination, `${RENDER_BASE}/html/p/:sku`);
});

test('vercel.json — /p/:sku does NOT route to /html/product (the old broken behavior)', () => {
    const cfg = readJson(VERCEL_JSON);
    const offenders = cfg.rewrites.filter(r =>
        r.source === '/p/:sku' && /\/html\/product/.test(r.destination)
    );
    assert.equal(offenders.length, 0,
        '/p/:sku must not point to /html/product?sku=:sku — that is the bug B regression');
});

// ─────────────────────────────────────────────────────────────────────────────
// (§5.1) Savings rendering reads original_price / discount_amount / discount_percent
// ─────────────────────────────────────────────────────────────────────────────

test('js/products.js — PriceBlock reads original_price + discount_amount + discount_percent', () => {
    const src = readText(path.join(INK, 'js', 'products.js'));
    assert.ok(/original_price/.test(src),
        'products.js must read product.original_price');
    assert.ok(/discount_amount/.test(src),
        'products.js must read product.discount_amount');
    assert.ok(/discount_percent/.test(src),
        'products.js must read product.discount_percent');
});

test('js/shop-page.js — printer-card uses backend savings fields, not compare_price - price math', () => {
    const src = readText(path.join(INK, 'js', 'shop-page.js'));
    assert.ok(/original_price/.test(src), 'shop-page.js must read product.original_price');
    assert.ok(/discount_amount/.test(src), 'shop-page.js must read product.discount_amount');
    // The savings line must NOT compute compare_price - price as the primary path.
    // (A fallback ternary inside an originalPrice resolution is fine.)
    const lines = src.split('\n');
    const offenders = lines.filter((line, i) => {
        if (!/compare_price[^>]*-[^>]*price/.test(line)) return false;
        // Skip if line contains a safer pattern — fallback chain only.
        if (/originalPrice ?:/.test(line)) return false;
        return true;
    });
    assert.equal(offenders.length, 0,
        `shop-page.js must not compute compare_price - price; offenders:\n${offenders.join('\n')}`);
});

test('js/product-detail-page.js — PDP renders Was X — Save Y (Z%) line', () => {
    const src = readText(path.join(INK, 'js', 'product-detail-page.js'));
    assert.ok(/Was \$/.test(src) || /Was \${/.test(src),
        'PDP must render "Was $X" strikethrough');
    assert.ok(/Save \$/.test(src) || /Save \${/.test(src),
        'PDP must render "Save $Y (Z%)"');
    assert.ok(/info\.original_price/.test(src),
        'PDP must read info.original_price');
});

// ─────────────────────────────────────────────────────────────────────────────
// (§5.2) canonical_url contract
// ─────────────────────────────────────────────────────────────────────────────

test('js/products.js — card link prefers canonical_url over /p/${sku}', () => {
    const src = readText(path.join(INK, 'js', 'products.js'));
    assert.ok(/product\.canonical_url/.test(src),
        'products.js must read product.canonical_url for the card link');
});

test('js/shop-page.js — printer card link prefers canonical_url', () => {
    const src = readText(path.join(INK, 'js', 'shop-page.js'));
    assert.ok(/product\.canonical_url/.test(src),
        'shop-page.js must read product.canonical_url for the printer card link');
});

test('js/cart.js — line item + cross-sell links prefer canonical_url', () => {
    const src = readText(path.join(INK, 'js', 'cart.js'));
    const occurrences = (src.match(/canonical_url/g) || []).length;
    assert.ok(occurrences >= 2,
        `cart.js must reference canonical_url at least twice (line items + cross-sell), got ${occurrences}`);
});

test('js/favourites.js — favourite item link prefers canonical_url', () => {
    const src = readText(path.join(INK, 'js', 'favourites.js'));
    assert.ok(/canonical_url/.test(src),
        'favourites.js must read item.canonical_url');
});

test('js/landing.js — featured product card prefers canonical_url', () => {
    const src = readText(path.join(INK, 'js', 'landing.js'));
    assert.ok(/canonical_url/.test(src),
        'landing.js must read p.canonical_url');
});

test('js/search.js — productHref prefers canonical_url when present', () => {
    const src = readText(path.join(INK, 'js', 'search.js'));
    assert.ok(/canonical_url/.test(src),
        'search.js productHref must read p.canonical_url');
});

test('js/admin/pages/orders.js — order-line product link prefers canonical_url', () => {
    const src = readText(path.join(INK, 'js', 'admin', 'pages', 'orders.js'));
    assert.ok(/canonical_url/.test(src),
        'admin orders.js must read item.canonical_url');
});

// ─────────────────────────────────────────────────────────────────────────────
// (§5.4) Free-shipping nudge reads cart summary fields
// ─────────────────────────────────────────────────────────────────────────────

test('js/cart.js — free-shipping nudge reads server free_shipping_remaining + threshold', () => {
    const src = readText(path.join(INK, 'js', 'cart.js'));
    assert.ok(/free_shipping_remaining/.test(src),
        'cart.js must read summary.free_shipping_remaining');
    assert.ok(/qualifies_for_free_shipping/.test(src),
        'cart.js must read summary.qualifies_for_free_shipping');
    assert.ok(/free_shipping_threshold/.test(src),
        'cart.js must read summary.free_shipping_threshold');
});

// ─────────────────────────────────────────────────────────────────────────────
// (§5.5) Coupon preview UX
// ─────────────────────────────────────────────────────────────────────────────

test('js/checkout-page.js — coupon preview is debounced at 300ms (per spec §5.5)', () => {
    const src = readText(path.join(INK, 'js', 'checkout-page.js'));
    // The schedulePreview function should call setTimeout with 300.
    assert.ok(/setTimeout\(.*runPreview.*,\s*300\)/.test(src) || /setTimeout\([^,]+,\s*300\)/.test(src),
        'checkout-page.js coupon preview must be debounced at 300ms');
});

test('js/checkout-page.js — coupon preview surfaces RATE_LIMITED hint inline', () => {
    const src = readText(path.join(INK, 'js', 'checkout-page.js'));
    assert.ok(/RATE_LIMITED/.test(src),
        'checkout-page.js must handle RATE_LIMITED on coupon preview/apply');
    assert.ok(/Too many tries/.test(src) || /wait a minute/i.test(src),
        'checkout-page.js must show a friendly RATE_LIMITED message');
});

test('js/checkout-page.js — coupon preview surfaces EMAIL_NOT_VERIFIED hint', () => {
    const src = readText(path.join(INK, 'js', 'checkout-page.js'));
    assert.ok(/EMAIL_NOT_VERIFIED/.test(src),
        'checkout-page.js must handle EMAIL_NOT_VERIFIED on coupon preview');
});

test('js/checkout-page.js — preview reports new_total alongside discount_amount', () => {
    const src = readText(path.join(INK, 'js', 'checkout-page.js'));
    assert.ok(/data\.new_total|new_total/.test(src),
        'checkout-page.js coupon preview must use data.new_total per spec §5.5');
});

// ─────────────────────────────────────────────────────────────────────────────
// (§5.6) JSON-LD embedding via Schema module
// ─────────────────────────────────────────────────────────────────────────────

test('js/schema.js — exists and exposes injectSite/injectProduct/injectCollection/injectPrinter', () => {
    const file = path.join(INK, 'js', 'schema.js');
    assert.ok(fs.existsSync(file), 'js/schema.js must exist');
    const src = readText(file);
    assert.ok(/window\.Schema\s*=/.test(src), 'schema.js must export window.Schema');
    ['injectSite', 'injectProduct', 'injectCollection', 'injectPrinter'].forEach(name => {
        assert.ok(new RegExp(name).test(src),
            `schema.js must expose ${name}`);
    });
});

test('js/schema.js — sanitizes script-tag breakout (`</` → `<\\/`)', () => {
    const src = readText(path.join(INK, 'js', 'schema.js'));
    assert.ok(/<\\\//.test(src) || /\\\//.test(src),
        'schema.js must sanitize </ to <\\/ before injecting JSON-LD');
});

test('js/api.js — getSiteSchema + getProductJsonLd helpers exist', () => {
    const src = readText(path.join(INK, 'js', 'api.js'));
    assert.ok(/getSiteSchema/.test(src), 'api.js must expose getSiteSchema');
    assert.ok(/getProductJsonLd/.test(src), 'api.js must expose getProductJsonLd');
    assert.ok(/\/api\/schema\/site/.test(src), 'api.js must hit /api/schema/site');
    assert.ok(/\/api\/products\/\$\{[^}]+\}\/jsonld/.test(src) || /\/jsonld/.test(src),
        'api.js must hit /api/products/:sku/jsonld');
});

test('All non-admin storefront HTML pages include /js/schema.js', () => {
    const files = collectFiles(path.join(INK, 'html'), new Set(['.html']))
        .filter(f => !f.includes('/admin/'));
    assert.ok(files.length > 5, `expected >5 storefront HTML files; got ${files.length}`);
    const offenders = files.filter(f => !/\/js\/schema\.js/.test(readText(f)));
    assert.equal(offenders.length, 0,
        `Every non-admin storefront HTML page must load /js/schema.js. Offenders:\n${offenders.join('\n')}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// (§5.8) Out-of-stock waitlist UX on product cards
// ─────────────────────────────────────────────────────────────────────────────

test('js/products.js — renders Notify me button when product.in_stock === false', () => {
    const src = readText(path.join(INK, 'js', 'products.js'));
    assert.ok(/Notify me/.test(src), 'products.js card must render "Notify me"');
    assert.ok(/data-action="notify"/.test(src),
        'products.js card must mark notify buttons with data-action="notify"');
    assert.ok(/in_stock === false/.test(src),
        'products.js card must check product.in_stock === false');
});

test('js/shop-page.js — printer card renders Notify me when out of stock', () => {
    const src = readText(path.join(INK, 'js', 'shop-page.js'));
    assert.ok(/Notify me/.test(src), 'shop-page.js card must render "Notify me"');
    assert.ok(/data-action="notify"/.test(src),
        'shop-page.js card must mark notify buttons with data-action="notify"');
});

test('js/products.js — notify-mode buttons skip Add-to-Cart click handler', () => {
    const src = readText(path.join(INK, 'js', 'products.js'));
    // Both attachCardListeners and bindAddToCartEvents must guard on data-action="notify".
    const guards = src.match(/btn\.dataset\.action === ['"]notify['"]/g) || [];
    assert.ok(guards.length >= 2,
        `products.js must skip notify buttons in BOTH card click binders, got ${guards.length}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// (§6) Error contract — API.mapError covers the canonical codes
// ─────────────────────────────────────────────────────────────────────────────

test('js/api.js — mapError exposes friendly mappings for spec §6 codes', () => {
    const src = readText(path.join(INK, 'js', 'api.js'));
    assert.ok(/mapError\s*\(/.test(src), 'api.js must define mapError');
    const required = [
        'VALIDATION_FAILED',
        'NOT_FOUND',
        'UNAUTHORIZED',
        'FORBIDDEN',
        'RATE_LIMITED',
        'STOCK_INSUFFICIENT',
        'EMAIL_NOT_VERIFIED',
        'IDEMPOTENCY_CONFLICT',
    ];
    required.forEach(code => {
        assert.ok(new RegExp(`['"]${code}['"]`).test(src),
            `api.js mapError must handle ${code}`);
    });
});

test('js/api.js — request() routes 401/403/404 to structured { ok:false, code } responses', () => {
    const src = readText(path.join(INK, 'js', 'api.js'));
    assert.ok(/UNAUTHORIZED/.test(src), 'api.js must surface UNAUTHORIZED');
    assert.ok(/FORBIDDEN/.test(src), 'api.js must surface FORBIDDEN');
    assert.ok(/NOT_FOUND/.test(src), 'api.js must surface NOT_FOUND');
});

// ─────────────────────────────────────────────────────────────────────────────
// (§9) Common pitfalls — make sure we haven't reintroduced any
// ─────────────────────────────────────────────────────────────────────────────

test('No source file hardcodes /p/${sku} as the *primary* link (canonical_url first, /p/ as fallback only)', () => {
    const files = collectFiles(path.join(INK, 'js'), new Set(['.js']));
    const offenders = [];
    for (const f of files) {
        // Skip admin-internal files where short URLs are intentional.
        if (f.includes('/admin/')) continue;
        const txt = readText(f);
        // Only flag occurrences that are NOT preceded by a canonical_url check
        // within the same expression. A simple proxy: find any literal
        // `\`/p/${` and check the same line for `canonical_url`.
        const lines = txt.split('\n');
        lines.forEach((line, i) => {
            if (/`\/p\/\$\{/.test(line) || /'\/p\/'\s*\+/.test(line)) {
                if (!/canonical_url/.test(line)) {
                    // Multi-line ternary may have canonical_url on adjacent lines.
                    const ctx = lines.slice(Math.max(0, i - 6), i + 2).join('\n');
                    if (!/canonical_url/.test(ctx)) {
                        offenders.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
                    }
                }
            }
        });
    }
    assert.equal(offenders.length, 0,
        `Found /p/\${sku} hardcoded without canonical_url fallback context:\n${offenders.join('\n')}`);
});

test('vercel.json — connect-src CSP allows ink-backend (for /api/schema/site fetch)', () => {
    const cfg = readJson(VERCEL_JSON);
    const csp = cfg.headers.flatMap(h => h.headers.filter(x => x.key === 'Content-Security-Policy'));
    assert.ok(csp.length > 0, 'CSP header must be present');
    assert.ok(/connect-src[^;]*ink-backend-zaeq\.onrender\.com/.test(csp[0].value),
        'CSP connect-src must allow ink-backend-zaeq.onrender.com (for /api/schema/site etc.)');
});
