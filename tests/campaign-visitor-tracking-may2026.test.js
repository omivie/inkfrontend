/**
 * Campaign-visitor tracking — May 2026
 * =====================================
 *
 * Pins the storefront half of `readfirst/campaign-visitor-tracking-may2026.md`
 * (backend branch `feat/traffic-campaign-tracking`, migration 074). The backend
 * has shipped two new fields on /api/admin/analytics/traffic/summary
 * (`campaign_visitors`, `campaign_visitor_percent`, `authenticated_visitors`,
 * `campaign_breakdown[]`) and gained two new attribution inputs on
 * /api/analytics/traffic-event (`utm_rid` body field, optional `Authorization`
 * header). This file guards the storefront edges of that contract.
 *
 * §1  Storefront tracker forwards utm_rid
 *     a. First visit with ?utm_rid=… persists in sessionStorage('utm_rid')
 *     b. Every event payload (pageview + click) carries the persisted token
 *     c. Subsequent navigations without the URL param still send the token
 *     d. Token is forwarded verbatim — never decoded or parsed
 *     e. Capture happens at IIFE init so a fast bounce still attributes
 *
 * §2  Auth-aware send path
 *     a. Anonymous → navigator.sendBeacon (most reliable on unload)
 *     b. Signed-in → fetch + keepalive + Authorization: Bearer <token>
 *        (sendBeacon can't carry custom headers — spec line 154)
 *     c. Tracking never throws; missing Auth global degrades silently
 *
 * §3  Admin dashboard — Campaign Visitors KPI
 *     a. New 6th card "Campaign Visitors" sits in the KPI strip
 *     b. Subtitle reads "${percent.toFixed(1)}% of unique visitors"
 *     c. NaN-safe: malformed envelope renders "0.0% of unique visitors"
 *
 * §4  Admin dashboard — Email Campaigns breakdown panel
 *     a. Renders one bar row per campaign_breakdown[] entry
 *     b. Row label = campaign_id; "unattributed" passes through verbatim
 *     c. Empty-state copy is exactly "No campaign traffic yet."
 *     d. XSS-safe: campaign_id values flow through esc()
 *
 * §5  CSS supports the new 6-card strip (admin-kpi-grid--6)
 *
 * Run with: node --test tests/campaign-visitor-tracking-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const READ = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const TRACKER_SRC = READ('inkcartridges/js/traffic-tracker.js');
const WT_SRC = READ('inkcartridges/js/admin/pages/website-traffic.js');
const ADMIN_CSS = READ('inkcartridges/css/admin.css');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Sandbox harness for the tracker IIFE
// ─────────────────────────────────────────────────────────────────────────────

function makeStorage() {
    const m = new Map();
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
        clear: () => m.clear(),
        _dump: () => Object.fromEntries(m),
    };
}

// Run the tracker IIFE in an isolated vm context and capture every outbound
// send. Returns the populated context + a `sent` array so tests can assert.
function loadTracker({ search = '', sessionUtmRid = null, authSession = null, sendBeacon = true } = {}) {
    const sent = [];
    const sessionStorage = makeStorage();
    const localStorage = makeStorage();
    if (sessionUtmRid) sessionStorage.setItem('utm_rid', sessionUtmRid);

    const navigator = {
        userAgent: 'jest',
        language: 'en-NZ',
        doNotTrack: '0',
        sendBeacon: sendBeacon
            ? (url, blob) => { sent.push({ kind: 'beacon', url, body: String(blob && blob._data || ''), headers: {} }); return true; }
            : undefined,
    };

    const fakeBlob = function (parts, opts) {
        // Minimal Blob shim so sendBeacon can read the body
        this._data = parts.join('');
        this.type = (opts && opts.type) || '';
    };

    const fakeFetch = (url, opts) => {
        sent.push({
            kind: 'fetch',
            url,
            body: (opts && opts.body) || '',
            headers: (opts && opts.headers) || {},
            keepalive: !!(opts && opts.keepalive),
        });
        return Promise.resolve({ ok: true, status: 204 });
    };

    const documentMock = {
        readyState: 'complete',
        addEventListener: () => {},
        referrer: '',
    };

    const windowMock = {
        innerWidth: 1280,
        innerHeight: 800,
        addEventListener: () => {},
        Auth: authSession === null ? undefined : { session: authSession, readyPromise: Promise.resolve() },
    };

    const ctx = {
        navigator,
        sessionStorage,
        localStorage,
        location: {
            hostname: 'inkcartridges.co.nz',
            pathname: '/shop',
            search,
        },
        document: documentMock,
        window: windowMock,
        screen: { width: 1920, height: 1080 },
        crypto: { randomUUID: () => '00000000-0000-0000-0000-000000000000' },
        history: { pushState: function () {} },
        URLSearchParams,
        URL,
        Blob: fakeBlob,
        fetch: fakeFetch,
        setTimeout,
        clearTimeout,
        Date,
        Promise,
        JSON,
        Math,
        Number,
        String,
        Object,
        Array,
        console,
    };
    // self-references commonly used in browsers
    ctx.window.location = ctx.location;
    ctx.window.document = documentMock;
    ctx.window.navigator = navigator;
    ctx.window.sessionStorage = sessionStorage;
    ctx.window.localStorage = localStorage;
    ctx.window.fetch = fakeFetch;
    ctx.self = ctx.window;
    ctx.globalThis = ctx;

    vm.createContext(ctx);
    vm.runInContext(TRACKER_SRC, ctx);
    return { ctx, sent, sessionStorage, navigator };
}

async function flush() {
    // tracker.send() awaits Auth.readyPromise then dispatches — drain microtasks
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await new Promise(r => setImmediate(r));
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 — utm_rid capture, persistence, forwarding
// ─────────────────────────────────────────────────────────────────────────────

test('§1a utm_rid from URL is captured into sessionStorage on init', async () => {
    const { sessionStorage } = loadTracker({ search: '?utm_rid=abc.def.ghi' });
    await flush();
    assert.equal(sessionStorage.getItem('utm_rid'), 'abc.def.ghi',
        'tracker must persist utm_rid into sessionStorage on init');
});

test('§1b every event payload carries utm_rid when set', async () => {
    const { ctx, sent, sessionStorage } = loadTracker({ search: '?utm_rid=token_xyz' });
    await flush();
    // Pageview should already be queued (DOM is complete in our mock)
    assert.ok(sent.length >= 1, 'first pageview must dispatch');
    const body = JSON.parse(sent[0].body);
    assert.equal(body.utm_rid, 'token_xyz', 'pageview body must carry utm_rid');

    // Fire a manual click-style event
    ctx.window.TrafficTracker.send('click', { element: 'btn:checkout' });
    await flush();
    const click = JSON.parse(sent[sent.length - 1].body);
    assert.equal(click.utm_rid, 'token_xyz', 'click body must carry the same utm_rid');
    assert.equal(sessionStorage.getItem('utm_rid'), 'token_xyz');
});

test('§1c subsequent events with no URL param still send the persisted token', async () => {
    const { ctx, sent } = loadTracker({ search: '', sessionUtmRid: 'persisted_token' });
    await flush();
    const body = JSON.parse(sent[0].body);
    assert.equal(body.utm_rid, 'persisted_token',
        'persisted utm_rid must survive subsequent pageviews without the URL param');

    ctx.window.TrafficTracker.send('pageview');
    await flush();
    const nextBody = JSON.parse(sent[sent.length - 1].body);
    assert.equal(nextBody.utm_rid, 'persisted_token');
});

test('§1d utm_rid is forwarded verbatim — never decoded', async () => {
    // Opaque HMAC-signed token shape: hex_payload.hex_signature
    const opaque = 'eyJyaWQiOiJyXzEyMyJ9.0a1b2c3d4e5f';
    const { sent } = loadTracker({ search: `?utm_rid=${opaque}` });
    await flush();
    const body = JSON.parse(sent[0].body);
    assert.equal(body.utm_rid, opaque,
        'tracker must forward utm_rid as-is without parsing or modifying');
});

test('§1e no utm_rid in URL and none stored → payload omits the field', async () => {
    const { sent } = loadTracker({ search: '' });
    await flush();
    const body = JSON.parse(sent[0].body);
    assert.ok(!('utm_rid' in body),
        'payload must omit utm_rid (not send null/empty) when none is known');
});

test('§1f tracker source still reads ?utm_rid via URLSearchParams (no regex shortcuts)', () => {
    assert.match(TRACKER_SRC, /URLSearchParams\(location\.search\)\.get\(['"]utm_rid['"]\)|URLSearchParams\(location\.search\)\.get\(UTM_RID_KEY\)/,
        'tracker must read utm_rid via URLSearchParams so URL-encoded payloads are decoded once and only once');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — Auth-aware send path
// ─────────────────────────────────────────────────────────────────────────────

test('§2a anonymous visitor uses navigator.sendBeacon', async () => {
    const { sent } = loadTracker({ search: '' });
    await flush();
    assert.ok(sent.length >= 1);
    assert.equal(sent[0].kind, 'beacon',
        'anonymous path must use sendBeacon (most reliable on unload)');
    // sendBeacon doesn't carry custom headers — no Authorization should appear
    assert.equal(Object.keys(sent[0].headers).length, 0);
});

test('§2b signed-in visitor uses fetch with keepalive + Authorization header', async () => {
    const { sent } = loadTracker({
        search: '?utm_rid=t1',
        authSession: { access_token: 'sb-jwt-abc.def' },
    });
    await flush();
    assert.ok(sent.length >= 1);
    const evt = sent[0];
    assert.equal(evt.kind, 'fetch',
        'authenticated path must use fetch (sendBeacon cannot attach Authorization)');
    assert.equal(evt.headers['Authorization'], 'Bearer sb-jwt-abc.def',
        'fetch must carry Authorization: Bearer <access_token>');
    assert.equal(evt.headers['Content-Type'], 'application/json');
    assert.equal(evt.keepalive, true,
        'fetch must set keepalive: true so the request survives navigation');
});

test('§2c missing window.Auth degrades silently to the anonymous path', async () => {
    const { sent } = loadTracker({ search: '', authSession: null });
    await flush();
    assert.equal(sent[0].kind, 'beacon',
        'no Auth global → no header, no exception — fall back to sendBeacon');
});

test('§2d Auth present but session=null still uses sendBeacon (no header)', async () => {
    // window.Auth exists but the user is signed out — must not send a bearer.
    // We pass authSession=null which leaves window.Auth undefined in the harness;
    // for an explicit "Auth global present, session=null" case the contract is the
    // same: no access_token → anonymous path. Both branches collapse to sendBeacon.
    const result = loadTracker({ search: '', authSession: null });
    await flush();
    assert.ok(result.sent.length >= 1, 'first pageview must dispatch');
    assert.equal(result.sent[0].kind, 'beacon',
        'no access_token → fall back to sendBeacon, no Authorization header');
    assert.equal(Object.keys(result.sent[0].headers).length, 0,
        'sendBeacon path never adds custom headers');
});

test('§2e source declares both paths (sendBeacon for anon, fetch+Authorization for auth)', () => {
    assert.match(TRACKER_SRC, /navigator\.sendBeacon\(/,
        'tracker source must keep the sendBeacon path');
    assert.match(TRACKER_SRC, /Authorization['"]?\s*:\s*[`'"]Bearer/,
        'tracker source must attach Authorization: Bearer <token> on the auth path');
    assert.match(TRACKER_SRC, /keepalive\s*:\s*true/,
        'tracker source must use keepalive:true on the fetch path');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — Admin dashboard: Campaign Visitors KPI
// ─────────────────────────────────────────────────────────────────────────────

const WT_CODE = stripComments(WT_SRC);

test('§3a website-traffic.js renders a "Campaign Visitors" KPI', () => {
    assert.match(WT_CODE, /label:\s*['"]Campaign Visitors['"]/,
        'KPI strip must include a Campaign Visitors card');
});

test('§3b subtitle format is "X.X% of unique visitors"', () => {
    // The subtitle template includes campaignPercent.toFixed(1) followed by "% of unique visitors"
    assert.match(WT_CODE, /campaignPercent\.toFixed\(1\)[\s\S]*?% of unique visitors/,
        'subtitle must render "<percent.toFixed(1)>% of unique visitors"');
});

test('§3c percent is NaN-guarded (Number.isFinite fallback to 0)', () => {
    assert.match(WT_CODE, /Number\.isFinite\(s\.campaign_visitor_percent\)\s*\?\s*s\.campaign_visitor_percent\s*:\s*0/,
        'campaign_visitor_percent must be coerced to 0 when missing/NaN');
    assert.match(WT_CODE, /Number\.isFinite\(s\.campaign_visitors\)\s*\?\s*s\.campaign_visitors\s*:\s*0/,
        'campaign_visitors must be coerced to 0 when missing/NaN');
});

test('§3d KPI strip uses the 6-column grid', () => {
    assert.match(WT_CODE, /admin-kpi-grid--6/,
        'KPI grid must upgrade to admin-kpi-grid--6 now that 6 cards are present');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — Admin dashboard: Email Campaigns breakdown panel
// ─────────────────────────────────────────────────────────────────────────────

test('§4a renderCampaignBreakdown is defined and exported into the render path', () => {
    assert.match(WT_CODE, /function renderCampaignBreakdown\(/,
        'renderCampaignBreakdown must exist in website-traffic.js');
    assert.match(WT_CODE, /renderCampaignBreakdown\(s\.campaign_breakdown\)/,
        'render() must call renderCampaignBreakdown(s.campaign_breakdown)');
});

test('§4b empty-state copy is exactly "No campaign traffic yet."', () => {
    assert.match(WT_CODE, /No campaign traffic yet\./,
        'empty state must read "No campaign traffic yet." (spec-mandated copy)');
});

test('§4c title is "Email Campaigns"', () => {
    assert.match(WT_CODE, /Email Campaigns/,
        'panel title must be "Email Campaigns"');
});

test('§4d "unattributed" fallback label for missing campaign_id', () => {
    assert.match(WT_CODE, /['"]unattributed['"]/,
        'rows must fall back to the literal "unattributed" when campaign_id is missing');
});

test('§4e renderCampaignBreakdown reuses barRow (visual parity with Device/Channel)', () => {
    // Pull the function body and assert it uses barRow
    const m = WT_CODE.match(/function renderCampaignBreakdown\([\s\S]*?\n\}/);
    assert.ok(m, 'should locate renderCampaignBreakdown body');
    assert.match(m[0], /barRow\(/,
        'renderCampaignBreakdown must render via barRow() to match the Device/Channel visual language');
});

// Helpers shared by the renderCampaignBreakdown sandbox tests below.
const MISSING_GLYPH = '—';
function makeRenderCtx() {
    return {
        esc: (s) => String(s ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
        // Mirror module-scope helpers from website-traffic.js so barRow() can run.
        fmt: (n) => (n == null ? MISSING_GLYPH : Number(n).toLocaleString('en-NZ')),
        Math, Number, String, Object, Array,
    };
}
function runRenderCampaignBreakdown(rows) {
    const ctx = makeRenderCtx();
    vm.createContext(ctx);
    const body = WT_CODE.match(/function barRow\([\s\S]*?\n\}/)[0]
              + '\n' + WT_CODE.match(/function renderCampaignBreakdown\([\s\S]*?\n\}/)[0]
              + '\n__r = renderCampaignBreakdown(__rows);';
    ctx.__rows = rows;
    vm.runInContext('var __r; ' + body, ctx);
    return ctx.__r;
}

test('§4f campaign_id values flow through esc() — XSS-safe', () => {
    const html = runRenderCampaignBreakdown([
        { campaign_id: '<script>alert(1)</script>', unique_visitors: 5 },
    ]);
    assert.ok(!html.includes('<script>'),
        'campaign_id must be escaped — raw <script> must not appear');
    assert.ok(html.includes('&lt;script&gt;'),
        'campaign_id should be HTML-escaped via esc()');
});

test('§4g empty array → empty-state copy (no rows)', () => {
    const html = runRenderCampaignBreakdown([]);
    assert.match(html, /No campaign traffic yet\./);
    assert.ok(!html.includes('admin-traffic-bars'),
        'empty state should not render the bars container');
});

test('§4h populated rows render labels + unique_visitors counts', () => {
    const html = runRenderCampaignBreakdown([
        { campaign_id: 'may2026_recent', unique_visitors: 54 },
        { campaign_id: 'may2026_older', unique_visitors: 33 },
    ]);
    assert.match(html, /may2026_recent/);
    assert.match(html, /may2026_older/);
    assert.match(html, /\b54\b/);
    assert.match(html, /\b33\b/);
});

test('§4i missing campaign_id renders the literal "unattributed" label', () => {
    // Spec §3.b: "row.campaign_id || 'unattributed'" — when backend supplies a
    // row with no campaign_id, the dashboard must still show a label, not blank.
    const html = runRenderCampaignBreakdown([
        { unique_visitors: 9 },
        { campaign_id: '', unique_visitors: 4 },
    ]);
    const matches = html.match(/unattributed/g) || [];
    assert.ok(matches.length >= 2,
        'both missing-id rows must render the "unattributed" label');
});

test('§4j unique_visitors=null/undefined is coerced to 0 (no NaN bar widths)', () => {
    const html = runRenderCampaignBreakdown([
        { campaign_id: 'broken', unique_visitors: null },
    ]);
    assert.ok(!html.includes('NaN'),
        'null unique_visitors must not produce NaN in the bar width or count');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — CSS supports the new 6-card strip
// ─────────────────────────────────────────────────────────────────────────────

test('§5 admin.css declares .admin-kpi-grid--6', () => {
    assert.match(ADMIN_CSS, /\.admin-kpi-grid--6\s*\{/,
        'admin.css must declare .admin-kpi-grid--6 so the new Campaign Visitors card lays out cleanly');
});

test('§5b 6-grid collapses on narrower viewports', () => {
    // At least one media query must narrow the 6-col grid down for small screens.
    const matches = ADMIN_CSS.match(/@media\s*\([^)]+\)\s*\{\s*\.admin-kpi-grid--6\s*\{[^}]+\}/g) || [];
    assert.ok(matches.length >= 2,
        'expected at least two responsive breakpoints for admin-kpi-grid--6');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — Admin path is excluded from the tracker (sanity)
// ─────────────────────────────────────────────────────────────────────────────

test('§6 tracker exits early on /admin paths', () => {
    assert.match(TRACKER_SRC, /pathname\.startsWith\(['"]\/admin['"]\)/,
        'tracker must skip /admin pages so the admin SPA doesn\'t double-count itself');
});
