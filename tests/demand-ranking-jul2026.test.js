/**
 * Admin Product Demand Ranking contract
 * =====================================
 *
 * Backend shipped GET /api/admin/analytics/demand-ranking (composite demand
 * score → "what to stock for same-day shipping"). This test locks the FE
 * surface built against it (spec: demand-ranking-spec.md):
 *
 *   1. api.js exposes getDemandRanking() that builds the endpoint's OWN query
 *      params (product_type/source/packs/window_days/limit) — NOT the shared
 *      date/brand analyticsQuery() convention (no date_from/brand_filter).
 *   2. app.js registers the owner-only page under the Catalog section; the client
 *      owner gate is derived from that ownerOnly flag via isOwnerOnlyRoute()
 *      (July 2026 IA overhaul — the separate ownerPages array was removed).
 *   3. pages/demand-ranking.js: default-exports init/destroy, uses the
 *      _renderSeq race guard, hides the global filter bar, renders the
 *      low-data "interest-weighted" banner, only emits raw>0 signal chips,
 *      maps stock_now/restock_soon/ok → red/amber/grey, renders the GENUINE
 *      empty-tile fallback, and never folds market_signal into the score bar.
 *
 * Run with: node --test tests/demand-ranking-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = path.join(ROOT, 'inkcartridges', 'js', 'admin');

const API_JS = fs.readFileSync(path.join(ADMIN, 'api.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(ADMIN, 'app.js'), 'utf8');
const PAGE_JS = fs.readFileSync(path.join(ADMIN, 'pages', 'demand-ranking.js'), 'utf8');

// Slice out the getDemandRanking method body for focused assertions.
function methodBody(src, name) {
    const start = src.indexOf(`${name}(`);
    assert.notEqual(start, -1, `${name} not found`);
    // Skip the parameter list first — default params like `opts = {}` contain
    // braces that would otherwise be mistaken for the body. Match the params'
    // parens, then brace-match from the first '{' after them.
    const paramOpen = src.indexOf('(', start);
    let pd = 0, afterParams = -1;
    for (let i = paramOpen; i < src.length; i++) {
        if (src[i] === '(') pd++;
        else if (src[i] === ')') { pd--; if (pd === 0) { afterParams = i + 1; break; } }
    }
    const open = src.indexOf('{', afterParams);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
    }
    throw new Error(`unbalanced braces for ${name}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. api.js — getDemandRanking with the endpoint's own params
// ─────────────────────────────────────────────────────────────────────────────

test('api.js defines async getDemandRanking()', () => {
    assert.ok(/getDemandRanking\s*\(/.test(API_JS), 'AdminAPI must expose getDemandRanking()');
});

test('getDemandRanking hits the demand-ranking endpoint via the fail-soft helper', () => {
    const body = methodBody(API_JS, 'getDemandRanking');
    assert.ok(body.includes('/api/admin/analytics/demand-ranking'),
        'must GET /api/admin/analytics/demand-ranking');
    assert.ok(body.includes('analyticsHttpGet'),
        'must go through analyticsHttpGet() (fail-soft, unwraps {ok,data}, returns null)');
});

test('getDemandRanking builds the endpoint-specific query params', () => {
    const body = methodBody(API_JS, 'getDemandRanking');
    for (const p of ['product_type', 'source', 'packs', 'window_days', 'limit']) {
        assert.ok(body.includes(`'${p}'`) || body.includes(`"${p}"`),
            `getDemandRanking must set the ${p} query param`);
    }
});

test('getDemandRanking does NOT route through the date/brand analyticsQuery convention', () => {
    const body = methodBody(API_JS, 'getDemandRanking');
    assert.ok(!body.includes('analyticsQuery'),
        'demand-ranking has its own params — it must not reuse analyticsQuery()');
    assert.ok(!/date_from|brand_filter/.test(body),
        'demand-ranking must not send date_from/brand_filter — those are the shared analytics convention');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. app.js — registration + owner gate
// ─────────────────────────────────────────────────────────────────────────────

test('app.js registers the demand-ranking nav item under Catalog, owner-only', () => {
    assert.ok(/key:\s*'demand-ranking'/.test(APP_JS),
        'NAV_ITEMS must include a demand-ranking entry');
    // July 2026 IA overhaul: demand-ranking (an inventory/demand signal) moved from
    // "Analytics" into the "Catalog" section (before "Data Operations").
    const catalogIdx = APP_JS.indexOf("section: 'Catalog'");
    const dataOpsIdx = APP_JS.indexOf("section: 'Data Operations'");
    const drIdx = APP_JS.indexOf("key: 'demand-ranking'");
    assert.ok(catalogIdx !== -1 && drIdx > catalogIdx && drIdx < dataOpsIdx,
        'demand-ranking nav item must live under the Catalog section');
    const navLine = APP_JS.slice(drIdx, drIdx + 120);
    assert.ok(navLine.includes('ownerOnly: true'),
        'demand-ranking nav item must be ownerOnly: true');
});

test('app.js owner-gates demand-ranking via the derived isOwnerOnlyRoute rule', () => {
    // July 2026: the client owner gate derives from NAV_ITEMS.ownerOnly (no separate
    // ownerPages array), so the ownerOnly flag above is what mirrors the server gate.
    assert.ok(/function isOwnerOnlyRoute\s*\(/.test(APP_JS),
        'isOwnerOnlyRoute() must exist as the single-source owner gate');
    assert.ok(/isOwnerOnlyRoute\(pageName\)\s*&&\s*!AdminAuth\.isOwner\(\)/.test(APP_JS),
        'navigate() must gate owner routes through isOwnerOnlyRoute()');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. pages/demand-ranking.js — behaviour contract
// ─────────────────────────────────────────────────────────────────────────────

test('page default-exports init() and destroy()', () => {
    assert.ok(/export default/.test(PAGE_JS), 'page must default-export a module object');
    assert.ok(/async init\s*\(/.test(PAGE_JS), 'page must expose async init()');
    assert.ok(/destroy\s*\(\)/.test(PAGE_JS), 'page must expose destroy()');
});

test('page uses the _renderSeq race guard', () => {
    assert.ok(PAGE_JS.includes('_renderSeq'), 'page must use a _renderSeq monotonic counter');
    assert.ok(/mySeq\s*!==\s*_renderSeq/.test(PAGE_JS),
        'render() must bail when a newer render superseded it (mySeq !== _renderSeq)');
    assert.ok(/_renderSeq\+\+|_renderSeq \+= 1/.test(PAGE_JS),
        'destroy() must bump _renderSeq to invalidate in-flight renders');
});

test('page hides the global filter bar and restores it on destroy', () => {
    assert.ok(PAGE_JS.includes('FilterState.showBar(false)'),
        'init() must hide the global date/brand filter bar (page has its own controls)');
    assert.ok(PAGE_JS.includes('FilterState.showBar(true)'),
        'destroy() must restore the global filter bar');
});

test('page renders the low-data interest-weighted banner', () => {
    assert.ok(/interest-weighted/i.test(PAGE_JS),
        'page must show the "interest-weighted / directional" low-data banner');
    assert.ok(/approximate/.test(PAGE_JS),
        'banner visibility must key off meta.approximate');
});

test('page only emits signal chips when raw > 0', () => {
    assert.ok(/Number\(raw\)\s*>\s*0/.test(PAGE_JS) || /raw\)\s*>\s*0/.test(PAGE_JS),
        'the Why column must only render sub-signal chips whose raw > 0');
});

test('page maps stocking_recommendation to red/amber/grey badges', () => {
    assert.ok(PAGE_JS.includes('stock_now') && PAGE_JS.includes('admin-badge--failed'),
        'stock_now must render the red (--failed) badge');
    assert.ok(PAGE_JS.includes('restock_soon') && PAGE_JS.includes('admin-badge--pending'),
        'restock_soon must render the amber (--pending) badge');
});

test('page renders the GENUINE empty-tile fallback for null image_url', () => {
    assert.ok(PAGE_JS.includes('admin-product-thumb--empty'),
        'products with no image_url (genuine rows) must fall back to the empty product tile');
});

test('market_signal is display-only — never folded into the demand score bar', () => {
    // The demand bar width must derive from demand_score, and the market cell
    // must be a separate render path that never touches demand_score.
    assert.ok(/demand_score/.test(PAGE_JS), 'demand bar must be driven by demand_score');
    const marketFn = PAGE_JS.slice(PAGE_JS.indexOf('function marketCell'), PAGE_JS.indexOf('function columns'));
    assert.ok(marketFn.length > 0 && !marketFn.includes('demand_score'),
        'marketCell() must not read demand_score — market_signal is external context, excluded from the score');
    assert.ok(/directional/i.test(PAGE_JS),
        'the market badge must label itself as directional NZ market context (honesty requirement)');
});

test('page reuses the shared DataTable and demand-score bar track', () => {
    assert.ok(PAGE_JS.includes("from '../components/table.js'") && PAGE_JS.includes('DataTable'),
        'page must reuse the shared DataTable component');
    assert.ok(PAGE_JS.includes('admin-traffic-row__bar'),
        'demand score bar must reuse the existing .admin-traffic-row__bar track');
});
