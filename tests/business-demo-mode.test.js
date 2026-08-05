/**
 * Business Centre — local demo data mode
 * ======================================
 *
 * js/business-demo.js fabricates money figures for a page whose entire subject
 * is a customer's money. Two things therefore have to be true forever, and
 * they are what most of this file asserts:
 *
 *   1. It cannot run in production. Not "is unlikely to" — cannot. Both the
 *      hostname check and the explicit opt-in are required, in the module AND
 *      in the loader that fetches it, so a deployed browser never even
 *      requests the file.
 *
 *   2. Its fixtures agree with each other. The page reads the outstanding
 *      balance from one endpoint and the invoice list from another, and the
 *      headline savings from series totals while the chart plots the buckets.
 *      Fixtures that disagreed would counterfeit a bug in shipped code and
 *      send someone hunting it.
 *
 * Run: node --test tests/business-demo-mode.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const JS = (f) => fs.readFileSync(path.join(INK, 'js', f), 'utf8');

const DEMO_SRC = JS('business-demo.js');
const PAGE_SRC = JS('business-page.js');
const PDF_SRC = JS('business-invoice-pdf.js');

const codeOnly = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * Load the module under a fake `window`/`location`/`sessionStorage`, so the
 * guard can be exercised against a hostname of our choosing.
 */
function load({ hostname = 'localhost', search = '?demo=1', stored = null } = {}) {
    const store = new Map();
    if (stored !== null) store.set('ink_business_demo', stored);

    const sandbox = {
        location: { hostname, search, href: `https://${hostname}/business${search}`, pathname: '/business', hash: '' },
        sessionStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: (k) => store.delete(k)
        },
        document: {
            getElementById: () => null,
            createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
            head: { appendChild() {} }
        },
        URL,
        URLSearchParams,
        Math,
        Date,
        Number,
        console,
        module: { exports: {} }
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(DEMO_SRC, sandbox, { filename: 'business-demo.js' });
    return sandbox.window.BusinessDemo;
}

// ═════════════════════════════════════════════════════════════════════════════
// §1 — it cannot run in production
// ═════════════════════════════════════════════════════════════════════════════

test('§1 a production hostname can never activate demo mode', () => {
    for (const hostname of ['inkcartridges.co.nz', 'www.inkcartridges.co.nz', 'feink.vercel.app', 'localhost.evil.com']) {
        const D = load({ hostname, search: '?demo=1' });
        assert.equal(D.active(), false,
            `demo mode must be impossible on ${hostname} — it fabricates figures about a customer's money`);
    }
});

test('§1 a dev hostname alone is not enough — the opt-in is required', () => {
    assert.equal(load({ hostname: 'localhost', search: '' }).active(), false,
        'opening /business locally must show the REAL (possibly empty) account, not fixtures');
    assert.equal(load({ hostname: '127.0.0.1', search: '?other=1' }).active(), false);
});

test('§1 both conditions together do activate it, and ?demo=0 turns it off', () => {
    assert.equal(load({ hostname: 'localhost', search: '?demo=1' }).active(), true);
    assert.equal(load({ hostname: '127.0.0.1', search: '?demo=1' }).active(), true);
    // Sticky for the tab, so the #invoices hash and the tab buttons keep it…
    assert.equal(load({ hostname: 'localhost', search: '', stored: '1' }).active(), true);
    // …but an explicit ?demo=0 always wins over the stored flag.
    assert.equal(load({ hostname: 'localhost', search: '?demo=0', stored: '1' }).active(), false);
});

test('§1 the guard is an AND of two independent conditions, in source', () => {
    const code = codeOnly(DEMO_SRC);
    assert.match(code, /isLocalHost\(\)\s*&&\s*optedIn\(\)/,
        'the two conditions must be ANDed — either one alone is a production hazard');
    assert.ok(!/isLocalHost\(\)\s*\|\|/.test(code),
        'an OR here would arm the module on a deployed host');
    assert.match(code, /hostname === 'localhost'/);
    assert.match(code, /hostname === '127\.0\.0\.1'/);
});

test('§1 the loader repeats the guard, so the file is never fetched in production', () => {
    const code = codeOnly(PAGE_SRC);
    const loader = code.slice(code.indexOf('async loadDemo()'), code.indexOf('demoOn()'));
    assert.ok(loader, 'business-page.js must own a loadDemo()');
    assert.match(loader, /hostname === 'localhost'/);
    assert.match(loader, /if \(!local\) return false/,
        'a deployed host must bail before the script element is ever created');
    assert.match(loader, /if \(!opted\) return false/,
        'the explicit opt-in must also gate the fetch');
    // The request itself must sit AFTER both bails.
    assert.ok(loader.indexOf('if (!opted) return false') < loader.indexOf("'/js/business-demo.js'"),
        'the guard must precede the network request, not follow it');
});

test('§1 business.html must NOT ship a script tag for the demo module', () => {
    // It is loaded dynamically precisely so production never requests it.
    const page = fs.readFileSync(path.join(INK, 'html', 'business.html'), 'utf8');
    assert.ok(!page.includes('business-demo.js'),
        'a <script src> would ship the fixtures to every real customer on the page');
});

// ═════════════════════════════════════════════════════════════════════════════
// §2 — it says so, loudly
// ═════════════════════════════════════════════════════════════════════════════

test('§2 demo mode announces itself on the page', () => {
    const code = codeOnly(DEMO_SRC);
    assert.match(code, /business-demo-banner/, 'a banner element is required');
    assert.match(DEMO_SRC, /Demo data/i);
    assert.match(DEMO_SRC, /not your account/i,
        'the banner has to say the figures are not the reader\'s own — that is the entire point of it');
    assert.match(DEMO_SRC, /Turn it off/i, 'the banner must offer the way out');

    const page = codeOnly(PAGE_SRC);
    assert.match(page, /BusinessDemo\.banner\(\)/,
        'the controller must render the banner whenever it renders demo figures');
    assert.ok(page.indexOf('BusinessDemo.banner()') < page.indexOf("this.loadOverview();\n                return;") + 400,
        'the banner must go up in the same branch that fills the page');
});

test('§2 the banner styles itself, without touching the shared pages.css token', () => {
    const css = fs.readFileSync(path.join(INK, 'css', 'pages.css'), 'utf8');
    assert.ok(!css.includes('business-demo-banner'),
        'pages.css carries ONE cache token shared by every page on the site — a dev-only ' +
        'feature must not restamp all of them');
    assert.match(codeOnly(DEMO_SRC), /createElement\('style'\)/);
});

// ═════════════════════════════════════════════════════════════════════════════
// §3 — the fixtures agree with each other
// ═════════════════════════════════════════════════════════════════════════════

const D = load();
const unwrap = (r) => { assert.equal(r.ok, true, `expected an ok envelope, got ${r.code}`); return r.data; };
const series = unwrap(D.get('/api/business/analytics/series?granularity=month'));
const summary = unwrap(D.get('/api/business/account/summary'));
const allInvoices = unwrap(D.get('/api/business/invoices')).invoices;
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg} (${a} vs ${b})`);

/** The whole history, at whichever grain — the window the tiles summarise. */
const WHOLE = '?from=1900-01-01&to=2100-01-01';
const wholeMonth = unwrap(D.get(`/api/business/analytics/series${WHOLE}&granularity=month`));
const wholeWeek = unwrap(D.get(`/api/business/analytics/series${WHOLE}&granularity=week`));
const sumOf = (pts, k) => pts.reduce((t, p) => t + p[k], 0);

test('§3 the LIFETIME totals are the sum of the whole history, not of the window', () => {
    // The tiles say "All time" and must not move when the range control does, so
    // `totals` is summed from the full base while `points` is only the slice
    // asked for. Over the whole window the two coincide — which is exactly the
    // fixture the page's window-vs-lifetime consistency gate runs against.
    close(wholeMonth.totals.lifetime_spend_incl_gst, sumOf(wholeMonth.points, 'spend_incl_gst'), 0.01,
        'the Total spend tile and the chart are read side by side');
    close(wholeMonth.totals.lifetime_b2b_savings, sumOf(wholeMonth.points, 'b2b_savings'), 0.01,
        'the Saved tile and the savings band are read side by side');
    close(wholeMonth.totals.lifetime_other_savings, sumOf(wholeMonth.points, 'other_savings'), 0.01);

    // ...and the default 12-month window is a SUBSET, or the range control is
    // doing nothing and the demo teaches that it doesn't work.
    assert.ok(sumOf(series.points, 'spend_incl_gst') < wholeMonth.totals.lifetime_spend_incl_gst,
        'the default window must be narrower than all time, or nothing is being filtered');
    assert.equal(series.coverage.orders_counted, sumOf(series.points, 'orders'),
        'coverage is WINDOW-scoped and must match the rows returned beside it');
});

test('§3 switching the grain does not change the story', () => {
    // Weekly and monthly buckets are two views of ONE daily base. If they were
    // generated independently they could disagree, and pressing "Weekly" would
    // silently change the customer's total spend — a bug the demo would be
    // teaching rather than exposing.
    for (const k of ['spend_incl_gst', 'b2b_savings', 'other_savings', 'orders']) {
        close(sumOf(wholeMonth.points, k), sumOf(wholeWeek.points, k), 0.01,
            `${k} must total the same at every grain`);
    }
    assert.ok(wholeWeek.points.length > wholeMonth.points.length,
        'weekly must actually be a finer grain');
});

test('§3 the served window and grain are ECHOED, clamped to the history that exists', () => {
    // The page labels its axis from this echo and warns when it differs from the
    // request. A fixture that parroted the request back would hide the only bug
    // that check exists to catch.
    assert.equal(wholeWeek.granularity, 'week');
    assert.equal(wholeMonth.granularity, 'month');
    assert.equal(wholeMonth.from, wholeMonth.points[0].period_start);
    assert.equal(wholeMonth.to, wholeMonth.points[wholeMonth.points.length - 1].period_start);
    assert.ok(wholeMonth.from > '1900-01-01',
        'an out-of-range request must echo the CLAMP, not the ask');

    // A no-parameter call gets the contract default: the last 12 months, monthly.
    const def = unwrap(D.get('/api/business/analytics/series'));
    assert.equal(def.granularity, 'month');
    assert.equal(def.points.length, 12);
});

test('§3 a narrower window is the TAIL of a wider one, bucket for bucket', () => {
    // Proves the range control slices one history rather than regenerating a
    // different one — otherwise every range would tell a different story.
    const twelve = unwrap(D.get('/api/business/analytics/series?granularity=month')).points;
    const tail = wholeMonth.points.slice(-twelve.length);
    assert.deepEqual(twelve, tail,
        'the 12-month view must be the last 12 buckets of the full history');
});

test('§3 demo_profile=partial is opt-in, and makes the not-recorded states reachable', () => {
    // Without it every bucket is a number, so the hatched not-recorded marks, the
    // broken running total and the discount-breakdown caveat are all unreachable
    // in review — the states most likely to be got wrong.
    const P = load({ search: '?demo=1&demo_profile=partial' });
    const partial = unwrap(P.get('/api/business/analytics/series?granularity=month'));
    const blanked = partial.points.filter((p) => p.b2b_savings === null);
    assert.ok(blanked.length >= 1, 'the partial profile must blank at least one bucket');
    for (const p of blanked) {
        assert.equal(p.other_savings, null, 'both halves of the split go together');
        assert.equal(typeof p.orders, 'number',
            'the orders HAPPENED — it is the breakdown that is missing');
    }
    // ...and the count reported is exactly the orders in those buckets.
    assert.equal(partial.coverage.orders_missing_discount_breakdown,
        blanked.reduce((t, p) => t + p.orders, 0));

    // The healthy default keeps every figure, so the caveat stays hidden.
    assert.equal(series.coverage.orders_missing_discount_breakdown, 0);
});

test('§3 coverage is present and zero, so the partial-data caveat stays hidden', () => {
    // 0 is a real measured value here; omitting the key would be absence-as-zero.
    assert.ok(Object.prototype.hasOwnProperty.call(series.coverage, 'orders_missing_discount_breakdown'));
    assert.equal(series.coverage.orders_missing_discount_breakdown, 0);
});

test('§3 the outstanding balance equals the unpaid invoices it summarises', () => {
    const unpaid = allInvoices.filter((i) => i.status === 'unpaid');
    const owed = unpaid.reduce((t, i) => t + i.amount_outstanding, 0);
    close(summary.outstanding_balance, owed, 0.01,
        'the tile comes from /account/summary and the rows from /invoices — a fixture that ' +
        'disagreed with itself would counterfeit a bug in shipped code');
    assert.equal(summary.unpaid_invoice_count, unpaid.length);
    assert.ok(summary.overdue_invoice_count >= 0 && summary.overdue_invoice_count <= unpaid.length);
    assert.ok(summary.overdue_balance <= summary.outstanding_balance + 0.01);
    close(summary.credit_remaining, summary.credit_limit - summary.outstanding_balance, 0.01);
});

test('§3 every invoice foots: subtotal + freight + GST === total, at 15%', () => {
    assert.ok(allInvoices.length >= 5, 'a demo with two invoices does not exercise the list');
    for (const i of allInvoices) {
        close(i.subtotal_excl_gst + i.freight_excl_gst + i.gst_amount, i.total_incl_gst, 0.01,
            `${i.invoice_number} must foot`);
        close((i.subtotal_excl_gst + i.freight_excl_gst) * 0.15, i.gst_amount, 0.02,
            `${i.invoice_number} GST must be 15% of the ex-GST sum`);
        assert.ok(i.total_incl_gst > 0);
        // A paid invoice owes a measured 0; an unpaid one owes its total.
        assert.equal(i.amount_outstanding, i.status === 'paid' ? 0 : i.total_incl_gst);
    }
});

test('§3 the mix is a HEALTHY account: mostly paid, a couple open, one overdue', () => {
    const by = (s) => allInvoices.filter((i) => i.status === s).length;
    assert.ok(by('paid') >= 3, 'a history of settled invoices is what makes the account look real');
    assert.ok(by('unpaid') >= 1, 'the outstanding tile needs something to report');
    assert.ok(summary.overdue_invoice_count >= 1,
        'the overdue sub-line and its alert styling need a row to exercise them');
});

test('§3 buckets ascend, are contiguous, and none is null in the healthy profile', () => {
    // The base runs long enough that 2 years and All are genuinely different
    // views — a 14-month history would make three of the five range presets
    // identical and the control would look broken.
    assert.ok(wholeMonth.points.length >= 24,
        'the history must outrun the 2y preset, or All and 2y show the same thing');

    for (let i = 1; i < wholeMonth.points.length; i++) {
        assert.ok(wholeMonth.points[i].period_start > wholeMonth.points[i - 1].period_start,
            'buckets must ascend or the chart draws backwards');
    }
    // Contiguous: the x-axis is CATEGORICAL, so a skipped month would close up
    // and vanish rather than leaving a hole.
    const first = wholeMonth.points[0].period_start;
    const last = wholeMonth.points[wholeMonth.points.length - 1].period_start;
    const months = (Number(last.slice(0, 4)) - Number(first.slice(0, 4))) * 12 +
        (Number(last.slice(5, 7)) - Number(first.slice(5, 7))) + 1;
    assert.equal(wholeMonth.points.length, months, 'every month in the span needs a bucket');

    for (const p of wholeMonth.points) {
        for (const k of ['spend_incl_gst', 'b2b_savings', 'other_savings']) {
            assert.equal(typeof p[k], 'number', `${k} must be a number in the healthy profile`);
        }
    }
});

test('§3 the B2B saving rate stays inside what the live ladder can actually produce', () => {
    // Entry rung 0.5%, top band 10%. A demo showing 25% would misrepresent the
    // product to the person deciding how to present it.
    for (const p of wholeMonth.points) {
        if (!p.spend_incl_gst) continue;   // a month with no orders saves nothing
        const pct = (p.b2b_savings / p.spend_incl_gst) * 100;
        assert.ok(pct > 0 && pct <= 10,
            `a ${pct.toFixed(1)}% bucket is outside the real 0.5–10% band`);
    }
});

// ═════════════════════════════════════════════════════════════════════════════
// §4 — the payloads match the real contract
// ═════════════════════════════════════════════════════════════════════════════

test('§4 no cost, margin or supplier field appears anywhere in the fixtures', () => {
    // Rule R2 of the backend brief. unit_cost_excl_gst is the SELL price and
    // supplier_cost_excl_gst is what we paid — one word apart, and only one of
    // them may ever touch a customer surface.
    const payloads = JSON.stringify({
        series, summary, allInvoices,
        top: D.get('/api/business/top-products?limit=8').data,
        detail: D.get(`/api/business/invoices/${allInvoices[0].id}`).data
    });
    for (const banned of [/supplier/i, /cost/i, /profit/i, /margin/i]) {
        assert.ok(!banned.test(payloads), `${banned} must never appear on a /api/business/* surface`);
    }
    // In the source we ban the FIELD NAMES specifically — "margin" and "profit"
    // as bare words also occur in CSS and in prose, and a check that cried wolf
    // there would be turned off.
    for (const field of ['supplier_cost', 'cost_excl_gst', 'cost_source', 'profit_excl_gst', 'margin_percent', 'unit_cost']) {
        assert.ok(!DEMO_SRC.includes(field), `${field} must never be written into a customer fixture`);
    }
});

test('§4 top products carry real SKUs, site-relative URLs and NO price', () => {
    const items = unwrap(D.get('/api/business/top-products?limit=8')).items;
    assert.equal(items.length, 8);
    for (const it of items) {
        assert.match(it.sku, /^[A-Z0-9.\-]+$/, 'a fake SKU 404s the moment Add to cart is clicked');
        assert.ok(it.product_url.startsWith('/'), 'product_url must be site-relative');
        assert.ok(!it.product_url.startsWith('/html/'),
            '/html/ URLs are banned site-wide by tests/url-consolidation.test.js');
        assert.ok(it.product_url.includes(it.sku), 'the URL must point at its own SKU');
        assert.ok(!('price' in it) && !('unit_price' in it),
            'the real endpoint omits price on purpose — reorder tiles price from the live ' +
            'catalogue, never from a historical figure re-presented as today\'s');
    }
    assert.ok(items.some((i) => i.in_stock === false),
        'one unbuyable tile is needed to exercise the disabled-with-a-reason state');
});

test('§4 invoice filters are applied, because the real ones are server-side', () => {
    // The controller sends status/from/to as query parameters and does NOT
    // filter in the browser. A demo that ignored them would make the filter
    // controls look broken.
    const unpaid = unwrap(D.get('/api/business/invoices?status=unpaid&limit=50')).invoices;
    assert.ok(unpaid.length > 0 && unpaid.length < allInvoices.length);
    assert.deepEqual([...new Set(unpaid.map((i) => i.status))], ['unpaid']);

    const limited = unwrap(D.get('/api/business/invoices?limit=5')).invoices;
    assert.equal(limited.length, 5, 'the Overview panel asks for 5 and must get 5');

    // No match is an EMPTY LIST, not an error — "no invoices match those
    // filters" and "we couldn't load them" are different sentences.
    const none = D.get('/api/business/invoices?from=2099-01-01&limit=50');
    assert.equal(none.ok, true);
    assert.equal(none.data.invoices.length, 0);
});

test('§4 paging is real, and pagination.total counts MATCHES not the page', () => {
    // The Invoices tab pages at 20 and reads pagination.total for both the
    // "Showing 20 of N" line and whether to offer Load more. Returning the page
    // length as the total would claim the first page is the whole list.
    assert.ok(allInvoices.length > 20,
        'the fixtures must exceed one page, or the Load more path is never exercised');

    const p1 = unwrap(D.get('/api/business/invoices?limit=20&page=1')).invoices;
    const meta = unwrap(D.get('/api/business/invoices?limit=20&page=1')).pagination;
    assert.equal(p1.length, 20);
    assert.equal(meta.total, allInvoices.length, 'total must be the full matched count');
    assert.equal(meta.page, 1);
    assert.equal(meta.limit, 20);

    const p2 = unwrap(D.get('/api/business/invoices?limit=20&page=2')).invoices;
    assert.equal(p2.length, allInvoices.length - 20);
    const ids = new Set(p1.map((i) => i.id));
    assert.ok(p2.every((i) => !ids.has(i.id)), 'page 2 must not repeat page 1');

    // A filter narrows the total too, or Load more offers a page that isn't there.
    const unpaidMeta = unwrap(D.get('/api/business/invoices?status=unpaid&limit=20&page=1')).pagination;
    assert.ok(unpaidMeta.total < allInvoices.length);
    assert.equal(unpaidMeta.total, allInvoices.filter((i) => i.status === 'unpaid').length);
});

test('§4 rows are newest-first and carry no invented internal flag', () => {
    for (let i = 1; i < allInvoices.length; i++) {
        assert.ok(allInvoices[i].issue_date <= allInvoices[i - 1].issue_date,
            'the list is ordered newest first');
    }
    // The page derives "overdue" itself from status + due_date. Leaking a
    // private _overdue flag would invite it to trust a field the live API has
    // never sent.
    for (const i of allInvoices) {
        assert.ok(!('_overdue' in i), 'internal bookkeeping must not reach the page');
    }
});

test('§4 the overdue count agrees with what the page derives from the rows', () => {
    // loadSummary() prints "N overdue" from the summary, while the list marks
    // rows overdue by comparing due_date to today. If those disagree the page
    // announces an overdue invoice that nothing in the list identifies.
    const todayISO = new Date().toISOString().slice(0, 10);
    const derived = allInvoices.filter((i) => i.status === 'unpaid' && i.due_date < todayISO).length;
    assert.equal(summary.overdue_invoice_count, derived);
});

test('§4 an unknown route misses instead of inventing a success', () => {
    const res = D.get('/api/business/something-added-later');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'NOT_FOUND');
});

test('§4 invoice detail carries lines that foot, under the customer-facing name', () => {
    const detail = unwrap(D.get(`/api/business/invoices/${allInvoices[0].id}`));
    assert.ok(Array.isArray(detail.lines) && detail.lines.length >= 2);
    const total = detail.lines.reduce((t, l) => t + l.line_total_excl_gst, 0);
    close(total, detail.subtotal_excl_gst, 0.02, 'the lines must add up to the subtotal');
    for (const l of detail.lines) {
        assert.ok('unit_price_excl_gst' in l,
            'the customer contract names the sell price unit_price_excl_gst, never unit_cost_*');
        close(l.unit_price_excl_gst * l.qty, l.line_total_excl_gst, 0.05);
    }
    assert.ok(detail.bill_to && Array.isArray(detail.bill_to.address_lines));
});

// ═════════════════════════════════════════════════════════════════════════════
// §5 — determinism, and no effect when it is off
// ═════════════════════════════════════════════════════════════════════════════

test('§5 two independent loads produce byte-identical fixtures', () => {
    const a = load(), b = load();
    assert.equal(
        JSON.stringify(a.get('/api/business/analytics/series').data),
        JSON.stringify(b.get('/api/business/analytics/series').data),
        'Math.random here would make every screenshot incomparable');
    assert.equal(
        JSON.stringify(a.get('/api/business/invoices').data),
        JSON.stringify(b.get('/api/business/invoices').data));
    assert.ok(!/Math\.random/.test(codeOnly(DEMO_SRC)), 'the fixtures must be seeded, not random');
});

test('§5 with the module absent, the controller takes the real path', () => {
    const code = codeOnly(PAGE_SRC);
    // Every demo branch must be reached through demoOn(), which is false when
    // window.BusinessDemo does not exist at all.
    assert.match(code, /demoOn\(\)\s*\{\s*return typeof BusinessDemo !== 'undefined' && BusinessDemo\.active\(\)/,
        'demoOn() must tolerate the module being absent, which is the production case');
    const branches = (code.match(/BusinessDemo\./g) || []).length;
    const guards = (code.match(/this\.demoOn\(\)|typeof BusinessDemo (?:!|=)== 'undefined'/g) || []).length;
    assert.ok(guards >= 3, `every BusinessDemo use must sit behind a guard (${branches} uses, ${guards} guards)`);
});

test('§5 the demo seam did not disturb the real fetch contract', () => {
    const code = codeOnly(PAGE_SRC);
    assert.match(code, /if \(expectArrayAt && !Array\.isArray/,
        'the MALFORMED check must survive — an ok envelope missing its collection is not empty');
    assert.match(code, /if \(Business\._statusDegraded\)/,
        'the three real gate states must be untouched');
    assert.ok(!/\.reduce\(/.test(code),
        'business-page.js must still never sum a paginated list — the fixtures do their own ' +
        'summing inside business-demo.js');
});

test('§5 the PDF fallback stays narrow, and the demo takes the no-stored-file route', () => {
    const code = codeOnly(PDF_SRC);
    assert.match(code, /res\.status === 404 \|\| res\.status === 409/,
        'the real narrow fallback must be untouched — a 5xx must never silently become a ' +
        'different document');
    assert.match(code, /BusinessDemo\.active\(\)[\s\S]{0,200}generateCopy/,
        'a generated invoice has no stored file, so demo mode goes straight to the stamped copy');
    assert.match(code, /Reproduced from your account/,
        'the generated copy must still be stamped as a copy');
});
