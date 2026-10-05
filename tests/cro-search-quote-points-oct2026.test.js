/**
 * CRO handoff — search Add to Cart, PDF quote, reward points (Oct 2026)
 * =====================================================================
 *
 * backend-docs/inbox/cro-search-quote-points-FE-handoff-oct2026.md (CRO brief
 * 2026-10-04). No coupon codes: lead with quantity pricing and reward points.
 *
 *   §1 search dropdown: Add to Cart on every row already ships; out of stock
 *      never offers Add; the query is sent AS TYPED (the backend now
 *      normalises "604 xl" / "604-xl" / "epson604" itself — no FE rewrite)
 *   §2 QuotePdf (js/cart-quote-pdf.js): query building, identity headers,
 *      file name, every failure shown, and both mounts (cart + checkout)
 *   §3 PDP reward points come from the product's `reward_points` by the
 *      backend's formula, not from value-props (which cannot see a multiplier)
 *   §4 PDP delivery row: `delivery_estimate.label` only — no hard-coded window
 *
 * The live contract (field shapes, the 400 body, CORS exposure, the search
 * pairs, a real PDF) is measured by `npm run probe:cro-quote-points`.
 *
 * Run: node --test tests/cro-search-quote-points-oct2026.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, 'inkcartridges', p), 'utf8');

const PDP_SRC = read('js/product-detail-page.js');
const SEARCH_SRC = read('js/search.js');
const QUOTE_SRC = read('js/cart-quote-pdf.js');

/** Body of `name(...) { ... }` inside an object literal, brace-matched. */
function extractMethod(src, name) {
    const re = new RegExp(`\\n\\s+(async\\s+)?${name}\\s*\\(([^)]*)\\)\\s*\\{`);
    const m = re.exec(src);
    assert.ok(m, `${name}() must exist in the shipped source`);
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return { isAsync: !!m[1], params: m[2], body: src.slice(open, i + 1) }; }
    }
    throw new Error(`unbalanced ${name}`);
}
function method(src, name, self = {}, globals = {}) {
    const { isAsync, params, body } = extractMethod(src, name);
    const ctx = vm.createContext({ formatPrice: (n) => '$' + Number(n).toFixed(2), Math, Number, ...globals });
    const fn = vm.runInContext(`(${isAsync ? 'async ' : ''}function (${params}) ${body})`, ctx);
    return (...args) => fn.apply(self, args);
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 search dropdown
// ─────────────────────────────────────────────────────────────────────────────

test('§1 the dropdown query goes out AS TYPED — no FE rewriting on top of the backend\'s', () => {
    const code = stripComments(SEARCH_SRC);
    const fetchSmart = code.slice(code.indexOf('async function fetchSmart'), code.indexOf('async function fetchSmart') + 2000);
    assert.match(fetchSmart, /\?q=\$\{encodeURIComponent\(query\)\}&limit=/, 'the q param is the query argument, encoded, nothing else');
    // Every .replace( in search.js is HTML escaping or match highlighting —
    // none touches the query. A new one fails here and has to justify itself.
    const replaces = code.match(/\.replace\(/g) || [];
    assert.equal(replaces.length, 3, 'search.js .replace( count changed — is the query being rewritten? (handoff: send what the shopper typed)');
    assert.doesNotMatch(code, /query\s*=\s*query\.(replace|toLowerCase)/);
    assert.doesNotMatch(code, /(604|xl)\b.*\.replace/i);
    const api = stripComments(read('js/api.js'));
    const smart = extractMethod(api, 'smartSearch').body;
    assert.doesNotMatch(smart, /query\.replace|query\.toLowerCase/, 'API.smartSearch sends the raw query');
});

test('§1 every dropdown row is a real product card with Add to Cart bound through Cart.addItem', () => {
    const code = stripComments(SEARCH_SRC);
    assert.match(code, /Products\.renderCard\(adaptForCard\(p\), i\)/);
    assert.match(code, /Products\.bindAddToCartEvents\(state\.list\)/, 'Add to Cart is wired on the dropdown list');
    const products = stripComments(read('js/products.js'));
    assert.match(products, /await Cart\.addItem\(productData\)/, 'the card Add goes through Cart.addItem (analytics + server confirm live there)');
    assert.match(products, /product\.pack_type[^\n]*=== 'value_pack'[\s\S]{0,120}product-card__ribbon--value-pack/, 'value-pack badge from pack_type, never the name');
    assert.match(code, /source: BrandSource\.of\(p\)/, 'genuine / compatible from the row\'s source field (BrandSource), never the name');
});

test('§1 in_stock:false never offers Add — getStockStatus puts the explicit negative first', () => {
    const api = read('js/api.js');
    const start = api.indexOf('function getStockStatus(product)');
    assert.ok(start > 0);
    let depth = 0, end = start;
    for (let i = api.indexOf('{', start); i < api.length; i++) {
        if (api[i] === '{') depth++;
        else if (api[i] === '}') { depth--; if (!depth) { end = i; break; } }
    }
    const ctx = vm.createContext({ OOS_STOCK_LABEL: 'Contact us' });
    vm.runInContext(api.slice(start, end + 1), ctx);
    assert.equal(ctx.getStockStatus({ in_stock: false, stock_quantity: 12 }).class, 'contact-us', 'in_stock:false outranks a positive count');
    assert.equal(ctx.getStockStatus({ in_stock: true, stock_quantity: 12 }).class, 'in-stock');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 QuotePdf
// ─────────────────────────────────────────────────────────────────────────────

function loadQuote(globals = {}) {
    const sb = {
        console, URLSearchParams, setTimeout: () => 0,
        document: { readyState: 'complete', querySelectorAll: () => [] },
        ...globals,
    };
    sb.window = sb;
    vm.createContext(sb);
    vm.runInContext(QUOTE_SRC, sb, { filename: 'cart-quote-pdf.js' });
    return sb.QuotePdf;
}

test('§2 buildQuery: header fields trimmed + clamped to 80; empty fields left out', () => {
    const Q = loadQuote();
    assert.equal(Q.buildQuery({}, null), '');
    assert.equal(Q.buildQuery({ company: '  Acme Ltd  ', attention: '', reference: 'PO 42/7' }, null),
        '?company=Acme+Ltd&reference=PO+42%2F7');
    const long = 'x'.repeat(81);
    const qs = new URLSearchParams(Q.buildQuery({ company: long }, null).slice(1));
    assert.equal(qs.get('company').length, 80, 'an 81-char company is a 400 VALIDATION_FAILED live (measured) — clamp it');
    assert.equal(Q.buildQuery({ company: 42 }, null), '', 'non-strings are ignored, never stringified');
});

test('§2 buildQuery: the shipping zone goes only when region + a 4-digit postcode are both there', () => {
    const Q = loadQuote();
    const zone = (z) => Object.fromEntries(new URLSearchParams(Q.buildQuery({}, z).slice(1)));
    assert.deepEqual(zone({ region: 'Otago', postal_code: '9016', delivery_type: 'rural' }),
        { region: 'Otago', postal_code: '9016', delivery_type: 'rural' });
    assert.deepEqual(zone({ region: 'Otago', postal_code: '901', delivery_type: 'rural' }), {}, 'a partial postcode would quote another zone');
    assert.deepEqual(zone({ region: '', postal_code: '9016' }), {}, 'no region ⇒ the cart\'s estimate');
    assert.deepEqual(zone({ region: 'Otago', postal_code: '9016', delivery_type: 'boat' }),
        { region: 'Otago', postal_code: '9016' }, 'unknown delivery_type is dropped, not sent');
});

test('§2 fileName: Content-Disposition, path-stripped, else the fallback', () => {
    const Q = loadQuote();
    assert.equal(Q.fileName('attachment; filename="Quote-Q2026-0042.pdf"'), 'Quote-Q2026-0042.pdf');
    assert.equal(Q.fileName('attachment; filename="../../evil.pdf"'), '....evil.pdf');
    assert.equal(Q.fileName(null), 'inkcartridges-quote.pdf');
    assert.equal(Q.fileName('attachment'), 'inkcartridges-quote.pdf');
});

test('§2 identity headers: a signed-in token wins; a guest sends X-Guest-Session; neither sends nothing', async () => {
    const mk = (token, guest) => loadQuote({ API: { getToken: async () => token, getGuestSessionId: () => guest } });
    assert.deepEqual({ ...(await mk('tok', 'g1').identityHeaders()) }, { Authorization: 'Bearer tok' });
    assert.deepEqual({ ...(await mk(null, 'g1').identityHeaders()) }, { 'X-Guest-Session': 'g1' });
    assert.deepEqual({ ...(await mk(null, null).identityHeaders()) }, {});
});

function fakeRes(status, body, headers = {}) {
    return {
        ok: status >= 200 && status < 300, status,
        headers: { get: (k) => headers[k] || null },
        json: async () => { if (body === undefined) throw new Error('not json'); return body; },
        blob: async () => ({ size: 1234 }),
    };
}

test('§2 download: URL, headers, credentials omitted, and the blob saved under the server\'s name', async () => {
    const calls = [];
    const Q = loadQuote({
        Config: { API_URL: 'https://api.example' },
        API: { getToken: async () => null, getGuestSessionId: () => 'guest-1' },
        fetch: async (url, opts) => { calls.push({ url, opts }); return fakeRes(200, null, { 'Content-Disposition': 'attachment; filename="Quote-1.pdf"' }); },
    });
    const saved = [];
    Q.saveBlob = (blob, name) => saved.push(name);
    const r = await Q.download({ reference: 'PO-9' }, null);
    assert.deepEqual({ ...r }, { ok: true, name: 'Quote-1.pdf' });
    assert.equal(calls[0].url, 'https://api.example/api/cart/quote.pdf?reference=PO-9');
    assert.equal(calls[0].opts.credentials, 'omit');
    assert.deepEqual({ ...calls[0].opts.headers }, { 'X-Guest-Session': 'guest-1' });
    assert.deepEqual(saved, ['Quote-1.pdf']);
});

test('§2 download: every failure comes back with a message the shopper can read', async () => {
    const run = async (res) => {
        const Q = loadQuote({ Config: { API_URL: '' }, API: { getToken: async () => null, getGuestSessionId: () => null }, fetch: async () => { if (res instanceof Error) throw res; return res; } });
        Q.saveBlob = () => { throw new Error('must not save on failure'); };
        return Q.download({}, null);
    };
    // Measured live 2026-10-05.
    let r = await run(fakeRes(400, { ok: false, error: { code: 'CART_EMPTY', message: 'Your cart is empty. Add items before downloading a quote.' } }));
    assert.equal(r.ok, false);
    assert.equal(r.message, 'Your cart is empty. Add items before downloading a quote.', 'the backend\'s own words');
    r = await run(fakeRes(400, { ok: false, error: { code: 'CART_EMPTY' } }));
    assert.equal(r.message, 'Your cart is empty. Add items to get a quote.');
    r = await run(fakeRes(400, { ok: false, error: { code: 'VALIDATION_FAILED', message: 'Validation failed', details: [{ field: 'postal_code', message: '"postal_code" must be 4 digits' }] } }));
    assert.equal(r.message, '"postal_code" must be 4 digits', 'the field-level reason beats "Validation failed"');
    r = await run(fakeRes(429, undefined));
    assert.match(r.message, /Too many quote downloads/);
    r = await run(fakeRes(502, undefined));
    assert.match(r.message, /error 502/);
    r = await run(new Error('offline'));
    assert.equal(r.status, null);
    assert.match(r.message, /Couldn't reach the server/);
});

test('§2 the button says "Download PDF quote" — never "Official" or "invoice"', () => {
    const Q = loadQuote();
    const html = Q.markup('cart');
    assert.match(html, />Download PDF quote</);
    assert.doesNotMatch(html, /official|invoice/i);
    assert.match(html, /maxlength="80"/);
    assert.match(html, /role="status"/, 'the result is announced, not just painted');
});

test('§2 mounted on BOTH the cart summary and the checkout summary (no cart drawer exists)', () => {
    const cart = read('html/cart.html');
    const checkout = read('html/checkout.html');
    assert.match(cart, /data-quote-pdf(="cart")?[\s>]/, 'cart summary mount');
    assert.match(checkout, /data-quote-pdf="checkout"/, 'checkout mount sends the shipping zone');
    for (const html of [cart, checkout]) {
        assert.match(html, /<script defer src="\/js\/cart-quote-pdf\.js\?v=[0-9a-f]+"><\/script>/);
    }
    const shared = stripComments(QUOTE_SRC);
    assert.match(shared, /getElementById\('region'\)|val\('region'\)/);
    assert.match(shared, /val\('postcode'\)/, 'checkout\'s postcode input is #postcode');
    assert.match(shared, /input\[name="delivery_type"\]:checked/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 PDP reward points
// ─────────────────────────────────────────────────────────────────────────────

const LIVE_RP = { points: 36, points_per_dollar: 1, multiplier: 1, redemption_rate: 100 }; // C02CMY @ $36.49, 2026-10-05

function pdpPoints() {
    const self = {};
    self.validRewardPoints = method(PDP_SRC, 'validRewardPoints', self);
    self.rewardPointsFor = method(PDP_SRC, 'rewardPointsFor', self);
    return self;
}

test('§3 validRewardPoints: the live shape passes; a half-formed block is ABSENT, never patched', () => {
    const P = pdpPoints();
    assert.deepEqual({ ...P.validRewardPoints(LIVE_RP) }, { points: 36, pointsPerDollar: 1, multiplier: 1, redemptionRate: 100 });
    assert.equal(P.validRewardPoints(undefined), null, 'absent = programme off');
    assert.equal(P.validRewardPoints({ ...LIVE_RP, multiplier: undefined }), null);
    assert.equal(P.validRewardPoints({ ...LIVE_RP, redemption_rate: 0 }), null);
    assert.equal(P.validRewardPoints({ ...LIVE_RP, points: 1.5 }), null);
});

test('§3 rewardPointsFor: the server figure at qty 1, the backend\'s formula on a rung', () => {
    const P = pdpPoints();
    const rp = P.validRewardPoints(LIVE_RP);
    assert.deepEqual({ ...P.rewardPointsFor(rp, 36.49, 1, 36.49) }, { points: 36, value: 0.36 }, 'qty 1 at retail = reward_points.points verbatim');
    // Live rung for C02CMY: min_quantity 3, business_price 35.40.
    assert.deepEqual({ ...P.rewardPointsFor(rp, 35.4, 3, 36.49) }, { points: 106, value: 1.06 }, 'floor(35.40 × 3) = 106');
    // A promotional multiplier: the value-props formula could never show this.
    const x2 = P.validRewardPoints({ ...LIVE_RP, points: 72, multiplier: 2 });
    assert.equal(P.rewardPointsFor(x2, 36.49, 1, 36.49).points, 72, 'the server already applied the multiplier at qty 1');
    assert.equal(P.rewardPointsFor(x2, 36.49, 2, 36.49).points, 144, 'floor(72.98) × 1 × 2');
    // Floor on DOLLARS, then multiply (the handoff's order) — differs from
    // floor(cents × ppd / 100) whenever points_per_dollar > 1.
    const ppd2 = P.validRewardPoints({ points: 20, points_per_dollar: 2, multiplier: 1, redemption_rate: 100 });
    assert.equal(P.rewardPointsFor(ppd2, 10.6, 2, 10.6).points, 42, 'floor(21.20) × 2');
    assert.equal(P.rewardPointsFor(ppd2, 10.6, 3, 10.6).points, 62, 'floor(31.80) × 2 = 62, NOT 63');
    // Float noise must not drop a dollar: 0.1 × 3 in floats is 0.30000000000000004, 33.3 × 3 = 99.89999…
    assert.equal(P.rewardPointsFor(rp, 33.3, 3, 36.49).points, 99);
    assert.equal(P.rewardPointsFor(rp, 0.5, 1, 36.49), null, '< 1 point prints nothing');
    assert.equal(P.rewardPointsFor(null, 36.49, 1, 36.49), null);
    assert.equal(P.rewardPointsFor(rp, NaN, 1, 36.49), null);
});

test('§3 the PDP slot exists only when the product carries reward_points; value-props no longer decides it', () => {
    const code = stripComments(PDP_SRC);
    const lines = extractMethod(code, 'renderValueLines').body;
    assert.match(lines, /this\._rewardPoints = this\.validRewardPoints\(info && info\.reward_points\)/);
    assert.match(lines, /if \(this\._rewardPoints\) facts\.push/);
    assert.doesNotMatch(lines, /ValueProps\.loyalty/);
    const sync = extractMethod(code, 'syncPointsLine').body;
    assert.match(sync, /this\.rewardPointsFor\(this\._rewardPoints, unit, qty, this\._unitPrice\)/);
    assert.doesNotMatch(code, /ValueProps\.pointsFor/);
});

test('§3 the quantity ladder never headlines a maximum percentage', () => {
    const code = stripComments(PDP_SRC);
    for (const name of ['renderVolumePricing', 'renderVolumeSummary']) {
        assert.doesNotMatch(extractMethod(code, name).body, /up to|max_discount_percent/i, `${name}: each rung is floor-clamped per line`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 PDP delivery row
// ─────────────────────────────────────────────────────────────────────────────

test('§4 delivery: the backend label verbatim; ABSENT ⇒ the row (dt + dd) is hidden and marked', () => {
    const code = stripComments(PDP_SRC);
    assert.doesNotMatch(code, /[1-4]\s*[–-]\s*[2-5] business days/, 'no literal delivery window anywhere in PDP code');
    const dd = { hidden: false, innerHTML: 'old', dataset: {}, previousElementSibling: { tagName: 'DT', hidden: false } };
    const warnings = [];
    const self = { _dispatchClause: () => ' · Order before 2pm NZT for same-day dispatch', _safeReturnsUrl: (u) => u };
    const doc = { getElementById: (id) => (id === 'product-delivery' ? dd : null) };
    const render = method(PDP_SRC, 'renderBuyBoxDeliveryAndReturns', self, {
        document: doc, Security: { escapeHtml: String, escapeAttr: String },
        DebugLog: { warn: (m) => warnings.push(m) },
    });
    render({ delivery_estimate: { label: '1–3 business days NZ-wide', dispatch_cutoff_human: '2pm' } });
    assert.match(dd.innerHTML, /1–3 business days NZ-wide/);
    assert.equal(dd.hidden, false);
    assert.equal(dd.previousElementSibling.hidden, false);
    assert.equal(dd.dataset.delivery, 'ok');
    render({});
    assert.equal(dd.innerHTML, '');
    assert.equal(dd.hidden, true);
    assert.equal(dd.previousElementSibling.hidden, true, 'no orphan "Delivery" label');
    assert.equal(dd.dataset.delivery, 'absent');
    assert.equal(warnings.length, 1, 'the gap is logged, not silent');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 PDP service row mount (FE master checklist item 5; module is feink-dc's
// js/service-row.js — this file owns only where and how the PDP mounts it)
// ─────────────────────────────────────────────────────────────────────────────

test('§5 the service row sits directly UNDER Add (zero fold cost at 1280x551), loads after utils.js', () => {
    const html = read('html/product/index.html');
    const actions = html.indexOf('<div class="product-info__actions">');
    const row = html.indexOf('id="product-service-row"');
    const confirm = html.indexOf('id="atc-confirmation"');
    assert.ok(actions > 0 && row > actions && row < confirm, 'after the Add row, before the confirmation');
    assert.match(html, /<div class="service-row" id="product-service-row"[^>]*hidden><\/div>/, 'ships hidden');
    assert.ok(html.indexOf('/js/utils.js?v=') < html.indexOf('/js/service-row.js?v='), 'needs TrustStats + Security from utils.js');
});

test('§5 renderServiceRow passes delivery_estimate and stamps WHY on the element', async () => {
    const el = { hidden: false, dataset: {} };
    const doc = { getElementById: (id) => (id === 'product-service-row' ? el : null) };
    let seen = null;
    const ok = method(PDP_SRC, 'renderServiceRow', {}, { document: doc, ServiceRow: { mount: async (e, o) => { seen = o; return { shown: true, facts: [], reason: 'ok' }; } } });
    await ok({ delivery_estimate: { label: '1–3 business days NZ-wide' } });
    assert.equal(JSON.stringify(seen), JSON.stringify({ deliveryEstimate: { label: '1–3 business days NZ-wide' } }));
    assert.equal(el.dataset.serviceRow, 'ok');
    const missing = method(PDP_SRC, 'renderServiceRow', {}, { document: doc });
    await missing({});
    assert.equal(el.hidden, true);
    assert.equal(el.dataset.serviceRow, 'missing', 'module absent ⇒ hidden AND says so');
    assert.match(stripComments(PDP_SRC), /this\.renderServiceRow\(info\);/);
});
