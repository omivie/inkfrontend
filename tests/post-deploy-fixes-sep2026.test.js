/**
 * Post-deploy fixes (backend handoff 2026-09-28,
 * backend-docs/inbox/fe-post-deploy-fixes-sep2026.md) — ERR-293.
 *
 * §1  /review is LIVE: flag on, order heading + product image, a repeat
 *     submit (200 already_existed) says so, the last form says "all done"
 * §2  compatible PDP, desktop: ONE compliance line + ONE fit line under the
 *     title, ONE ladder line above Add; full compliance text + chips below Add
 * §3  card "+N" reads compatible_printers_count (listing rows cap the array at 2)
 * §4  the countdown carries the promise's scope, from ONE owner shared with
 *     the delivery row
 *
 * Every section EXECUTES the shipped code (utils.js required, PDP methods and
 * review-page.js compiled in a vm) — a grep proves a spelling, not a branch
 * (ERR-253, ERR-258).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const U = require('../inkcartridges/js/utils.js');
const Security = {
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    escapeAttr: (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
};

/** Body of `name(...) { ... }` inside an object literal, brace-matched. */
function extractMethod(src, name) {
    const re = new RegExp(`\\n\\s+(?:async\\s+)?${name}\\s*\\(([^)]*)\\)\\s*\\{`);
    const m = re.exec(src);
    assert.ok(m, `${name}() must exist`);
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return { params: m[1], body: src.slice(open, i + 1) }; }
    }
    throw new Error(`unbalanced ${name}`);
}

/** Minimal element: enough of the DOM for the renderers under test. */
function el(id, cls = '') {
    return {
        id, className: cls, innerHTML: '', textContent: '', hidden: true, children: [],
        querySelector(sel) {
            if (sel === '.product-headline__line:not([hidden])') return this.children.find((c) => !c.hidden) || null;
            return null;
        },
        insertAdjacentHTML(pos, html) { this.adjacent = (this.adjacent || []).concat({ pos, html }); },
    };
}

/** A PDP "page": the header strip, the summary line, #product-fit, the pricing block. */
function pdpDom() {
    const strip = el('product-headline');
    const compliance = el('product-headline-compliance', 'product-headline__line');
    const fit = el('product-headline-fit', 'product-headline__line');
    strip.children = [compliance, fit];
    const byId = {
        'product-headline': strip, 'product-headline-compliance': compliance, 'product-headline-fit': fit,
        'volume-pricing-summary': el('volume-pricing-summary'), 'product-fit': el('product-fit'),
    };
    const pricing = el('', 'product-info__pricing');
    const document = {
        getElementById: (id) => byId[id] || null,
        querySelector: (sel) => (sel === '.product-info__pricing' ? pricing : null),
    };
    return { byId, pricing, document };
}

/** Compile PDP methods from the SHIPPED file into one object bound to a fake DOM. */
function pdp(document, globals = {}) {
    const src = read('js/product-detail-page.js');
    const ctx = vm.createContext({
        Security, document, DispatchCountdown: U.DispatchCountdown,
        formatPrice: (n) => '$' + Number(n).toFixed(2),
        Business: { breakLabel: (r) => (r && Number.isFinite(r.minQuantity) ? `${r.minQuantity}+` : '') },
        ...globals,
    });
    const self = {
        _printerLabel: (n) => U.PrinterName.display(n),
        _printerHubHref: () => '/printers/x',
        _fitKey: (s) => String(s).toLowerCase(),
    };
    for (const name of ['_setHeadline', 'renderComplianceDisclaimer', 'renderFitCheck', 'renderVolumeSummary', '_dispatchClause']) {
        const { params, body } = extractMethod(src, name);
        self[name] = vm.runInContext(`(function (${params}) ${body})`, ctx).bind(self);
    }
    return self;
}

const printers = (n) => Array.from({ length: n }, (_, i) => ({ full_name: `Brother MFC J${5910 + i}DW` }));

// ─────────────────────────────────────────────────────────────────────────────
// §1 /review
// ─────────────────────────────────────────────────────────────────────────────

test('§1 guestReviews is ON; guestCartEmail is unchanged', () => {
    const cfg = stripComments(read('js/config.js'));
    assert.match(cfg, /guestReviews:\s*true/);
    assert.match(cfg, /guestCartEmail:\s*false/);
});

/** Run review-page.js in a vm with a fake page, API and flag. */
async function runReviewPage({ flag = true, token = 'tok123', getResp, postResp }) {
    const body = el('review-page-body');
    const forms = [];
    body.querySelectorAll = () => forms;
    const ctx = vm.createContext({
        Security, console, URLSearchParams,
        Config: { DARK_FEATURES: { guestReviews: flag } },
        window: { location: { search: token ? `?token=${token}` : '' } },
        document: { getElementById: (id) => (id === 'review-page-body' ? body : null), addEventListener() {} },
        API: {
            calls: [],
            async getReviewToken(t) { this.calls.push(['GET', t]); if (getResp instanceof Error) throw getResp; return getResp; },
            async submitReviewByToken(p) { this.calls.push(['POST', p]); return postResp; },
            extractErrorMessage: (_r, fb) => fb,
        },
    });
    vm.runInContext(read('js/review-page.js').replace(/^'use strict';/m, ''), ctx);
    const RP = vm.runInContext('ReviewPage', ctx);
    RP.bind = () => {};
    await RP.init();
    return { body, RP, api: ctx.API };
}

test('§1 flag OFF: dark message and NO request (control)', async () => {
    const { body, api } = await runReviewPage({ flag: false, getResp: { ok: true, data: { items: [] } } });
    assert.match(body.innerHTML, /isn(&#39;|')t active yet|isn't active yet/);
    assert.equal(api.calls.length, 0);
});

test('§1 flag ON: a real token lists the unreviewed products under the order number, images escaped', async () => {
    const { body, api } = await runReviewPage({ getResp: { ok: true, data: {
        order_number: '2026092801',
        items: [
            { sku: 'CLC73BK', name: 'Compatible Brother LC73 Black', image_url: 'https://x.supabase.co/a.png?"onerror=1', reviewed: false },
            { sku: 'CLC73C', name: 'Already done', image_url: null, reviewed: true },
            { sku: 'CTN2450', name: '<b>Toner</b>', image_url: 'javascript:alert(1)', reviewed: false },
        ],
    } } });
    assert.deepEqual(api.calls, [['GET', 'tok123']]);
    assert.match(body.innerHTML, /Order 2026092801/);
    assert.match(body.innerHTML, /data-sku="CLC73BK"/);
    assert.doesNotMatch(body.innerHTML, /Already done/, 'reviewed: true items are not offered again');
    assert.match(body.innerHTML, /src="https:\/\/x\.supabase\.co\/a\.png\?&quot;onerror=1"/, 'image_url is attribute-escaped');
    assert.doesNotMatch(body.innerHTML, /javascript:/, 'only https images render');
    assert.match(body.innerHTML, /&lt;b&gt;Toner&lt;\/b&gt;/);
});

test('§1 every item already reviewed ⇒ the all-done message; 404 ⇒ expired message', async () => {
    const done = await runReviewPage({ getResp: { ok: true, data: { order_number: 'x', items: [{ sku: 'A', reviewed: true }] } } });
    assert.match(done.body.innerHTML, /reviewed everything in this order/);
    const gone = await runReviewPage({ getResp: { ok: false, code: 'NOT_FOUND' } });
    assert.match(gone.body.innerHTML, /expired or could not be read/);
});

test('§1 a repeat submit (200 already_existed) is not reported as a new review', async () => {
    const { RP } = await runReviewPage({ getResp: { ok: true, data: { items: [] } } });
    assert.equal(RP.thanksText({ ok: true, data: { already_existed: true } }), "You'd already reviewed this one — your review stands. Thank you!");
    assert.equal(RP.thanksText({ ok: true, already_existed: true }), "You'd already reviewed this one — your review stands. Thank you!");
    assert.equal(RP.thanksText({ ok: true, data: { id: 1 } }), 'Thank you — your review has been sent.');
});

test('§1 submit handler uses thanksText and appends the all-done line after the LAST form', () => {
    const fn = extractMethod(stripComments(read('js/review-page.js')), 'bind').body;
    assert.match(fn, /this\.thanksText\(resp\)/);
    assert.match(fn, /review-page__form--done/);
    assert.match(fn, /this\.DONE_TEXT/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 compatible PDP, desktop
// ─────────────────────────────────────────────────────────────────────────────

test('§2 compatible: one compliance line under the title AND the full panel still rendered', () => {
    const { byId, pricing, document } = pdpDom();
    pdp(document).renderComplianceDisclaimer({ source: 'compatible', brandName: 'Brother', category: 'ink' });
    assert.equal(byId['product-headline-compliance'].innerHTML, 'Compatible — not made by Brother');
    assert.equal(byId['product-headline-compliance'].hidden, false);
    assert.equal(byId['product-headline'].hidden, false);
    const panel = pricing.adjacent.map((a) => a.html).join('');
    assert.match(panel, /Compatible \(third-party\) ink cartridge for Brother printers — not made or endorsed by Brother\. Sold by Office Consumables Ltd\./,
        'the owner kept every word of the full box — it moves, it is not dropped');
});

test('§2 genuine / unknown source: no compliance line, strip stays hidden (control)', () => {
    for (const source of ['genuine', undefined, 'COMPATIBLE']) {
        const { byId, pricing, document } = pdpDom();
        pdp(document).renderComplianceDisclaimer({ source, brandName: 'Brother' });
        assert.equal(byId['product-headline-compliance'].hidden, true, String(source));
        assert.equal(byId['product-headline'].hidden, true, String(source));
        assert.equal(pricing.adjacent, undefined, String(source));
    }
});

test('§2 brand name in the headline is escaped', () => {
    const { byId, document } = pdpDom();
    pdp(document).renderComplianceDisclaimer({ source: 'compatible', brandName: '<img src=x>' });
    assert.equal(byId['product-headline-compliance'].innerHTML, 'Compatible — not made by &lt;img src=x&gt;');
});

test('§2 fit headline: "Fits: {first two} +N more" from the PDP\'s full list; none ⇒ hidden', () => {
    const { byId, document } = pdpDom();
    const P = pdp(document);
    P.renderFitCheck({ category: 'ink', compatible_printers: printers(11) });
    assert.equal(byId['product-headline-fit'].innerHTML, '<strong>Fits:</strong> Brother MFC J5910DW, Brother MFC J5911DW +9 more');
    P.renderFitCheck({ category: 'ink', compatible_printers: printers(2) });
    assert.equal(byId['product-headline-fit'].innerHTML, '<strong>Fits:</strong> Brother MFC J5910DW, Brother MFC J5911DW');
    P.renderFitCheck({ category: 'ink', compatible_printers: [] });
    assert.equal(byId['product-headline-fit'].hidden, true, 'no list ⇒ no line (next product must not inherit the last one)');
    P.renderFitCheck({ category: 'ribbon', compatible_printers: printers(3) });
    assert.equal(byId['product-headline-fit'].hidden, true, 'ribbons are owner-manual (ERR-086)');
});

test('§2 ladder line: entry rung + its backend price, never a maximum saving; no ladder ⇒ hidden', () => {
    const { byId, document } = pdpDom();
    const P = pdp(document);
    const line = byId['volume-pricing-summary'];
    // CLC73BK, measured 2026-09-28: quantity_breaks[0] = {min_quantity: 3, business_price: 5.56}
    P.renderVolumeSummary({ entry: { minQuantity: 3, businessPrice: 5.56 }, best: { minQuantity: 8, businessPrice: 5.21, percent: 10 } });
    assert.equal(line.hidden, false);
    assert.match(line.innerHTML, /^3\+ from \$5\.56 each <span aria-hidden="true">·<\/span> <a href="#volume-pricing">See all prices<\/a>$/);
    assert.doesNotMatch(line.innerHTML, /up to|save|5\.21|10%/i, 'the best rung is never advertised above Add');
    P.renderVolumeSummary(null);
    assert.equal(line.hidden, true);
    P.renderVolumeSummary({ entry: { minQuantity: 3 } });
    assert.equal(line.hidden, true, 'an entry with no price is not a claim');
});

test('§2 renderVolumePricing clears the line first and fills it only after the stale-product guard', () => {
    const fn = extractMethod(stripComments(read('js/product-detail-page.js')), 'renderVolumePricing').body;
    const clear = fn.indexOf('this.renderVolumeSummary(null)');
    const guard = fn.indexOf('this.product.sku !== sku');
    const fill = fn.indexOf('this.renderVolumeSummary(ladder)');
    assert.ok(clear >= 0 && guard > clear && fill > guard, `clear ${clear} < guard ${guard} < fill ${fill}`);
});

test('§2 markup: the strip sits under the title, the ladder line before the actions, both ship hidden', () => {
    const html = read('html/product/index.html');
    const title = html.indexOf('id="product-title"');
    const strip = html.indexOf('id="product-headline"');
    const sku = html.indexOf('id="product-sku"');
    assert.ok(title < strip && strip < sku, 'directly under the title');
    assert.match(html, /id="product-headline" hidden/);
    const ladder = html.indexOf('id="volume-pricing"');
    const summary = html.indexOf('id="volume-pricing-summary"');
    const actions = html.indexOf('class="product-info__actions"');
    assert.ok(ladder < summary && summary < actions, 'the one-line ladder is the last thing before Add');
    assert.match(html, /id="volume-pricing-summary"[^>]*hidden/);
});

test('§2 CSS: desktop-only lines; compliance + chips order 1, reassurance order 2; summary hidden in #product-fit', () => {
    const css = stripComments(read('css/pages.css'));
    assert.match(css, /\.product-headline,\s*\.volume-pricing-summary\s*\{\s*display:\s*none;\s*\}/, 'hidden below 1100px (phones unchanged)');
    const i = css.indexOf('@media (min-width: 1100px) {\n    .product-info {\n        display: flex;');
    assert.ok(i > 0);
    const block = css.slice(i, css.indexOf('\n}', i));
    assert.match(block, /#compat-disclaimer,\s*\.product-info > #volume-pricing\s*\{\s*order:\s*1;/);
    assert.match(block, /#product-specs\s*\{\s*order:\s*2;/);
    assert.match(block, /#product-fit \.product-fit__summary\s*\{\s*display:\s*none;/);
    assert.match(block, /\.product-headline:not\(\[hidden\]\)\s*\{\s*display:\s*block;/);
    assert.match(block, /\.volume-pricing-summary:not\(\[hidden\]\)\s*\{\s*display:\s*block;/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 card +N
// ─────────────────────────────────────────────────────────────────────────────

test('§3 fitsLine reads compatible_printers_count: LC73 (2 of 11) ⇒ +9', () => {
    const P = (n) => ({ full_name: n });
    const row = [P('Brother DCP J525W'), P('Brother DCP J725DW')];
    assert.equal(U.PrinterName.fitsLine(row, 11), 'Fits Brother DCP J525W, Brother DCP J725DW +9');
    assert.equal(U.PrinterName.fitsLine(row, 2), 'Fits Brother DCP J525W, Brother DCP J725DW', 'nothing extra at 0');
    assert.equal(U.PrinterName.fitsLine(row, '11'), 'Fits Brother DCP J525W, Brother DCP J725DW +9', 'a numeric string counts');
    for (const bad of [undefined, null, '', 'abc', NaN]) {
        assert.equal(U.PrinterName.fitsLine(row, bad), 'Fits Brother DCP J525W, Brother DCP J725DW', `count ${String(bad)} ⇒ list length`);
    }
    assert.equal(U.PrinterName.fitsLine([P('A'), P('B'), P('C')], 3), 'Fits A, B +1', 'total − SHOWN, not total − array length');
    assert.equal(U.PrinterName.fitsLine([P('A'), P('B'), P('C'), P('D')], 1), 'Fits A, B +2', 'a count below the list we hold never hides printers');
    assert.equal(U.PrinterName.fitsLine([], 11), '', 'no names ⇒ no line, whatever the count');
});

test('§3 BOTH card renderers pass the count (products.js + the shop-page.js duplicate)', () => {
    for (const f of ['js/products.js', 'js/shop-page.js']) {
        const src = stripComments(read(f));
        const calls = src.match(/PrinterName\.fitsLine\([^)]*\)/g) || [];
        assert.ok(calls.length >= 1, `${f} renders a fits line`);
        for (const c of calls) assert.equal(c, 'PrinterName.fitsLine(product.compatible_printers, product.compatible_printers_count)', f);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 countdown scope
// ─────────────────────────────────────────────────────────────────────────────

const PROMISE = 'Auckland metro orders placed before 14:00 NZT on a business day are dispatched the same day. North Island 1-3 business days; South Island 2-4 business days.';

test('§4 DispatchCountdown.scope follows the promise text', () => {
    const D = U.DispatchCountdown;
    assert.equal(D.scope({ promise: PROMISE }), ' (Auckland metro)');
    assert.equal(D.scope({ promise: 'Dispatched same day nationwide.' }), '');
    assert.equal(D.scope({}), '');
    assert.equal(D.scope(null), '');
    assert.equal(D.scope({ promise: 42 }), '');
});

test('§4 the live countdown text carries the scope (PDP + cart share mount)', () => {
    const D = U.DispatchCountdown;
    const mk = () => ({ textContent: '', hidden: true });
    const opts = { now: () => 0, setInterval: () => 1, clearInterval() {} };
    const a = mk();
    D.mount(a, { same_day_eligible: true, cutoff_remaining_seconds: 5 * 3600 + 3 * 60, promise: PROMISE }, opts);
    assert.equal(a.textContent, 'Order within 5h 03m for same-day dispatch (Auckland metro)');
    const b = mk();
    D.mount(b, { same_day_eligible: true, cutoff_remaining_seconds: 60 * 9 + 5 }, opts);
    assert.equal(b.textContent, 'Order within 9m 05s for same-day dispatch', 'no promise ⇒ no invented region (control)');
});

test('§4 the delivery row and the countdown share ONE scope rule', () => {
    const { document } = pdpDom();
    const P = pdp(document);
    assert.match(P._dispatchClause({ same_day_eligible: true, promise: PROMISE }, '2pm'), /for same-day dispatch \(Auckland metro\)/);
    const fn = extractMethod(stripComments(read('js/product-detail-page.js')), '_dispatchClause').body;
    assert.match(fn, /DispatchCountdown\.scope\(delivery\)/);
    assert.doesNotMatch(fn, /auckland metro/i, 'the regex lives only in DispatchCountdown.scope');
});
