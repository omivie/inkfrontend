/**
 * Conversion funnel card (Aug 2026)
 * =================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `GET /api/admin/analytics/conversion-funnel` used to compute the top of the
 * funnel as `(distinct cart_viewed sessions × 10) || 1000` — an invented
 * multiplier with a hardcoded fallback — and derived every rate on the page from
 * it. Migration 155 replaced that with a real aggregate over `traffic_events`.
 * No admin page had ever rendered it (the only conversion card in dashboard.js
 * is deliberately commented out, because conversion-by-source returns >100%).
 *
 * WHAT THE LIVE ENDPOINT ACTUALLY RETURNS (measured 2026-08-31, super_admin)
 * -------------------------------------------------------------------------
 *   funnel: visitors 994 → added_to_cart 2 → started_checkout 78 →
 *           completed_purchase 64
 *   drop_off: { cart_to_checkout: -3800, checkout_to_purchase: 17.9 }
 *   overall_conversion_rate: 6.44
 *   meta: { source: "traffic_events … + cart_analytics_events + orders",
 *           window_days: 30, product_viewers: 191, sessions: 1397 }
 *
 * THREE THINGS THAT WOULD HAVE GONE WRONG
 * ---------------------------------------
 * 1. **-3800%.** A funnel is monotonic by construction — you cannot start more
 *    checkouts than you had carts. `added_to_cart: 2` under
 *    `started_checkout: 78` is not customer behaviour, it is the broken
 *    `add_to_cart` emitter (handoff §1.3, fixed in this same change). Rendering
 *    the backend's own -3800% beside four confident numbers would launder a
 *    wiring bug into a business insight.
 * 2. **fmtPct.** The dashboard's existing percent helper multiplies anything
 *    `<= 1.5` by 100, on the assumption it was handed a fraction. This endpoint
 *    sends 6.44 meaning 6.44% — so a genuine 1.2% conversion rate would have
 *    rendered as 120%. The funnel gets its own formatter.
 * 3. **window_days is a DECOY.** `?window_days=7`, `=90`, `=999` and an explicit
 *    `date_from`/`date_to` all return the byte-identical 30-day payload. A card
 *    labelled with the dashboard's date range would be lying every time the
 *    operator changed it (ERR-151; and label from the ECHO, ERR-145/147).
 *
 * Run: node --test tests/conversion-funnel-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const DASH = fs.readFileSync(path.join(INK, 'js', 'admin', 'pages', 'dashboard.js'), 'utf8');
const ADMIN_API = fs.readFileSync(path.join(INK, 'js', 'admin', 'api.js'), 'utf8');
const CSS = fs.readFileSync(path.join(INK, 'css', 'admin.css'), 'utf8');

/** Pull a top-level `function name(...)` out of the source and build it here. */
function loadFn(name, deps = {}) {
    const start = DASH.indexOf(`\nfunction ${name}(`);
    assert.notEqual(start, -1, `function ${name} not found`);
    const open = DASH.indexOf('{', start);
    let depth = 0, i = open;
    for (; i < DASH.length; i++) {
        if (DASH[i] === '{') depth++;
        else if (DASH[i] === '}') { depth--; if (depth === 0) break; }
    }
    const sig = DASH.slice(start + 1, open).trim();
    const args = sig.slice(sig.indexOf('(') + 1, sig.lastIndexOf(')'));
    const body = DASH.slice(open + 1, i);
    const names = Object.keys(deps);
    return new Function(...names, `return function (${args}) {${body}};`)(...names.map((n) => deps[n]));
}

const MISSING = '—';
const numOrNull = (v) => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const FUNNEL_STAGE_LABELS = {
    visitors: 'Visitors',
    product_viewers: 'Viewed a product',
    added_to_cart: 'Added to cart',
    started_checkout: 'Started checkout',
    completed_purchase: 'Ordered',
};

const funnelPct = loadFn('funnelPct', { numOrNull });
const funnelStages = loadFn('funnelStages', { numOrNull, MISSING, FUNNEL_STAGE_LABELS });
const renderFunnelCard = loadFn('renderFunnelCard', {
    numOrNull, MISSING, esc, FUNNEL_STAGE_LABELS,
    funnelStages, funnelPct,
});

/** The exact live payload, as measured. */
const LIVE = {
    funnel: [
        { stage: 'visitors', count: 994, rate: 100 },
        { stage: 'added_to_cart', count: 2, rate: 0.2012072434607646 },
        { stage: 'started_checkout', count: 78, rate: 7.847082494969819 },
        { stage: 'completed_purchase', count: 64, rate: 6.438631790744467 },
    ],
    drop_off: { cart_to_checkout: -3800, checkout_to_purchase: 17.9 },
    overall_conversion_rate: 6.44,
    meta: {
        source: 'traffic_events (pageviews, bots excluded) + cart_analytics_events + orders',
        window_days: 30, product_viewers: 191, sessions: 1397,
    },
};

/** The same funnel once add_to_cart is emitting again. */
const HEALTHY = {
    funnel: [
        { stage: 'visitors', count: 994, rate: 100 },
        { stage: 'added_to_cart', count: 210, rate: 21.1 },
        { stage: 'started_checkout', count: 78, rate: 7.85 },
        { stage: 'completed_purchase', count: 64, rate: 6.44 },
    ],
    overall_conversion_rate: 6.44,
    meta: { source: 'traffic_events', window_days: 30 },
};

// ─────────────────────────────────────────────────────────────────────────
// §1  The percent unit is pinned
// ─────────────────────────────────────────────────────────────────────────

test('§1 the endpoint sends a PERCENT, and the formatter treats it as one', () => {
    assert.equal(funnelPct(6.44), '6.44%');
    assert.equal(funnelPct(21.1), '21.1%');
    assert.equal(funnelPct(100), '100.0%');
});

test('§1 a genuine low rate is NOT multiplied by 100 (the fmtPct trap)', () => {
    // dashboard.js fmtPct does `if (Math.abs(n) <= 1.5) n *= 100`, which would
    // render a real 1.2% conversion rate as 120%.
    assert.equal(funnelPct(1.2), '1.20%');
    assert.equal(funnelPct(0.2012072434607646), '0.20%');
});

test('§1 null is null — never "0%" and never "NaN%"', () => {
    assert.equal(funnelPct(null), null);
    assert.equal(funnelPct(undefined), null);
    assert.equal(funnelPct('nonsense'), null);
    assert.equal(funnelPct(0), '0.00%', 'a real zero is still a measurement and must print');
});

// ─────────────────────────────────────────────────────────────────────────
// §2  Monotonicity — the -3800% guard
// ─────────────────────────────────────────────────────────────────────────

test('§2 the live payload flags added_to_cart — the EARLIER half of the bad pair', () => {
    // The fault is the stage that is too LOW, not the one that is too high:
    // `added_to_cart: 2` beneath `started_checkout: 78` means add-to-cart is
    // under-counting, not that 78 checkouts are imaginary.
    const stages = funnelStages(LIVE);
    const byStage = Object.fromEntries(stages.map((s) => [s.stage, s]));
    assert.equal(byStage.visitors.underReporting, false);
    assert.equal(byStage.added_to_cart.underReporting, true);
    assert.equal(byStage.added_to_cart.exceededBy.stage, 'started_checkout');
    assert.equal(byStage.started_checkout.underReporting, false,
        'comparing to the IMMEDIATE predecessor localises the fault to one pair — a running ' +
        'maximum would condemn every stage downstream of the first bad one');
    assert.equal(byStage.completed_purchase.underReporting, false, '64 orders after 78 checkouts is fine');
});

test('§2 a healthy funnel flags nothing (positive control)', () => {
    // Without this, a guard that flagged everything would pass the test above.
    assert.deepEqual(funnelStages(HEALTHY).map((s) => s.underReporting), [false, false, false, false]);
});

test('§2 an unknown count cannot be exceeded — absence is not a bound', () => {
    const stages = funnelStages({ funnel: [
        { stage: 'visitors', count: null },
        { stage: 'added_to_cart', count: 5 },
    ] });
    assert.equal(stages[0].underReporting, false);
    assert.equal(stages[1].underReporting, false);
});

test('§2 the under-counting stage keeps its COUNT but loses its RATE', () => {
    const html = renderFunnelCard(LIVE);
    assert.ok(html.includes('Added to cart'), 'the stage is still shown, not hidden');
    assert.ok(html.includes('>2<'), 'the count is what the table holds and is still reported');
    assert.ok(!html.includes('0.20%'),
        'a percentage of a number we know to be under-counted is not a measurement');
    assert.ok(!html.includes('-3800'), "the backend's own drop_off is never printed");
    assert.ok(/admin-conv-funnel__row--broken/.test(html));
});

test('§2 the overall rate SURVIVES a broken stage — it does not route through one', () => {
    // visitors → orders is computed from two sound numbers. Withholding it too
    // would throw away a good measurement to punish a neighbouring bad one.
    const html = renderFunnelCard(LIVE);
    assert.ok(html.includes('Visitor → order'));
    assert.ok(html.includes('<strong>6.44%</strong>'));
});

test('§2 a healthy funnel draws no callout — it retires itself', () => {
    const html = renderFunnelCard(HEALTHY);
    assert.ok(html.includes('<strong>6.44%</strong>'));
    assert.ok(!/admin-conv-funnel__row--broken/.test(html));
    assert.ok(!/admin-conv-funnel__broken/.test(html), 'measured, not hardcoded');
});

test('§2 the callout names the pair, the direction and the cause', () => {
    const html = renderFunnelCard(LIVE);
    assert.ok(/admin-conv-funnel__broken/.test(html));
    assert.ok(/Added to cart<\/strong> \(2\) sits below/.test(html), 'names the under-counting stage');
    assert.ok(/Started checkout<\/strong> \(78\)/.test(html), 'and what it sits below');
    assert.ok(html.includes('a funnel cannot widen'), 'states why that is impossible');
    assert.ok(html.includes('add_to_cart'), 'names the cause so nobody re-diagnoses it');
});

// ─────────────────────────────────────────────────────────────────────────
// §3  Absence is not zero
// ─────────────────────────────────────────────────────────────────────────

test('§3 overall_conversion_rate: null renders — , not 0%', () => {
    const html = renderFunnelCard({
        funnel: [{ stage: 'visitors', count: 0, rate: null }],
        overall_conversion_rate: null,
        meta: { window_days: 30 },
    });
    assert.ok(html.includes(`<strong>${MISSING}</strong>`));
    assert.ok(!/0\.0+%/.test(html), '"we measured nothing" is not 0% (ERR-063/068/073/075/076/127)');
});

test('§3 meta.data_gap is surfaced loudly, naming migration 155', () => {
    const html = renderFunnelCard({ funnel: [], meta: { data_gap: true, window_days: 30 } });
    assert.ok(/admin-conv-funnel__gap/.test(html));
    assert.ok(/155/.test(html));
    assert.ok(!/<ul class="admin-conv-funnel">/.test(html), 'no rows are drawn when nothing was computed');
});

test('§3 a failed fetch says so rather than rendering an empty funnel', () => {
    const html = renderFunnelCard(null);
    assert.ok(/admin-conv-funnel__empty/.test(html));
    assert.ok(html.includes('could not be loaded'));
});

test('§3 a null count renders — rather than a zero-height bar', () => {
    const html = renderFunnelCard({
        funnel: [{ stage: 'visitors', count: 10, rate: 100 }, { stage: 'added_to_cart', count: null, rate: null }],
        overall_conversion_rate: null,
        meta: { window_days: 30 },
    });
    assert.ok(html.includes(`<span class="admin-conv-funnel__count">${MISSING}</span>`));
});

// ─────────────────────────────────────────────────────────────────────────
// §4  Provenance — the window comes from the ECHO, not the page filter
// ─────────────────────────────────────────────────────────────────────────

test('§4 the card is labelled from meta.window_days', () => {
    const html = renderFunnelCard(LIVE);
    assert.ok(html.includes('last 30 days'));
    assert.ok(html.includes('fixed window'));
});

test('§4 it says out loud that it ignores the dashboard date filter', () => {
    const html = renderFunnelCard(LIVE);
    assert.ok(/Independent of the date filter above/.test(html));
    assert.ok(html.includes('traffic_events'), 'meta.source is shown as provenance');
});

test('§4 the API method sends NO query string — every param is a decoy', () => {
    const idx = ADMIN_API.indexOf('async getConversionFunnel(');
    assert.notEqual(idx, -1);
    const fn = ADMIN_API.slice(idx, idx + 220);
    assert.ok(fn.includes("analyticsHttpGet('/api/admin/analytics/conversion-funnel'"));
    assert.ok(!/analyticsQuery|window_days=|date_from/.test(fn),
        'a query string that changes nothing teaches the next reader that the card follows the filter');
});

test('§4 the decoy measurement is documented at the method', () => {
    const idx = ADMIN_API.indexOf('async getConversionFunnel(');
    const doc = ADMIN_API.slice(Math.max(0, idx - 1400), idx);
    assert.ok(/DECOY/i.test(doc) && /window_days/.test(doc));
});

// ─────────────────────────────────────────────────────────────────────────
// §5  Wiring + styling
// ─────────────────────────────────────────────────────────────────────────

test('§5 the card is fetched and rendered on the dashboard', () => {
    assert.ok(/AdminAPI\.getConversionFunnel\(signal\)/.test(DASH));
    assert.ok(/funnel: val\(13\)/.test(DASH));
    assert.ok(/\$\{renderFunnelCard\(d\.funnel\)\}/.test(DASH));
});

test('§5 conversion-by-source stays commented out — it still returns >100%', () => {
    assert.ok(/\/\/\s+drawRanked\('dash-c-conversion-source'/.test(DASH));
});

test('§5 every class the card emits is styled, with defined variables only', () => {
    ['admin-conv-funnel', 'admin-conv-funnel__row', 'admin-conv-funnel__row--broken', 'admin-conv-funnel__label',
     'admin-conv-funnel__bar', 'admin-conv-funnel__count', 'admin-conv-funnel__rate', 'admin-conv-funnel__overall',
     'admin-conv-funnel__broken', 'admin-conv-funnel__gap', 'admin-conv-funnel__source', 'admin-conv-funnel__empty',
    ].forEach((c) => assert.ok(CSS.includes('.' + c), `${c} is emitted but never styled`));

    const block = CSS.slice(CSS.indexOf('.admin-conv-funnel {'));
    const vars = [...new Set((block.match(/var\(--[a-z-]+/g) || []).map((v) => v.slice(4)))];
    vars.forEach((v) => assert.ok(new RegExp(`${v}\\s*:`).test(CSS), `${v} is used but never defined`));
});
