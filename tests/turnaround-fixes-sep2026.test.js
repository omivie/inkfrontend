/**
 * ERR-296 — the backend's turnaround doc (`backend-docs/inbox/fe-turnaround-fixes-sep2026.md`,
 * 2026-09-28): the items still open after ERR-290/293/294, built and pinned here.
 *
 * Every section that can EXECUTES the shipped code (import / vm / require) — a grep
 * proves a spelling, not a branch. Grep-only sections run on comment-stripped source
 * (tests/helpers/strip-comments.js, ERR-253) and say so.
 *
 *   §1  middleware: a failed bot prerender answers 503 + Retry-After, never the shell (#4)
 *   §2  printer finder: plain "couldn't match" + the no-printer banner (#7); alias link (#6)
 *   §3  header typeahead renders the regional-alias note (ERR-294 "not built")
 *   §4  PrinterName hyphenates Brother ADS (#9)
 *   §5  order confirmation: business_account_offer tri-state (#11), one-field sign-up (#14)
 *   §6  ex-GST for ACTIVE business accounts only (#12)
 *   §7  /value-packs brand chips (#17)
 *   §8  Buy again → /cart?add= (#18)
 *   §9  cart P2: guest coupon gate, "Total before shipping", Turnstile capped at the click
 *   §10 CSS: 12px floor on cards, 120px cross-sell image, phone toast at top, Filter & Sort
 *   §11 fonts: no render-blocking @import; every page linking base.css links the fonts
 *   §12 quote links (#13) and sign-in rewards copy (#15)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const Security = {
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    escapeAttr: (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'),
};
const plain = (x) => JSON.parse(JSON.stringify(x));

/** Brace-matched source of `head … { … }` starting at the first occurrence of `head`. */
function lift(src, head) {
    // The DEFINITION (`head {`), not a call site that happens to spell the same.
    let start = src.indexOf(`${head} {`);
    if (start < 0) start = src.indexOf(head);
    assert.ok(start >= 0, `${head} must exist in the shipped source`);
    let i = src.indexOf('(', start), pd = 0;
    for (; i < src.length; i++) {
        if (src[i] === '(') pd++;
        else if (src[i] === ')') { pd--; if (!pd) break; }
    }
    let depth = 0;
    for (i = src.indexOf('{', i); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (!depth) return src.slice(start, i + 1); }
    }
    throw new Error(`unbalanced ${head}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// §1 middleware — imported and executed
// ═════════════════════════════════════════════════════════════════════════════

const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const HUMAN = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
const SITE = 'https://www.inkcartridges.co.nz';
const PRINTER_URL = `${SITE}/shop?brand=brother&printer_slug=brother-hl-l2375dw`;

let mwFn = null, mwFile = null;
async function middleware() {
    if (mwFn) return mwFn;
    mwFile = path.join(os.tmpdir(), `ic-mw-turnaround-${process.pid}-${Date.now()}.mjs`);
    fs.writeFileSync(mwFile, read('middleware.js'));
    mwFn = (await import(`file://${mwFile}`)).default;
    return mwFn;
}
test.after(() => { if (mwFile && fs.existsSync(mwFile)) fs.unlinkSync(mwFile); });

async function runMw(url, backend, ua = GOOGLEBOT) {
    const fn = await middleware();
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (target, init) => { calls.push({ target: String(target), init }); return backend(init); };
    try {
        return { res: await fn({ url, headers: { get: (n) => (String(n).toLowerCase() === 'user-agent' ? ua : null) } }), calls };
    } finally {
        globalThis.fetch = original;
    }
}

function assert503(res, why) {
    assert.ok(res, `${why}: must answer, not fall through to the SPA shell`);
    assert.equal(res.status, 503, why);
    assert.ok(Number(res.headers.get('retry-after')) > 0, `${why}: Retry-After`);
    assert.equal(res.headers.get('cache-control'), 'no-store', `${why}: the edge must never cache an outage`);
}

test('§1 a prerender TIMEOUT answers the bot 503 + Retry-After (was: the SPA shell with a /shop canonical)', async () => {
    const { res, calls } = await runMw(PRINTER_URL, () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    assert.equal(calls.length, 1);
    assert503(res, 'timeout');
});

test('§1 the prerender fetch carries a timeout signal (without one, "timeout" never happens)', async () => {
    const { calls } = await runMw(PRINTER_URL, () => new Response('<html></html>', { status: 200 }));
    const signal = calls[0].init.signal;
    assert.ok(signal && typeof signal.aborted === 'boolean', 'init.signal must be an AbortSignal');
    const src = stripComments(read('middleware.js'));
    const ms = Number((src.match(/PRERENDER_TIMEOUT_MS\s*=\s*(\d+)/) || [])[1]);
    assert.ok(ms >= 4000 && ms <= 15000, `timeout ${ms}ms: above the measured 3.6s cold prerender, under the edge's 25s`);
});

test('§1 a backend 5xx and a network error both answer 503', async () => {
    for (const status of [500, 502, 503, 504]) {
        const { res } = await runMw(PRINTER_URL, () => new Response('down', { status }));
        assert503(res, `backend ${status}`);
    }
    const { res } = await runMw(`${SITE}/products/x/GLC3329XLBK`, () => { throw new TypeError('fetch failed'); });
    assert503(res, 'network error on a PDP');
});

test('§1 a 404 is an ANSWER, not an outage — still falls through to the SPA', async () => {
    const { res } = await runMw(PRINTER_URL, () => new Response('nope', { status: 404 }));
    assert.equal(res, undefined);
});

test('§1 negative controls: a 200 still renders as 200; a human never reaches the prerender', async () => {
    const ok = await runMw(PRINTER_URL, () => new Response('<html>stub</html>', { status: 200 }));
    assert.equal(ok.res.status, 200);
    const human = await runMw(PRINTER_URL, () => { throw new Error('must not fetch'); }, HUMAN);
    assert.equal(human.res, undefined);
    assert.equal(human.calls.length, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// §2 printer finder + alias link — shop-page.js executed
// ═════════════════════════════════════════════════════════════════════════════

const UTILS_SRC = read('js/utils.js');
const SHOP_SRC = read('js/shop-page.js');

function shopHelpers(legalConfig) {
    const doc = {
        addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
        createElement() { return { style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }; },
        body: { appendChild() {} }, documentElement: { style: {} }, cookie: '',
    };
    const sandbox = {
        console, URL, URLSearchParams, Map, Set, Promise, JSON, Date, RegExp, Object, Array, String, Number, Boolean, Error, Math,
        parseInt, parseFloat, isNaN, setTimeout, clearTimeout, document: doc, Security,
        location: { search: '', pathname: '/search', href: 'http://localhost/search' },
        history: { replaceState() {}, pushState() {} },
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        navigator: { userAgent: 'node' }, DebugLog: { log() {}, warn() {}, error() {} },
        Config: { API_URL: 'https://backend.test', settings: {}, getSetting(k, f) { return f; } },
        LegalConfig: legalConfig,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(UTILS_SRC, ctx, { filename: 'utils.js' });
    vm.runInContext(SHOP_SRC, ctx, { filename: 'shop-page.js' });
    return sandbox.window._searchParityHelpers;
}

// Measured shape: /smart for "Brother HL-L2350DW" (no NZ printer) returns rows, no matched_printer.
const HL_L2350 = { products: [{ sku: 'CTN2345' }, { sku: 'CDR2315' }], matched_printer: null };

test('§2 the no-printer banner fires only for the FINDER\'s own search that matched no printer', () => {
    const H = shopHelpers();
    assert.equal(H.finderSearchWithoutPrinter(HL_L2350, '?q=Brother+HL-L2350DW&from=finder'), true);
    assert.equal(H.finderSearchWithoutPrinter(HL_L2350, '?q=Brother+HL-L2350DW'), false, 'a typed search carries no printer claim');
    assert.equal(H.finderSearchWithoutPrinter({ ...HL_L2350, matched_printer: { name: 'Brother HL-L2375DW' } }, '?from=finder'), false,
        'a matched printer means the rows DO fit');
    assert.equal(H.finderSearchWithoutPrinter({ products: [] }, '?from=finder'), false, 'no rows ⇒ zero-results page, not a caution');
    assert.equal(H.finderSearchWithoutPrinter(null, '?from=finder'), false);
});

test('§2 finder help: /quote (photo) + the phone from LegalConfig, with a literal fallback', () => {
    const withCfg = shopHelpers({ phoneDisplay: '09 000 0000', phoneE164: '+6490000000' }).finderHelpHtml();
    assert.match(withCfg, /href="\/quote"/);
    assert.match(withCfg, /href="tel:\+6490000000"/);
    assert.match(withCfg, /09 000 0000/);
    const fallback = shopHelpers(undefined).finderHelpHtml();
    assert.match(fallback, /tel:\+64274740115/);
});

test('§2 the shipped copy: "couldn\'t match that printer", the banner, and the finder form marker (grep, comment-stripped)', () => {
    const code = stripComments(SHOP_SRC);
    assert.match(code, /We couldn't match that printer\.<\/strong> Check the code printed on your old cartridge/);
    assert.ok(!/Press Find to search every product/.test(code), 'the old copy invited a search that lists non-fitting cartridges');
    assert.match(code, /These match your words, not your printer\./);
    assert.match(code, /finderSearchWithoutPrinter\(smartData, window\.location\.search\)/);
    const html = read('html/shop.html');
    const form = html.slice(html.indexOf('id="landing-printer-search-form"'), html.indexOf('</form>', html.indexOf('id="landing-printer-search-form"')));
    assert.match(form, /<input type="hidden" name="from" value="finder">/);
});

test('§2 the finder asks BOTH separator spellings (/api/printers/search is separator-intolerant)', () => {
    const H = shopHelpers();
    assert.deepEqual(plain(H.finderSpellings('Brother MFC-J5930DW')), ['Brother MFC-J5930DW', 'Brother MFC J5930DW']);
    assert.deepEqual(plain(H.finderSpellings('  Epson XP 2100 ')), ['Epson XP 2100'], 'no hyphen ⇒ one request');
    const merged = H.mergePrinterAnswers([
        { ok: true, data: [] },
        { ok: true, data: [{ slug: 'brother-mfc-j5930dw', full_name: 'Brother MFC J5930DW' }] },
    ]);
    assert.equal(merged.length, 1, 'the measured case: the hyphenated spelling returns [], the spaced one finds it');
    const order = H.mergePrinterAnswers([
        { ok: true, data: [{ slug: 'a' }, { slug: 'b' }] }, null, { ok: false }, { ok: true, data: [{ slug: 'b' }, { slug: 'c' }] },
    ]).map((p) => p.slug);
    assert.deepEqual(plain(order), ['a', 'b', 'c'], 'raw spelling first, deduped, failures add nothing');
    const code = stripComments(SHOP_SRC);
    assert.match(lift(code, 'renderLandingPrinterSearch(show)'), /finderSpellings\(q\)\.map\(\(s\) => API\.searchPrinters\(s\)/);
});

test('§2 the alias link reads "Search PG-640" (turnaround doc #6), built from search_query', () => {
    const code = stripComments(SHOP_SRC);
    assert.match(code, /href="\/search\?q=\$\{encodeURIComponent\(alias\.searchQuery\)\}">Search \$\{Security\.escapeHtml\(toLabel\)\}<\/a>/);
    assert.ok(!/See every \$\{/.test(code));
});

// ═════════════════════════════════════════════════════════════════════════════
// §3 header typeahead alias (grep — renderResults needs a live DOM instance)
// ═════════════════════════════════════════════════════════════════════════════

test('§3 the typeahead keeps alias_suggestion and renders its note + a link to the NZ code', () => {
    const code = stripComments(read('js/search.js'));
    assert.match(code, /alias_suggestion: data\.alias_suggestion \|\| null/);
    const noResults = code.slice(code.indexOf('if (!list.length) {'), code.indexOf('const dymHTML'));
    assert.match(noResults, /alias\.note/);
    assert.match(noResults, /\/search\?q=\$\{encodeURIComponent\(alias\.search_query\.trim\(\)\)\}/);
    assert.ok(noResults.indexOf('matchedHref') < noResults.indexOf('alias.note'), 'a matched printer still wins');
});

// ═════════════════════════════════════════════════════════════════════════════
// §4 PrinterName — executed
// ═════════════════════════════════════════════════════════════════════════════

test('§4 Brother ADS hyphenates like HL/MFC/DCP/FAX/PT/QL; hyphenated and non-listed prefixes are left alone', () => {
    const { PrinterName } = require('../inkcartridges/js/utils.js');
    assert.equal(PrinterName.display('Brother ADS 2200'), 'Brother ADS-2200');
    assert.equal(PrinterName.display('Brother ADS 1700W'), 'Brother ADS-1700W');
    assert.equal(PrinterName.display('Brother HL L2375DW'), 'Brother HL-L2375DW');
    assert.equal(PrinterName.display('Brother HL-L2375DW'), 'Brother HL-L2375DW', 'already hyphenated');
    assert.equal(PrinterName.display('Brother TD 4000'), 'Brother TD 4000', 'TD is not in the backend rule');
    assert.equal(PrinterName.display('Brother ADS SCANNER'), 'Brother ADS Scanner'.replace('Scanner', 'SCANNER'), 'no model code ⇒ no hyphen');
});

// ═════════════════════════════════════════════════════════════════════════════
// §5 order confirmation — executed
// ═════════════════════════════════════════════════════════════════════════════

const CONF_SRC = read('js/order-confirmation-page.js');

function confirmationMethods() {
    const sandbox = { Security, storageUrl: (u) => u, BrandSource: undefined, OrderTotals: undefined };
    vm.createContext(sandbox);
    const src = ['transformAPIOrder(apiOrder)', 'accountFormError(password, termsChecked)', 'signUpOutcome(data, error)']
        .map((h) => lift(CONF_SRC, h)).join(',\n');
    vm.runInContext(`globalThis.P = { ${src} };`, sandbox);
    return sandbox.P;
}

test('§5 business_account_offer is tri-state: true / false as sent, ABSENT ⇒ null (never "no")', () => {
    const P = confirmationMethods();
    assert.equal(P.transformAPIOrder({ order_number: '1', business_account_offer: true }).businessAccountOffer, true);
    assert.equal(P.transformAPIOrder({ order_number: '1', business_account_offer: false }).businessAccountOffer, false);
    assert.equal(P.transformAPIOrder({ order_number: '1' }).businessAccountOffer, null);
    assert.equal(P.transformAPIOrder({ order_number: '1', business_account_offer: 'yes' }).businessAccountOffer, false, 'only a boolean true');
});

test('§5 the card shows only for an explicit true (render wiring, comment-stripped)', () => {
    const code = stripComments(CONF_SRC);
    assert.match(code, /bizOffer\.hidden = order\.businessAccountOffer !== true;/);
    const html = read('html/order-confirmation.html');
    const card = html.slice(html.indexOf('id="business-account-offer"'), html.indexOf('</div>', html.indexOf('id="business-account-offer"')));
    assert.match(html, /id="business-account-offer" hidden/);
    assert.match(card, /Buying for a business\?/);
    assert.match(card, /monthly invoice, saved printers, one place to reorder/);
    assert.match(card, /href="\/business"/);
});

test('§5 one-field sign-up: an existing email is NOT a success (Supabase\'s fake success, identities: [])', () => {
    const P = confirmationMethods();
    assert.equal(P.signUpOutcome({ user: { identities: [{ id: 'x' }] } }, null).ok, true);
    const fake = P.signUpOutcome({ user: { identities: [] } }, null);
    assert.equal(fake.ok, false);
    assert.equal(fake.exists, true);
    assert.equal(P.signUpOutcome(null, { message: 'User already registered' }).exists, true);
    const other = P.signUpOutcome(null, { message: 'Password is too weak' });
    assert.equal(other.ok, false);
    assert.equal(other.message, 'Password is too weak');
    assert.equal(P.signUpOutcome(null, null).ok, false, 'no user and no error is not a success either');
});

test('§5 one-field sign-up: the register form\'s own two checks (8+ chars, terms)', () => {
    const P = confirmationMethods();
    assert.match(P.accountFormError('short', true), /at least 8/);
    assert.match(P.accountFormError('', true), /at least 8/);
    assert.match(P.accountFormError('longenough', false), /agree/);
    assert.equal(P.accountFormError('longenough', true), '');
});

test('§5 the form uses the ORDER\'s email, is guest-only, and Save My Printer is signed-in only', () => {
    const code = stripComments(CONF_SRC);
    const fn = lift(code, 'renderAccountForm()');
    assert.match(fn, /const email = this\._orderEmail;/);
    assert.match(fn, /if \(!form \|\| !email/, 'no email ⇒ form stays hidden (the register link remains)');
    assert.match(fn, /Auth\.signUp\(email, pw\.value/);
    assert.match(code, /if \(!Auth\.isAuthenticated\(\)\) \{[\s\S]{0,300}ConfirmationPage\.renderAccountForm\(\);[\s\S]{0,80}\} else \{[\s\S]{0,120}save-printer-prompt/);
    const html = read('html/order-confirmation.html');
    assert.match(html, /id="save-printer-prompt" hidden/);
    // Wording per FE master checklist 2026-10-05 item 13 ("Save your order and collect your points").
    assert.match(html, /Create a password to save your order and collect your points\./);
    assert.match(html, /id="confirmation-account-password"[^>]*minlength="8"/);
    // The loyalty claim stays verbatim (tests/mobile-cta-occlusion-sep2026.test.js §5).
    assert.ok(html.includes('1 point for every $1') && html.includes('100 points = $1'));
});

test('§5 Auth.signUp forwards optional metadata as options.data (executed)', async () => {
    const src = read('js/auth.js');
    const body = lift(src, 'async signUp(email, password, metadata)');
    const calls = [];
    const sandbox = { window: { location: { origin: 'https://www.inkcartridges.co.nz' } } };
    vm.createContext(sandbox);
    vm.runInContext(`globalThis.A = { supabase: { auth: { signUp: async (x) => { globalThis.last = x; return { data: {}, error: null }; } } }, ${body} };`, sandbox);
    await sandbox.A.signUp('a@b.co', 'pw123456', { full_name: 'Sam' });
    calls.push(plain(sandbox.last));
    await sandbox.A.signUp('a@b.co', 'pw123456');
    calls.push(plain(sandbox.last));
    assert.deepEqual(calls[0].options.data, { full_name: 'Sam' });
    assert.equal(calls[0].options.emailRedirectTo, 'https://www.inkcartridges.co.nz/account/verify-email');
    assert.equal('data' in calls[1].options, false, 'the old two-argument call is unchanged');
});

// ═════════════════════════════════════════════════════════════════════════════
// §6 ex-GST — executed
// ═════════════════════════════════════════════════════════════════════════════

const API_SRC = read('js/api.js');

function exGstContext(isActive) {
    const sandbox = {
        Config: { settings: { GST_RATE: 0.15 } },
        formatPrice: (n) => `$${n.toFixed(2)}`,
        Business: isActive === undefined ? undefined : { isActive: async () => isActive },
    };
    vm.createContext(sandbox);
    vm.runInContext([lift(API_SRC, 'function calculateGST('), lift(API_SRC, 'function exGstPrice('), lift(API_SRC, 'async function decorateExGst(')].join('\n')
        + '\nglobalThis.exGstPrice = exGstPrice; globalThis.decorateExGst = decorateExGst;', sandbox);
    return sandbox;
}

function fakeRoot(values) {
    const els = values.map((v) => ({ attr: v, hidden: true, textContent: '', getAttribute() { return this.attr; } }));
    return { els, querySelectorAll: () => els };
}

test('§6 exGstPrice = price / 1.15 to the cent; nothing for a missing or zero price', () => {
    const { exGstPrice } = exGstContext();
    assert.equal(exGstPrice(29.49), 25.64);
    assert.equal(exGstPrice('115'), 100);
    assert.equal(exGstPrice(6.99), 6.08);
    for (const bad of [null, undefined, '', 0, -5, 'abc', NaN]) assert.equal(exGstPrice(bad), null, String(bad));
});

test('§6 decorateExGst shows "$X ex GST" ONLY for an active business account', async () => {
    const active = exGstContext(true);
    const root = fakeRoot(['29.49', '']);
    assert.equal(await active.decorateExGst(root), 1);
    assert.equal(root.els[0].textContent, '$25.64 ex GST');
    assert.equal(root.els[0].hidden, false);
    assert.equal(root.els[1].hidden, true, 'no price ⇒ stays hidden');

    for (const [label, ctx] of [['retail', exGstContext(false)], ['no Business module', exGstContext(undefined)]]) {
        const r = fakeRoot(['29.49']);
        assert.equal(await ctx.decorateExGst(r), 0, label);
        assert.equal(r.els[0].hidden, true, label);
    }
    const throwing = exGstContext(true);
    throwing.Business = { isActive: async () => { throw new Error('status down'); } };
    const r = fakeRoot(['29.49']);
    assert.equal(await throwing.decorateExGst(r), 0, 'a failed status read shows retail only');
});

test('§6 wired beside (never inside) #product-price, and under every cart line price', () => {
    const pdpHtml = read('html/product/index.html');
    assert.match(pdpHtml, /<span class="product-info__exgst" id="product-exgst" data-exgst="" hidden><\/span>/);
    const priceSpan = pdpHtml.slice(pdpHtml.indexOf('id="product-price"'), pdpHtml.indexOf('</span></span>', pdpHtml.indexOf('id="product-price"')));
    assert.ok(!priceSpan.includes('exgst'), 'the microdata price stays GST-inclusive retail');
    assert.match(stripComments(read('js/product-detail-page.js')), /exGstEl\.setAttribute\('data-exgst'[\s\S]{0,120}decorateExGst\(exGstEl\.parentElement\)/);
    const cart = stripComments(read('js/cart.js'));
    // Both cells are built by ONE function since ERR-307 (item 14: the unit
    // price follows the quantity's rung), so the span is spelled once and
    // each cell must call it.
    assert.equal((cart.match(/class="cart-item__exgst" data-exgst=/g) || []).length, 1, 'one builder: unitPriceHtml');
    assert.match(cart, /<p class="cart-item__price-mobile">' \+ self\.unitPriceHtml\(item\)/, 'mobile price line');
    assert.match(cart, /<div class="cart-item__price">\\\s*' \+ self\.unitPriceHtml\(item\)/, 'desktop price cell');
    assert.match(cart, /this\.decorateVolumeNudges\(cartItems\);\s*if \(typeof decorateExGst === 'function'\) decorateExGst\(cartItems\);/);
});

// ═════════════════════════════════════════════════════════════════════════════
// §7 /value-packs brand chips — required and executed
// ═════════════════════════════════════════════════════════════════════════════

test('§7 brand chips come from /api/brands show_on_shop rows in sort_order, with "All brands" first', () => {
    global.Security = Security;
    const { ValuePages } = require('../inkcartridges/js/value-pages.js');
    const html = ValuePages.brandChipsHtml([
        { slug: 'hp', name: 'HP', show_on_shop: true, sort_order: 4 },
        { slug: 'brother', name: 'Brother', show_on_shop: true, sort_order: 1 },
        { slug: 'hidden', name: 'Hidden', show_on_shop: false, sort_order: 0 },
        { slug: 'dymo', name: 'Dymo', show_on_shop: true },
    ], 'hp');
    const order = [...html.matchAll(/data-brand="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(order, ['', 'brother', 'hp', 'dymo']);
    assert.match(html, /data-brand="hp" aria-pressed="true"/);
    assert.match(html, /data-brand="" aria-pressed="false">All brands/);
    assert.equal(ValuePages.brandChipsHtml([], ''), '');
    assert.equal(ValuePages.brandChipsHtml(null, ''), '');
});

test('§7 ?brand= accepts a slug shape only', () => {
    const { ValuePages } = require('../inkcartridges/js/value-pages.js');
    assert.equal(ValuePages.brandFromUrl('?brand=fuji-xerox'), 'fuji-xerox');
    assert.equal(ValuePages.brandFromUrl('?brand=%3Cscript%3E'), '');
    assert.equal(ValuePages.brandFromUrl('?brand=HP'), '');
    assert.equal(ValuePages.brandFromUrl(''), '');
});

test('§7 the fetch filters by brand, a stale response cannot paint, and an empty brand is SAID', () => {
    const code = stripComments(read('js/value-pages.js'));
    const fn = lift(code, 'async renderPacks(facts, data)');
    assert.match(fn, /if \(brand\) params\.brand = brand;/);
    assert.match(fn, /if \(mine !== seq\) return;/);
    assert.match(fn, /No value packs for \$\{esc\(brandLabel \|\| brand \|\| 'this brand'\)\} right now\./);
    assert.match(read('html/value-packs.html'), /id="value-page-brands" role="group"[^>]*hidden/);
});

// ═════════════════════════════════════════════════════════════════════════════
// §8 Buy again — executed
// ═════════════════════════════════════════════════════════════════════════════

const ACCOUNT_SRC = read('js/account.js');

function buyAgain() {
    const sandbox = {};
    vm.createContext(sandbox);
    const start = ACCOUNT_SRC.indexOf('const BuyAgain = {');
    const body = lift(ACCOUNT_SRC.slice(start), 'hrefFor(items)');
    vm.runInContext(`globalThis.B = { ${body} };`, sandbox);
    return sandbox.B;
}

test('§8 an order\'s lines become ONE /cart?add= link (the guest reorder path, CartDeepLink)', () => {
    const B = buyAgain();
    const plan = B.hrefFor([
        { product: { sku: 'CTN2345' }, quantity: 2 },
        { product_sku: '81051.02', quantity: 1 },
        { sku: 'GLC3329XLBK', quantity: '3' },
        { product_name: 'no sku', quantity: 1 },
        null,
    ]);
    assert.equal(plan.lines, 3);
    assert.equal(plan.missingSku, 1, 'a line with no SKU is COUNTED, not silently dropped');
    assert.equal(decodeURIComponent(plan.href.slice('/cart?add='.length)), 'CTN2345:2,81051.02:1,GLC3329XLBK:3');
    assert.equal(B.hrefFor([]).href, null);
    assert.equal(B.hrefFor(undefined).href, null);
    assert.equal(decodeURIComponent(B.hrefFor([{ sku: 'X1', quantity: 0 }]).href), '/cart?add=X1:1', 'qty floors at 1');
});

test('§8 wiring: every order row and the order detail carry a Buy again button; the sidebar links to it', () => {
    const code = stripComments(ACCOUNT_SRC);
    assert.match(lift(code, 'renderOrderRow(order)'), /data-buy-again="\$\{Security\.escapeAttr\(order\.order_number\)\}">Buy again<\/button>/);
    assert.match(code, /closest\('\[data-buy-again\]'\)/);
    assert.match(lift(code, 'async go(orderNumber, btn)'), /API\.getOrder\(orderNumber\)/);
    assert.match(read('html/account/order-detail.html'), /id="order-buy-again" hidden>Buy again<\/button>/);
    assert.match(stripComments(read('js/order-detail-page.js')), /buyAgain\.setAttribute\('data-buy-again', order\.order_number\)/);
    const withNav = fs.readdirSync(path.join(ROOT, 'html/account')).filter((f) => read(`html/account/${f}`).includes('account-nav__item'));
    assert.ok(withNav.length >= 10, `${withNav.length} account pages carry the sidebar`);
    for (const f of withNav) assert.match(read(`html/account/${f}`), /href="\/account\/orders#buy-again">[\s\S]{0,400}Buy again/, f);
});

// ═════════════════════════════════════════════════════════════════════════════
// §9 cart P2 — executed where it can be
// ═════════════════════════════════════════════════════════════════════════════

test('§9 guests: the coupon form is HIDDEN and the free-account line shown; members keep the form', () => {
    const src = read('js/cart-page.js');
    const fn = lift(src, 'function applyGuestCouponGate()');
    for (const [authed, formHidden, guestHidden] of [[false, true, false], [true, false, true]]) {
        const els = { 'cart-coupon-form': { hidden: false }, 'cart-coupon-guest': { hidden: true } };
        const sandbox = { document: { getElementById: (id) => els[id] || null }, Auth: { isAuthenticated: () => authed } };
        vm.createContext(sandbox);
        vm.runInContext(`${fn}; globalThis.r = applyGuestCouponGate();`, sandbox);
        assert.equal(els['cart-coupon-form'].hidden, formHidden, `authed=${authed}`);
        assert.equal(els['cart-coupon-guest'].hidden, guestHidden, `authed=${authed}`);
        assert.equal(sandbox.r, !authed);
    }
    assert.match(read('html/cart.html'), /id="cart-coupon-guest" hidden>Have a code\? <a href="\/account\/login\?tab=register&amp;redirect=%2Fcart">Create a free account to use it<\/a>/);
    const checkout = stripComments(read('js/checkout-page.js'));
    assert.ok(!checkout.includes('Sign in to use coupon codes.'));
    assert.match(checkout, /formRow\.hidden = true;[\s\S]{0,400}Create a free account to use it/);
});

test('§9 the cart figure without shipping is labelled so, desktop and sticky bar', () => {
    // ERR-305 keeps the ERR-296 label as the FALLBACK (no server total yet) and
    // swaps it for "Estimated total" once the server's own total arrives —
    // tests/checkout-funnel-oct2026.test.js drives that model.
    const html = read('html/cart.html');
    assert.match(html, /<div class="cart-summary__row cart-summary__row--total"[^>]*>\s*<span id="cart-total-label">Total before shipping<\/span>/);
    assert.match(html, /<span class="cart-sticky-bar__label" id="cart-sticky-label">Before shipping<\/span>/);
});

test('§9 Checkout never waits for Turnstile at the click (ERR-305 superseded the ERR-296 1.5s cap)', () => {
    // /api/cart/validate does not check a token; POST /api/orders does, and the
    // payment page mints it. The click waits for validate only, capped.
    const code = stripComments(read('js/cart.js'));
    assert.doesNotMatch(code, /_takeTurnstileToken|prefetchTurnstile|TURNSTILE_CLICK_WAIT_MS/);
    assert.match(lift(code, 'async validateCart(acknowledgePriceChanges)'), /API\.validateCart\(null, acknowledgePriceChanges\)/);
    const cap = Number((code.match(/CHECKOUT_VALIDATE_CAP_MS:\s*(\d+)/) || [])[1]);
    assert.ok(cap > 0 && cap < 1000, `click cap ${cap}ms must leave room under the 1s target`);
});

// ═════════════════════════════════════════════════════════════════════════════
// §10 CSS (text — the probe measures the rendered result)
// ═════════════════════════════════════════════════════════════════════════════

const CSS = { pages: read('css/pages.css'), components: read('css/components.css'), search: read('css/search.css') };

function ruleBody(css, selector) {
    const i = css.indexOf(`${selector} {`);
    assert.ok(i >= 0, `${selector} rule must exist`);
    return css.slice(i, css.indexOf('}', i));
}
function px(decl) {
    const m = decl.match(/font-size:\s*([\d.]+)(px|rem)/);
    assert.ok(m, `no font-size in: ${decl.slice(0, 80)}`);
    return m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1]);
}

test('§10 card text floor is 12px (was 9.9px "3+ PRICE", 9.9px "Save", 10px ribbon, 11px stock)', () => {
    const rules = [
        ['pages', '.product-card__biz-label'], ['pages', '.product-card__biz-unit'], ['pages', '.product-card__biz-save'],
        ['pages', '.product-card__stock'], ['pages', '.product-card__color'], ['pages', '.product-card__free-shipping'],
        ['components', '.product-card__savings'], ['components', '.product-card__gst'],
        ['search', '.product-card__ribbon'], ['search', '.smart-ac__grid .product-card__stock'],
    ];
    for (const [file, sel] of rules) assert.ok(px(ruleBody(CSS[file], sel)) >= 12, `${file}.css ${sel}`);
});

test('§10 the cross-sell image is capped at 120px (one suggestion stretched it to 686px)', () => {
    assert.match(ruleBody(CSS.components, '.crosssell-modal__img'), /max-width:\s*120px/);
});

test('§10 phones: toasts at the TOP; Filter & Sort follows the header\'s hide signal', () => {
    const toast = CSS.components.slice(CSS.components.indexOf('@media (max-width: 767.98px) {\n    .toast-container'));
    assert.match(toast.slice(0, 300), /top:\s*calc\(env\(safe-area-inset-top, 0px\) \+ 12px\);\s*bottom:\s*auto;/);
    assert.match(CSS.pages, /body:has\(\.site-header--hidden\) \.filter-sort-bar:not\(:focus-within\) \{[^}]*transform:[^}]*pointer-events:\s*none;/);
});

// ═════════════════════════════════════════════════════════════════════════════
// §11 fonts
// ═════════════════════════════════════════════════════════════════════════════

test('§11 base.css has no @import; every page linking base.css links the Google Fonts CSS BEFORE it', () => {
    assert.ok(!/@import\b/.test(stripComments(read('css/base.css'))), 'an @import is a render-blocking request chain');
    const pages = [];
    (function walk(dir) {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, ent.name);
            if (ent.isDirectory()) { if (!['node_modules', '.git'].includes(ent.name)) walk(p); } else if (ent.name.endsWith('.html')) pages.push(p);
        }
    })(ROOT);
    let checked = 0;
    for (const p of pages) {
        const html = fs.readFileSync(p, 'utf8');
        const base = html.indexOf('href="/css/base.css');
        if (base < 0) continue;
        const font = html.indexOf('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans');
        assert.ok(font >= 0 && font < base, `${path.relative(ROOT, p)}: fonts link must precede base.css`);
        checked++;
    }
    assert.ok(checked >= 40, `${checked} pages checked`);
});

// ═════════════════════════════════════════════════════════════════════════════
// §12 quote links + sign-in rewards copy
// ═════════════════════════════════════════════════════════════════════════════

test('§12 /quote is linked from the PDP ladder and /bulk-pricing (turnaround doc #13)', () => {
    assert.match(stripComments(read('js/product-detail-page.js')), /<a href="\/quote">Buying for several printers\? Get a quote<\/a>/);
    assert.match(read('html/bulk-pricing.html'), /<a href="\/quote">Get a business quote<\/a>/);
});

test('§12 sign-in and register show the LIVE rewards facts, hidden until value-props lands (#15)', () => {
    const html = read('html/account/login.html');
    const lines = html.match(/<p class="auth-form__points" data-value-prop-scope hidden>.*?<\/p>/g) || [];
    assert.equal(lines.length, 2, 'one under each tab heading');
    for (const l of lines) {
        assert.match(l, /data-value-prop="loyalty\.headline"/);
        assert.match(l, /data-value-prop="loyalty\.detail"/);
        assert.ok(!/\d/.test(l.replace(/<[^>]+>/g, '')), 'no number is hard-coded');
    }
});
