/**
 * Shop canonical URL contract — May 2026
 * =======================================
 *
 * Pins the canonical-URL injection in shop-page.js. Every drilldown level
 * MUST emit a `<link id="canonical-url" rel="canonical" href="…">` that
 * points at a stable, lowercase, query-normalised /shop URL. Without this,
 * Google sees `/shop?brand=Canon` and `/shop?brand=canon` as separate URLs
 * (cf. Search Console's "Duplicate, Google chose different canonical").
 *
 * Backend co-canonical context (2026-05-11): the backend dev reversed their
 * 301 on `/brand/:slug` expecting FE to pre-render branded landing pages.
 * Our Vercel still 301s `/brand/:slug → /shop?brand=:slug`, so the
 * authoritative URL for brand pages is the SPA. This canonical injection
 * cements that contract on the storefront side.
 *
 * Run with: node --test tests/shop-canonical-url.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SHOP_JS = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'shop-page.js'), 'utf8');
const SHOP_HTML = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'html', 'shop.html'), 'utf8');
const VERCEL_JSON = JSON.parse(fs.readFileSync(path.join(ROOT, 'inkcartridges', 'vercel.json'), 'utf8'));

// ─────────────────────────────────────────────────────────────────────────────
// HTML scaffolding — the <link id="canonical-url"> must exist so JS can set it
// ─────────────────────────────────────────────────────────────────────────────

test('shop.html declares <link id="canonical-url" rel="canonical">', () => {
    assert.match(SHOP_HTML, /<link\s+id="canonical-url"\s+rel="canonical"\s+href="[^"]+"/,
        'shop.html must declare the canonical <link> so shop-page.js can rewrite href on level change');
});

test('shop.html canonical default points at https://www.inkcartridges.co.nz/shop', () => {
    const m = SHOP_HTML.match(/<link\s+id="canonical-url"\s+rel="canonical"\s+href="([^"]+)"/);
    assert.ok(m, 'canonical <link> must be present');
    assert.equal(m[1], 'https://www.inkcartridges.co.nz/shop',
        'default canonical href must be the bare /shop URL — query is rewritten by JS on drilldown');
});

// ─────────────────────────────────────────────────────────────────────────────
// JS — canonical href is rewritten on every state change
// ─────────────────────────────────────────────────────────────────────────────

test('shop-page.js writes canonical href via id="canonical-url"', () => {
    assert.match(SHOP_JS, /set\(\s*['"]canonical-url['"]\s*,\s*['"]href['"]\s*,\s*canonical\s*\)/,
        'shop-page.js must set canonical-url.href on every level change');
});

test('shop-page.js lowercases brand/category/printer_slug in canonical', () => {
    // The lc()-wrap is required so Google doesn't see /shop?brand=Canon and
    // /shop?brand=canon as separate URLs.
    assert.match(SHOP_JS, /const\s+lc\s*=\s*\(v\)\s*=>\s*\(v\s*==\s*null\s*\?\s*v\s*:\s*String\(v\)\.toLowerCase\(\)\)/,
        'shop-page.js must define an lc() lowercaser for canonical params');
    assert.match(SHOP_JS, /params\.set\(\s*['"]brand['"]\s*,\s*lc\(brand\)\s*\)/,
        'canonical brand param must be lowercased');
    assert.match(SHOP_JS, /params\.set\(\s*['"]category['"]\s*,\s*lc\(category\)\s*\)/,
        'canonical category param must be lowercased');
    assert.match(SHOP_JS, /params\.set\(\s*['"]printer_slug['"]\s*,\s*lc\(this\.state\.printer\)\s*\)/,
        'canonical printer_slug must be lowercased');
});

test('shop-page.js preserves code casing in canonical (PG-540, not pg-540)', () => {
    // Product codes are case-sensitive identifiers — backend treats `PG-540`
    // and `pg-540` as the same row, but canonical convention is uppercase.
    // The lc() function must NOT touch `code`.
    assert.match(SHOP_JS, /params\.set\(\s*['"]code['"]\s*,\s*code\s*\)/,
        'canonical code param must NOT be lowercased — product codes are mixed-case identifiers');
});

test('shop-page.js preserves user search query "q" verbatim in canonical', () => {
    // User-entered queries are content, not identifiers — preserving the
    // exact spelling lets /shop?q=ribbon and /shop?q=Ribbon be the same
    // canonical only when the user reaches the same page.
    assert.match(SHOP_JS, /params\.set\(\s*['"]q['"]\s*,\s*this\.state\.search\s*\)/,
        'canonical q param must preserve the user input verbatim');
});

test('shop-page.js canonical at brands level (no filters) is the bare /shop', () => {
    // The default branch of the switch — when no brand/category/code/printer/q
    // is set — must emit just /shop without any query string. Otherwise the
    // landing page competes with itself across query orderings.
    assert.match(SHOP_JS, /canonical\s*=\s*`\$\{BASE\}\/shop`/,
        'brands-level (default) canonical must be the bare BASE/shop URL');
});

// ─────────────────────────────────────────────────────────────────────────────
// Vercel — /brand/:slug still 301s to /shop?brand=:slug
// ─────────────────────────────────────────────────────────────────────────────

test('vercel.json 301-redirects /brand/:slug → /shop?brand=:slug', () => {
    // This rule is load-bearing for the canonical contract: if Vercel ever
    // stops redirecting, the backend's now-disabled 301 (per 2026-05-11
    // backend dev note) would create a phantom /brand/:slug URL with no
    // canonical, splitting SEO equity. Pin the redirect.
    const redirects = VERCEL_JSON.redirects || [];
    const brandRedirect = redirects.find(r => r.source === '/brand/:slug');
    assert.ok(brandRedirect, 'vercel.json must declare a redirect from /brand/:slug');
    assert.equal(brandRedirect.destination, '/shop?brand=:slug',
        'redirect must target /shop?brand=:slug');
    assert.equal(brandRedirect.permanent, true,
        'redirect must be permanent (301) — Google needs to know /shop?brand= is canonical');
});

test('vercel.json 301-redirects plural /brands/:slug too', () => {
    const redirects = VERCEL_JSON.redirects || [];
    const plural = redirects.find(r => r.source === '/brands/:slug');
    assert.ok(plural, 'vercel.json must also redirect /brands/:slug (plural)');
    assert.equal(plural.destination, '/shop?brand=:slug');
    assert.equal(plural.permanent, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// canonical is updated for printer-products / search-results too
// ─────────────────────────────────────────────────────────────────────────────

test('shop-page.js builds canonical that includes printer_slug when state.printer is set', () => {
    // Pins the if(this.state.printer) params.set check — without this,
    // /shop?printer_slug=brother-mfc-j480dw would render but the canonical
    // would point at /shop (or a stale brand URL), causing it to be folded
    // into a higher-level canonical in Google's eyes.
    assert.match(SHOP_JS, /if\s*\(this\.state\.printer\)\s*params\.set\(\s*['"]printer_slug['"]\s*,\s*lc\(this\.state\.printer\)\s*\)/,
        'canonical builder must add printer_slug to canonical params when state.printer is set');
});
