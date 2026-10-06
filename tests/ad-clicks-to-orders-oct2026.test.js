/**
 * Ad clicks into orders (Oct 2026) — ERR-302
 * ==========================================
 * Backend handoff `backend-docs/inbox/ad-clicks-to-orders-FE-handoff-oct2026.md`.
 * This file covers the items built in this session's share of it:
 *
 *   §4  Guest cart reminder opt-in — on /cart (new) and checkout, switched ON.
 *   §6  "See our reviews on Google" in the footer (href validated).
 *   §7  Google Ads dynamic-remarketing events: view_item / add_to_cart /
 *       purchase carrying items [{ id: <SKU verbatim>, google_business_vertical }].
 *
 * WHY §7 EXISTS: the Ads account's Product viewers / Cart abandoners / Past
 * buyers audiences were all 0 while All visitors held ~2,300. Every ecommerce
 * event we sent was GA4-scoped or a labelled `conversion`; the Ads tag never
 * received the event NAMES those audiences key on.
 *
 * Run: node --test tests/ad-clicks-to-orders-oct2026.test.js
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

/** Balanced `{ … }` block starting at the first `{` after `marker`. */
function blockAfter(src, marker) {
    const start = src.indexOf(marker);
    assert.ok(start >= 0, `could not locate ${marker}`);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`unbalanced block after ${marker}`);
}

const plain = (v) => JSON.parse(JSON.stringify(v));

// ═══════════════════════════════════════════════════════════════════════════
// §7 Ads remarketing
// ═══════════════════════════════════════════════════════════════════════════

function loadGtag() {
    const calls = [];
    const ctx = {
        document: { head: { appendChild() {} }, documentElement: { appendChild() {} }, createElement: () => ({}) },
        localStorage: { getItem: () => null, setItem() {} },
        console,
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(read('js/gtag.js'), ctx, { filename: 'gtag.js' });
    ctx.gtag = (...args) => { calls.push(plain(args)); };
    return { ctx, calls, rm: ctx.AdsRemarketing, ads: ctx.AdsConversions };
}

test('§7 view_item goes to the Ads TAG only, with the SKU verbatim', () => {
    const { calls, rm } = loadGtag();
    const r = rm.event('view_item', [{ sku: ' GGI690KCMY ' }]);
    assert.deepEqual(plain(r), { sent: true, count: 1 });
    assert.deepEqual(calls, [['event', 'view_item', {
        send_to: 'AW-18032498762',
        items: [{ id: 'GGI690KCMY', google_business_vertical: 'retail' }],
    }]]);
});

test('§7 SKU case is NEVER changed — it must equal Merchant Center <g:id>', () => {
    const { calls, rm } = loadGtag();
    rm.event('view_item', ['c564xlCMY']);
    assert.equal(calls[0][2].items[0].id, 'c564xlCMY');
});

test('§7 send_to is never a GA4 property and never a conversion label', () => {
    const { calls, rm } = loadGtag();
    for (const name of ['view_item', 'add_to_cart', 'purchase']) rm.event(name, ['X1']);
    assert.equal(calls.length, 3);
    for (const c of calls) {
        assert.equal(c[2].send_to, 'AW-18032498762', `${c[1]} must be Ads-tag scoped`);
        assert.doesNotMatch(c[2].send_to, /^G-|\//);
    }
});

test('§7 nothing is sent without a SKU, and the return says why (loud fail-soft)', () => {
    const { calls, rm } = loadGtag();
    assert.deepEqual(plain(rm.event('view_item', [])), { sent: false, reason: 'no-sku' });
    assert.deepEqual(plain(rm.event('view_item', [{ sku: '  ' }, null, 7])), { sent: false, reason: 'no-sku' });
    assert.deepEqual(plain(rm.event('view_item', undefined)), { sent: false, reason: 'no-sku' });
    assert.deepEqual(plain(rm.event('begin_checkout', ['X1'])), { sent: false, reason: 'unknown-event' });
    assert.equal(calls.length, 0);
});

test('§7 blank SKUs are dropped, the rest kept (multi-line purchase)', () => {
    const { calls, rm } = loadGtag();
    const r = rm.event('purchase', [{ sku: 'A1' }, { sku: '' }, { sku: 'B2', quantity: 3 }]);
    assert.deepEqual(plain(r), { sent: true, count: 2 });
    assert.deepEqual(calls[0][2].items.map((i) => i.id), ['A1', 'B2']);
});

test('§7 a throwing gtag never escapes into the page', () => {
    const { ctx, rm } = loadGtag();
    ctx.gtag = () => { throw new Error('boom'); };
    assert.deepEqual(plain(rm.event('view_item', ['A1'])), { sent: false, reason: 'threw' });
});

test('§7 add_to_cart: the conversion stays AND the remarketing event follows, same SKU', () => {
    const { calls, ads } = loadGtag();
    const r = ads.addToCart({ product: { sku: 'GLC3333M' }, quantity: 2, price_snapshot: 10 }, { priorQuantity: 0, requestedQuantity: 2 });
    assert.equal(r.sent, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][1], 'conversion');
    assert.equal(calls[0][2].send_to, 'AW-18032498762/e3c8CI2D3dwcEMqwyJZD');
    assert.deepEqual(calls[1], ['event', 'add_to_cart', {
        send_to: 'AW-18032498762',
        items: [{ id: 'GLC3333M', google_business_vertical: 'retail' }],
    }]);
});

test('§7 add_to_cart: a refused add (no SKU) sends neither', () => {
    const { calls, ads } = loadGtag();
    ads.addToCart({ product: {} }, {});
    assert.equal(calls.length, 0);
});

/** markConversion() run with the REAL AdsRemarketing from gtag.js. */
function runMarkConversion(orderData, store = {}) {
    const { calls, rm } = loadGtag();
    const src = read('js/order-confirmation-page.js');
    const body = blockAfter(src, '        markConversion() {');
    const inner = body.slice(body.indexOf('{') + 1, -1);
    const fn = new Function('localStorage', 'gtag', 'AdsRemarketing', 'JSON', `return function () {${inner}};`)(
        { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
        (...a) => calls.push(plain(a)), rm, JSON);
    const result = fn.call({ orderData, _conversionFired: false, _paymentSucceeded: true });
    return { result, calls };
}

test('§7 purchase: conversion keeps label/value/transaction_id and gains items; purchase event follows', () => {
    const order = { orderNumber: '2026100201', total: 88.5, items: [{ sku: 'G288BK', quantity: 2 }, { sku: 'G288C', quantity: 1 }] };
    const { result, calls } = runMarkConversion(order);
    assert.equal(result, true);
    const conv = calls.find((c) => c[1] === 'conversion');
    assert.equal(conv[2].send_to, 'AW-18032498762/W1laCPGzpJQcEMqwyJZD');
    assert.equal(conv[2].value, 88.5);
    assert.equal(conv[2].transaction_id, '2026100201');
    assert.deepEqual(conv[2].items.map((i) => i.id), ['G288BK', 'G288C']);
    const purchase = calls.find((c) => c[1] === 'purchase');
    assert.deepEqual(purchase[2], {
        send_to: 'AW-18032498762',
        items: [{ id: 'G288BK', google_business_vertical: 'retail' }, { id: 'G288C', google_business_vertical: 'retail' }],
    });
});

test('§7 purchase: a reloaded receipt sends NEITHER again (shares the three guards)', () => {
    const store = {};
    const order = { orderNumber: 'R-1', total: 5, items: [{ sku: 'A1' }] };
    assert.equal(runMarkConversion(order, store).calls.length, 2);
    const again = runMarkConversion(order, store);
    assert.equal(again.result, false);
    assert.equal(again.calls.length, 0);
});

test('§7 purchase: an order with no SKUs still records the conversion, with no items key', () => {
    const { calls } = runMarkConversion({ orderNumber: 'R-2', total: 5, items: [{}] });
    const conv = calls.find((c) => c[1] === 'conversion');
    assert.ok(conv, 'the money conversion must never depend on SKUs');
    assert.equal('items' in conv[2], false);
    assert.equal(calls.some((c) => c[1] === 'purchase'), false);
});

test('§7 PDP view_item is enrolled: after UetTag.viewItem, inside the GA4 + test-product gate, on ga4.sent', () => {
    const pdp = stripComments(read('js/product-detail-page.js'));
    const gate = blockAfter(pdp, "if (typeof Ga4Ecommerce !== 'undefined' && !this._isTestProduct(this.product))");
    const uet = gate.indexOf('UetTag.viewItem(this.product, ga4)');
    const ads = gate.indexOf("AdsRemarketing.event('view_item', [this.product])");
    assert.ok(uet > 0, 'UET twin still there');
    assert.ok(ads > uet, 'Ads view_item must sit inside the gate, after the UET twin');
    assert.match(gate, /ga4 && ga4\.sent && typeof AdsRemarketing !== 'undefined'/);
});

test('§7 gtag.js is loaded on every page that fires an Ads remarketing event (enrolment)', () => {
    for (const page of ['html/product/index.html', 'html/order-confirmation.html', 'html/cart.html', 'html/shop.html']) {
        assert.match(read(page), /\/js\/gtag\.js\?v=/, `${page} must load gtag.js`);
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// §6 Google reviews link
// ═══════════════════════════════════════════════════════════════════════════

function loadTrustStats() {
    const src = read('js/utils.js');
    const block = blockAfter(src, 'const TrustStats = {');
    const ctx = { URL, Date, JSON, Number, sessionStorage: { getItem: () => null, setItem() {} } };
    vm.createContext(ctx);
    vm.runInContext(`${block}; this.TrustStats = TrustStats;`, ctx);
    return ctx.TrustStats;
}

test('§6 googleReviewsUrl accepts the live URL shape and Google hosts only', () => {
    const T = loadTrustStats();
    const live = 'https://www.google.com/maps/search/?api=1&query=Office%20Consumables%20Ltd&query_place_id=ChIJ8bGI52pBDW0RIf8Y7CddGQk';
    assert.equal(T.googleReviewsUrl({ google_reviews_url: live }), live);
    assert.ok(T.googleReviewsUrl({ google_reviews_url: 'https://search.google.com/local/reviews?placeid=x' }));
    assert.ok(T.googleReviewsUrl({ google_reviews_url: 'https://maps.google.co.nz/?cid=1' }));
});

test('§6 googleReviewsUrl refuses everything else (trust boundary)', () => {
    const T = loadTrustStats();
    for (const bad of [
        'javascript:alert(1)', 'http://www.google.com/maps', 'https://google.com.evil.example/x',
        'https://evilgoogle.com/', 'https://user:pw@www.google.com/', 'https://www.google.com.au/', '', '   ', 'not a url',
    ]) {
        assert.equal(T.googleReviewsUrl({ google_reviews_url: bad }), null, bad);
    }
    assert.equal(T.googleReviewsUrl(null), null);
    assert.equal(T.googleReviewsUrl({}), null);
    assert.equal(T.googleReviewsUrl({ google_reviews_url: 42 }), null);
});

test('§6 footer link: hidden by default, new tab, noopener, plain text — no stars, no count', () => {
    const footer = read('js/footer.js');
    const p = footer.match(/<p class="footer-reviews"[\s\S]*?<\/p>/)[0];
    assert.match(p, /id="footer-google-reviews"/);
    assert.match(p, / hidden>/);
    assert.match(p, /target="_blank"/);
    assert.match(p, /rel="noopener noreferrer"/);
    assert.match(p, />See our reviews on Google</);
    assert.doesNotMatch(p, /href=/, 'the href comes only from the API');
    assert.doesNotMatch(p, /★|\d\.\d|stars?|reviews? \(/i);
});

test('§6 footer renderer takes the href ONLY through googleReviewsUrl, and marks absence', () => {
    const code = stripComments(read('js/footer.js'));
    const fn = blockAfter(code, 'async function renderGoogleReviewsLink()');
    assert.match(fn, /TrustStats\.raw\(\)/, 'shared cached read, no new request');
    assert.match(fn, /TrustStats\.googleReviewsUrl\(/);
    assert.match(fn, /dataset\.reviewsLink = 'absent'/);
    assert.doesNotMatch(fn, /innerHTML/);
    assert.match(code, /renderTrustStats\(\);\s*renderGoogleReviewsLink\(\);/);
});

/** Brace depth (comments/strings stripped) at the first occurrence of `marker`. */
function depthAt(code, marker) {
    const at = code.indexOf(marker);
    assert.ok(at >= 0, `missing ${marker}`);
    const src = code.slice(0, at).replace(/`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, '""');
    let d = 0;
    for (const ch of src) { if (ch === '{') d++; else if (ch === '}') d--; }
    return d;
}

test('§6 renderGoogleReviewsLink is declared in the SAME scope as renderTrustStats (prod ReferenceError, 2026-10-02)', () => {
    // caea73d shipped it nested inside syncFooterAccordions(): every text-level
    // assertion above passed while initFooter() threw "renderGoogleReviewsLink is
    // not defined" on production. Scope is what the caller can see; test it.
    const code = stripComments(read('js/footer.js'));
    assert.equal(depthAt(code, 'async function renderGoogleReviewsLink()'), depthAt(code, 'async function renderTrustStats()'));
    assert.equal(depthAt(code, 'function syncFooterAccordions()'), depthAt(code, 'async function renderTrustStats()'));
});

test('§4 checkout status line sits AFTER the label, not inside it', () => {
    const html = read('html/checkout.html');
    const label = html.indexOf('id="guest-cart-email-optin"');
    const close = html.indexOf('</label>', label);
    assert.ok(close > label && close < html.indexOf('id="guest-cart-email-status"'));
});

/** Run renderGoogleReviewsLink against a fake DOM. */
async function runFooterLink(trust) {
    const code = read('js/footer.js');
    const fn = blockAfter(code, 'async function renderGoogleReviewsLink()');
    const a = { href: '' };
    const el = { hidden: true, dataset: {}, querySelector: () => a };
    const T = loadTrustStats();
    T.raw = async () => trust;
    const run = new Function('document', 'TrustStats', `${fn}; return renderGoogleReviewsLink();`);
    await run({ getElementById: () => el }, T);
    return { el, a };
}

test('§6 footer link renders with the API URL; absent/invalid URL stays hidden + "absent"', async () => {
    const ok = await runFooterLink({ organization: { google_reviews_url: 'https://www.google.com/maps/search/?api=1&query=x' } });
    assert.equal(ok.el.hidden, false);
    assert.equal(ok.el.dataset.reviewsLink, 'present');
    assert.match(ok.a.href, /^https:\/\/www\.google\.com\/maps/);
    for (const trust of [{}, { organization: {} }, { organization: { google_reviews_url: 'javascript:alert(1)' } }]) {
        const r = await runFooterLink(trust);
        assert.equal(r.el.hidden, true);
        assert.equal(r.el.dataset.reviewsLink, 'absent');
        assert.equal(r.a.href, '');
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// §4 Guest cart reminder
// ═══════════════════════════════════════════════════════════════════════════

test('§4 /cart markup: hidden wrapper, UNTICKED box, exact label, email field, live status', () => {
    const html = read('html/cart.html');
    const block = html.match(/<div class="cart-optin" id="cart-guest-email"[\s\S]*?<\/div>/)[0];
    assert.match(block, /data-testid="cart-guest-email" hidden>/);
    const box = block.match(/<input type="checkbox"[^>]*>/)[0];
    assert.doesNotMatch(box, /checked/, 'NZ UEMA: never pre-ticked');
    assert.match(block, /<span>Email me a copy of my cart if I don't finish<\/span>/);
    assert.match(block, /<input type="email" id="cart-guest-email-input"[^>]*autocomplete="email"/);
    assert.match(block, /<label class="visually-hidden" for="cart-guest-email-input">/);
    assert.match(block, /id="cart-guest-email-status" role="status" aria-live="polite" hidden/);
    // Under the checkout button, never above it (the CTA-lift rule in cart.html).
    assert.ok(html.indexOf('id="checkout-btn"') < html.indexOf('id="cart-guest-email"'));
});

test('§4 both pages bind through the ONE owner', () => {
    assert.match(stripComments(read('js/cart-page.js')), /GuestCartEmail\.bind\(\{\s*root: document\.getElementById\('cart-guest-email'\)/);
    assert.match(stripComments(read('js/checkout-page.js')), /GuestCartEmail\.bind\(\{\s*root: document\.getElementById\('guest-cart-email-optin'\)/);
    for (const page of ['html/cart.html', 'html/checkout.html']) {
        const html = read(page);
        assert.ok(html.indexOf('/js/cart.js') > 0 && html.indexOf('/js/cart.js') < html.indexOf(page.includes('cart.html') ? '/js/cart-page.js' : '/js/checkout-page.js'),
            `${page}: cart.js (owner) must load before the page controller`);
    }
});

function loadGuestCartEmail({ flag = true, authed = false, guestContact, withdraw } = {}) {
    const block = blockAfter(read('js/cart.js'), 'const GuestCartEmail = {');
    const sent = [];
    const log = [];   // every call in ORDER: 'in:<email>' / 'out'
    const ctx = {
        Config: { DARK_FEATURES: { guestCartEmail: flag } },
        Auth: { readyPromise: Promise.resolve(), isAuthenticated: () => authed },
        API: {
            guestContact: async (email) => { sent.push(email); log.push(`in:${email}`); return guestContact ? guestContact(email) : { ok: true }; },
            withdrawGuestContact: async () => { log.push('out'); return withdraw ? withdraw() : { ok: true }; },
        },
        Promise,
    };
    vm.createContext(ctx);
    vm.runInContext(`${block}; this.GuestCartEmail = GuestCartEmail;`, ctx);
    return { G: ctx.GuestCartEmail, sent, log };
}

function fakeEls({ checked = false, value = '', valid = true } = {}) {
    const handlers = {};
    const on = (name) => (type, fn) => { handlers[`${name}:${type}`] = fn; };
    const root = { hidden: true, dataset: {} };
    const box = { checked, addEventListener: on('box') };
    const email = { value, checkValidity: () => valid, addEventListener: on('email') };
    const status = { hidden: true, textContent: '' };
    return { root, box, email, status, fire: (k) => handlers[k]() };
}

test('§4 flag off / no markup / signed-in ⇒ not bound, box stays hidden', async () => {
    let e = fakeEls();
    assert.deepEqual(plain(await loadGuestCartEmail({ flag: false }).G.bind(e)), { bound: false, reason: 'flag-off' });
    assert.equal(e.root.hidden, true);
    assert.deepEqual(plain(await loadGuestCartEmail().G.bind({ root: null })), { bound: false, reason: 'no-markup' });
    e = fakeEls();
    assert.deepEqual(plain(await loadGuestCartEmail({ authed: true }).G.bind(e)), { bound: false, reason: 'signed-in' });
    assert.equal(e.root.hidden, true);
});

test('§4 guest: shown UNTICKED even if the browser restored a tick; nothing sent unticked', async () => {
    const { G, sent } = loadGuestCartEmail();
    const e = fakeEls({ checked: true, value: 'a@b.co.nz' });
    assert.deepEqual(plain(await G.bind(e)), { bound: true });
    assert.equal(e.root.hidden, false);
    assert.equal(e.box.checked, false, 'a form-restored tick is not consent');
    await e.fire('email:blur');
    assert.deepEqual(sent, []);
});

test('§4 tick + valid email ⇒ one call, "sent", shopper told; re-blur does not resend', async () => {
    const { G, sent } = loadGuestCartEmail();
    const e = fakeEls({ value: ' a@b.co.nz ' });
    await G.bind(e);
    e.box.checked = true;
    await e.fire('box:change');
    await e.fire('email:blur');
    assert.deepEqual(sent, ['a@b.co.nz']);
    assert.equal(e.root.dataset.guestContact, 'sent');
    assert.equal(e.status.hidden, false);
    assert.match(e.status.textContent, /a@b\.co\.nz/);
    assert.match(e.status.textContent, /unsubscribe/);
});

test('§4 ticked without a valid email ⇒ asks for one, sends nothing', async () => {
    const { G, sent } = loadGuestCartEmail();
    const e = fakeEls({ value: 'nope', valid: false });
    await G.bind(e);
    e.box.checked = true;
    await e.fire('box:change');
    assert.deepEqual(sent, []);
    assert.match(e.status.textContent, /Enter your email/);
});

for (const [label, guestContact] of [
    ['an ok:false envelope (RATE_LIMITED)', () => ({ ok: false, code: 'RATE_LIMITED' })],
    ['a thrown 400 GUEST_SESSION_MISMATCH', () => { const e = new Error('mismatch'); e.code = 'GUEST_SESSION_MISMATCH'; throw e; }],
]) {
    test(`§4 ${label} ⇒ "failed", shopper told, and a retry is allowed`, async () => {
        let n = 0;
        const { G, sent } = loadGuestCartEmail({ guestContact: (em) => (++n === 1 ? guestContact(em) : { ok: true }) });
        const e = fakeEls({ value: 'a@b.co.nz' });
        await G.bind(e);
        e.box.checked = true;
        await e.fire('box:change');
        assert.equal(e.root.dataset.guestContact, 'failed');
        assert.match(e.status.textContent, /couldn't save/);
        await e.fire('email:blur');
        assert.equal(sent.length, 2, 'failure must not latch');
        assert.equal(e.root.dataset.guestContact, 'sent');
    });
}

test('§4 unticking after a send WITHDRAWS it server-side (BF-099), and says so', async () => {
    const { G, log } = loadGuestCartEmail();
    const e = fakeEls({ value: 'a@b.co.nz' });
    await G.bind(e);
    e.box.checked = true;
    await e.fire('box:change');
    e.box.checked = false;
    await e.fire('box:change');
    assert.deepEqual(log, ['in:a@b.co.nz', 'out']);
    assert.equal(e.root.dataset.guestContact, 'withdrawn');
    assert.match(e.status.textContent, /won't email you/);
    await e.fire('email:blur');
    assert.deepEqual(log, ['in:a@b.co.nz', 'out'], 'unticked + nothing on file ⇒ no further calls');
    e.box.checked = true;
    await e.fire('box:change');
    assert.deepEqual(log, ['in:a@b.co.nz', 'out', 'in:a@b.co.nz'], 're-ticking opts in again');
});

test('§4 unticking with NOTHING sent makes no call (no withdrawal of a consent never given)', async () => {
    const { G, log } = loadGuestCartEmail();
    const e = fakeEls({ value: 'a@b.co.nz' });
    await G.bind(e);
    e.box.checked = false;
    await e.fire('box:change');
    assert.deepEqual(log, []);
    assert.equal(e.status.hidden, true);
});

for (const [label, withdraw] of [
    ['an ok:false envelope', () => ({ ok: false, code: 'INTERNAL_ERROR' })],
    ['a thrown 400 GUEST_SESSION_MISMATCH', () => { const e = new Error('mismatch'); e.code = 'GUEST_SESSION_MISMATCH'; throw e; }],
]) {
    test(`§4 a failed withdrawal (${label}) is LOUD: still on file, shopper told, retry allowed`, async () => {
        let n = 0;
        const { G, log } = loadGuestCartEmail({ withdraw: () => (++n === 1 ? withdraw() : { ok: true }) });
        const e = fakeEls({ value: 'a@b.co.nz' });
        await G.bind(e);
        e.box.checked = true;
        await e.fire('box:change');
        e.box.checked = false;
        await e.fire('box:change');
        assert.equal(e.root.dataset.guestContact, 'withdraw-failed');
        assert.match(e.status.textContent, /couldn't remove your address/);
        assert.doesNotMatch(e.status.textContent, /won't email/, 'never claim a withdrawal the server refused');
        await e.fire('email:blur');
        assert.deepEqual(log, ['in:a@b.co.nz', 'out', 'out'], 'still on file ⇒ the next event retries');
        assert.equal(e.root.dataset.guestContact, 'withdrawn');
    });
}

test('§4 a fast tick → untick lands IN ORDER: the opt-in can never arrive after the withdrawal', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { G, log } = loadGuestCartEmail({ guestContact: async () => { await gate; return { ok: true }; } });
    const e = fakeEls({ value: 'a@b.co.nz' });
    await G.bind(e);
    e.box.checked = true;
    const first = e.fire('box:change');           // opt-in in flight
    e.box.checked = false;
    const second = e.fire('box:change');          // untick while it is still in flight
    release();
    await first; await second;
    assert.deepEqual(log, ['in:a@b.co.nz', 'out']);
    assert.equal(e.root.dataset.guestContact, 'withdrawn');
});

test('§4 API.withdrawGuestContact: same route, same session store, consent:false and NO email', () => {
    const api = stripComments(read('js/api.js'));
    const fn = blockAfter(api, 'async withdrawGuestContact()');
    assert.match(fn, /const guestSessionId = this\.getGuestSessionId\(\)/);
    assert.match(fn, /this\.post\('\/api\/cart\/guest-contact', \{ guest_session_id: guestSessionId, consent: false \}\)/);
    assert.doesNotMatch(fn, /email/);
});

test('§4 API.guestContact: body id and X-Guest-Session come from the same store', () => {
    const api = stripComments(read('js/api.js'));
    const fn = blockAfter(api, 'async guestContact(email)');
    assert.match(fn, /const guestSessionId = this\.getGuestSessionId\(\)/);
    assert.match(fn, /guest_session_id: guestSessionId, email, consent: true/);
    assert.match(api, /const guestSession = this\.getGuestSessionId\(\);[\s\S]{0,120}headers\['X-Guest-Session'\] = guestSession/);
});

test('§4 copy never promises what we cannot do', () => {
    const block = stripComments(blockAfter(read('js/cart.js'), 'const GuestCartEmail = {'));
    assert.doesNotMatch(block, /guarantee|never miss|free gift|discount/i);
});
