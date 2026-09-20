/**
 * The rewards nudge covered Add to Cart on every phone (Sep 2026)
 * ===============================================================
 *
 * ERR-276 · backend handoff `mobile-cta-occlusion-and-seo-FE-handoff-sep2026.md`
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * js/rewards-nudge.js is two different components. Above
 * Config.BREAKPOINTS.tablet it is a small popover anchored under the header
 * Account button. Below it, position() makes it a `position: fixed`,
 * `vw - 24px` card at --z-popover (600) pinned at `header.bottom + 8px` and
 * re-pinned on every scroll. Measured on production at 390x844 it occupied a
 * constant band at viewport y 144-392, and #add-to-cart-btn — which is in
 * normal flow — travelled up through that band as the shopper scrolled.
 *
 * `npm run probe:mobile-cta`, before the fix, against the live site:
 *
 *     worst case: scrollY 1027 puts #add-to-cart-btn inside the band y 144-392
 *     inline ATC   y 244-292 (48px)
 *     verdict: blocked (elementFromPoint at its own centre
 *              -> aside#rewards-nudge.rewards-nudge.rewards-nudge--card)
 *
 * and after it, at the same viewport, same SKU, same scroll position:
 *
 *     inline ATC   y 244-292 (48px)
 *     verdict: reachable (-> button#add-to-cart-btn.btn.btn--primary)
 *     nudge module   suppressed=true postAddArmed=true
 *
 * Mobile converts at 1.8% against desktop's 6.5% on the same spend, and mobile
 * was switched off for two generic ad groups as a stop-loss while this was live.
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THESE TESTS
 * -------------------------------------------------
 *   1. A PATH SPELLING GOES MISSING. The site serves the same product page at
 *      four URLs — /products/:slug/:sku, /product/:slug, /p/:sku (vercel.json)
 *      and /html/product/index.html (serve.json, i.e. every local run). A gate
 *      listing only the production spelling is dead in development, which is
 *      where it gets demoed and believed. §2 runs the REAL matcher over all of
 *      them; it caught the missing '/p' during this very change.
 *   2. THE GATE AND THE LAYOUT DISAGREE. position() used to spell its own copy
 *      of the media query. Two copies of "is this a phone" is one edit away
 *      from a gate that thinks it is desktop while the card renders. §3.
 *   3. THE ASK IS DELETED RATHER THAN MOVED. Suppressing the nudge on mobile
 *      with nothing in its place silently ends mobile account signups — the
 *      failure mode with no symptom, and nobody files a bug about a popover
 *      they never saw. §4.
 *   4. HALF THE PAIR IS REMOVED. cart.js dispatches `cart:item-added`;
 *      rewards-nudge.js listens for it. Neither file names the other in code,
 *      so either half can be deleted leaving a green suite — ERR-214, where
 *      hash-locked markup and hand enrolment left ten dead search boxes for
 *      four months. §4 asserts BOTH HALVES IN ONE TEST, so removing either
 *      fails it.
 *   5. THE LOYALTY CLAIM DRIFTS. The earn/redeem rate is stated on three
 *      surfaces now. A rate change that lands on two of them is a false claim
 *      on the third, on a site whose ads account was suspended for
 *      misrepresentation in May 2026. §5.
 *
 * These are SOURCE CONTRACTS plus real execution of the matcher. They cannot
 * prove a thumb reaches a button — that is `npm run probe:mobile-cta`, which
 * measures real geometry in a real browser and carries its own negative
 * control. Neither replaces the other.
 *
 * Run: node --test tests/mobile-cta-occlusion-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const read = (...p) => fs.readFileSync(path.join(INK, ...p), 'utf8');

const NUDGE_SRC = read('js', 'rewards-nudge.js');
const NUDGE_CODE = stripComments(NUDGE_SRC);
const CART_CODE = stripComments(read('js', 'cart.js'));
const PDP_HTML = read('html', 'product', 'index.html');
const CONFIRMATION_HTML = read('html', 'order-confirmation.html');
const LOYALTY_HTML = read('html', 'account', 'loyalty.html');

/**
 * Load js/rewards-nudge.js for real, in a vm, and hand back what it exported.
 *
 * The module is an IIFE that ends in `document.addEventListener` — it needs a
 * document to load at all, but NOT to answer the questions in §1/§2, which are
 * about pure path arithmetic. So the stub is the minimum that lets the file
 * finish executing, and every test below drives the exported function with an
 * explicit path rather than by faking navigation.
 */
function loadNudge() {
    const ctx = {
        document: { addEventListener() {}, querySelector: () => null, cookie: '' },
        Config: { BREAKPOINTS: { compact: 480, tablet: 768, desktopNav: 1100 }, MQ_DESKTOP_NAV: '(min-width: 1100px)' },
        Security: { escapeHtml: (s) => s, escapeAttr: (s) => s },
        DebugLog: { error() {}, log() {} },
        getStorage: () => null,
        setStorage: () => {},
        sessionStorage: { getItem: () => null, setItem() {} },
        localStorage: { getItem: () => null, setItem() {} },
        location: { pathname: '/', search: '' },
        matchMedia: () => ({ matches: true }),
        console,
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(NUDGE_SRC, ctx, { filename: 'rewards-nudge.js' });
    return ctx.window.RewardsNudge;
}

/* Cross-realm normaliser. Arrays built inside the vm carry THAT realm's
 * Array.prototype, so assert/strict's deepEqual against a literal written here
 * reports "same structure but not reference-equal". What we assert about is the
 * value, not which realm allocated it. (Same helper, same reason, as
 * tests/ga4-ecommerce-events-sep2026.test.js.) */
const plain = (v) => JSON.parse(JSON.stringify(v));

// ═══════════════════════════════════════════════════════════════════════════
// §1 the gate exists, and it is about GEOMETRY rather than funnel stage
// ═══════════════════════════════════════════════════════════════════════════

test('§1 there are two skip lists, and they mean different things', () => {
    const nudge = loadNudge();
    assert.ok(Array.isArray(nudge._campaign.skipPaths), 'skipPaths must survive');
    assert.ok(Array.isArray(nudge._campaign.narrowSkipPaths), 'narrowSkipPaths must exist');
    assert.deepEqual(plain(nudge._campaign.skipPaths), ['/cart'],
        'skipPaths is the EVERY-WIDTH funnel rule and must not quietly absorb the narrow list — '
        + 'widening it would remove the nudge from the desktop buying path too, which nobody asked for');
});

test('§1 the gate fires only when BOTH conditions hold', () => {
    /* `isNarrow() && pathMatches(...)`. A gate on the path alone takes the
     * nudge off the desktop PDP; a gate on the width alone takes it off every
     * mobile browsing page, which is where it is supposed to work. */
    assert.match(NUDGE_CODE, /function onNarrowSkippedPath\(\)\s*\{\s*return isNarrow\(\) && pathMatches\(CAMPAIGN\.narrowSkipPaths\);\s*\}/,
        'onNarrowSkippedPath must be the conjunction of the width test and the path test');
    assert.match(NUDGE_CODE, /if \(onNarrowSkippedPath\(\)\) \{[\s\S]{0,200}?armPostAddTrigger\(\);[\s\S]{0,40}?return;/,
        'the gate must return BEFORE scheduleByTrigger, and must arm the post-add trigger on its way out');
});

test('§1 isNarrow defaults to DESKTOP when it cannot tell', () => {
    /* Failing closed here would suppress the nudge everywhere the media query
     * throws — including the vm harness — and a feature that silently stops
     * appearing is the failure mode with no symptom. */
    const m = NUDGE_CODE.match(/function isNarrow\(\)[\s\S]*?\n    \}/);
    assert.ok(m, 'isNarrow must exist');
    assert.match(m[0], /catch \(_\) \{\s*return false;\s*\}/,
        'a throw must be treated as "not narrow", preserving the previous behaviour');
});

// ═══════════════════════════════════════════════════════════════════════════
// §2 EVERY SPELLING — the real matcher, over the real URL shapes
// ═══════════════════════════════════════════════════════════════════════════

test('§2 every URL the site serves a product page at is suppressed', () => {
    const nudge = loadNudge();
    const list = nudge._campaign.narrowSkipPaths;
    const suppressed = (p) => nudge._pathMatches(list, p);

    // vercel.json rewrites, i.e. what production serves
    assert.ok(suppressed('/products/lc37bk-compatible-ink-for-brother/CLC37BK'), '/products/:slug/:sku');
    assert.ok(suppressed('/product/some-slug'), '/product/:slug');
    assert.ok(suppressed('/ribbon/R123'), '/ribbon/:sku');
    assert.ok(suppressed('/p/CLC37BK'),
        '/p/:sku — production 301s this to /products/:slug/:sku via the backend, but serve.json '
        + 'rewrites `p/**` straight to the PDP with NO redirect, so every local run stays on this '
        + 'spelling. Omitting it leaves the gate dead in development.');

    // serve.json / raw-file shapes, i.e. what `npx serve inkcartridges` serves
    assert.ok(suppressed('/html/product/index.html'),
        'the raw-file shape normalises to /product/index, which the "/products" prefix does NOT match');
    assert.ok(suppressed('/html/cart.html'), 'raw cart');

    // mid-funnel
    assert.ok(suppressed('/cart'), '/cart');
    assert.ok(suppressed('/checkout'), '/checkout');
    assert.ok(suppressed('/payment'), '/payment');
});

test('§2 the browsing surfaces keep their nudge', () => {
    const nudge = loadNudge();
    const list = nudge._campaign.narrowSkipPaths;
    const suppressed = (p) => nudge._pathMatches(list, p);

    for (const p of ['/', '/shop', '/ink-cartridges', '/toner-cartridges', '/account', '/faq']) {
        assert.equal(suppressed(p), false, `${p} is a browsing page and must keep the nudge`);
    }
    assert.equal(suppressed('/ribbons'), false,
        'the /ribbons HUB is a browsing page. "/ribbon" must not swallow it — that is a prefix '
        + 'one character away from removing the nudge from a category landing page.');
    assert.equal(suppressed('/privacy'), false, '"/p" must not swallow /privacy');
    assert.equal(suppressed('/pay'), false, '"/p" must not swallow /pay');
    assert.equal(suppressed('/product-by-name'), false,
        '"/product" must not swallow /product-by-name, which is a different backend route');
});

test('§2 the matcher under test is the shipped one, not a copy', () => {
    /* The reason §2 calls nudge._pathMatches instead of re-implementing three
     * lines of string work: a probe once certified a REPLICA of the search
     * escaper while the real one was broken (ERR-231). */
    const nudge = loadNudge();
    assert.equal(typeof nudge._pathMatches, 'function', 'rewards-nudge.js must export its matcher');
    assert.equal(nudge._normalizePath('/html/product/index.html'), '/product/index');
    assert.equal(nudge._normalizePath('/cart/'), '/cart');
    assert.equal(nudge._normalizePath('/'), '/');
    assert.equal(NUDGE_CODE.match(/function pathMatches\(/g).length, 1,
        'exactly one matcher in the file — two would be two behaviours');
});

// ═══════════════════════════════════════════════════════════════════════════
// §3 one owner for "is this a phone"
// ═══════════════════════════════════════════════════════════════════════════

test('§3 position() does not spell the media query — it asks isNarrow()', () => {
    /* NOT a global count. The file legitimately contains a second
     * `matchMedia(min-width: tablet)` inside deviceCategory(), which is an
     * ANALYTICS classifier answering a three-way question (desktop/tablet/
     * mobile) for an event dimension. Asserting "exactly one in the file" would
     * fail on that unrelated, correct code and would teach the next reader to
     * delete it.
     *
     * The invariant is narrower and real: the LAYOUT branch must not carry its
     * own copy of the width test, because the eligibility gate and the layout
     * have to agree by construction. A gate that thinks it is desktop while
     * position() renders the fixed card is the bug this file fixes, one edit
     * away. */
    const body = NUDGE_CODE.match(/function position\(\)[\s\S]*?\n    \}\n/);
    assert.ok(body, 'position() must exist');
    assert.doesNotMatch(body[0], /matchMedia/,
        'position() must not spell the media query itself — it used to, and that second copy is '
        + 'exactly what this fix removed');
    assert.match(body[0], /if \(isNarrow\(\)\) \{/,
        'position() must ask the shared helper, so the gate and the card mode can never disagree');

    const gate = NUDGE_CODE.match(/function isNarrow\(\)[\s\S]*?\n    \}/);
    assert.match(gate[0], /matchMedia\('\(min-width: ' \+ Config\.BREAKPOINTS\.tablet \+ 'px\)'\)/,
        'isNarrow() must be the one place the breakpoint is read, and it must read it from '
        + 'Config.BREAKPOINTS rather than hardcoding 768 — css/base.css:275 says the two must match');
});

// ═══════════════════════════════════════════════════════════════════════════
// §4 the ask is MOVED, not deleted — and both halves of the pair are here
// ═══════════════════════════════════════════════════════════════════════════

test('§4 the emitter and the listener exist, asserted together', () => {
    /* ONE TEST, TWO FILES, DELIBERATELY. cart.js dispatches the event and
     * rewards-nudge.js listens for it; neither names the other in code. Split
     * across two tests, deleting one half leaves the other green — which is
     * ERR-214 verbatim, and the ERR-237 addendum's "a peer's FEATURE spanning
     * two files" one layer down. */
    assert.match(CART_CODE, /new CustomEvent\('cart:item-added'/,
        'js/cart.js must announce the add-to-cart moment — without it the nudge is simply gone on mobile');
    assert.match(NUDGE_CODE, /addEventListener\('cart:item-added', onAdded\)/,
        'js/rewards-nudge.js must listen for it — without this the event is a beacon nobody reads');
});

test('§4 the dispatch is OUTSIDE the silent guard', () => {
    /* `product.silent` suppresses TOASTS for callers that add several lines in
     * one gesture (the ?add=SKU:QTY reorder link fires up to twelve). A silent
     * add is still a real add. Suppressing a toast and suppressing an event are
     * different decisions, and only one of them was made. */
    const at = CART_CODE.indexOf("new CustomEvent('cart:item-added'");
    assert.ok(at > -1, 'the dispatch must exist');
    const preceding = CART_CODE.slice(Math.max(0, at - 600), at);
    assert.doesNotMatch(preceding, /if \(typeof showToast === 'function' && !product\.silent\) \{[^}]*$/,
        'the dispatch must not be nested inside the !product.silent toast guard');
    assert.match(CART_CODE.slice(at, at + 400), /silent: !!product\.silent/,
        'the detail must carry `silent` so a listener can still tell — the information is passed on, not lost');
});

test('§4 the post-add trigger is one-shot and removes its own listener first', () => {
    const m = NUDGE_CODE.match(/function armPostAddTrigger\(\)[\s\S]*?\n    \}/);
    assert.ok(m, 'armPostAddTrigger must exist');
    assert.match(m[0], /if \(state\.postAddArmed\) return;/,
        'arming twice would queue two shows');
    assert.match(m[0], /var onAdded = function \(\) \{\s*document\.removeEventListener\('cart:item-added', onAdded\);/,
        'the listener must remove itself BEFORE doing anything else — the ?add= deep link fires up '
        + 'to twelve adds for one gesture, and an un-removed listener would queue twelve show() attempts');
});

test('§4 the cross-sell modal cannot be covered by the re-shown nudge', () => {
    /* cart.js#_showCrossSellModal appends .crosssell-modal at z-index 10000 in
     * the same instant the nudge is now armed for. The nudge is at 600, so it
     * would sit INVISIBLE underneath it and burn its once-per-session budget on
     * a card nobody saw. */
    assert.match(NUDGE_CODE, /headerUiOpen[\s\S]*?querySelector\('\.crosssell-modal'\)/,
        'headerUiOpen() must treat an open cross-sell modal as a conflicting surface');
    assert.match(CART_CODE, /const close = \(\) => overlay\.remove\(\);/,
        'the modal must be REMOVED on close, not hidden — otherwise the selector above latches on '
        + 'for the rest of the page and the nudge can never show again');
});

test('§4 the probe can see the decision, not just the pixels', () => {
    assert.match(NUDGE_CODE, /suppressed: false/, 'state.suppressed must be initialised');
    assert.match(NUDGE_CODE, /postAddArmed: false/, 'state.postAddArmed must be initialised');
    assert.match(NUDGE_CODE, /state\.suppressed = true;/, 'the gate must record that it fired');
    assert.match(NUDGE_CODE, /_state: state/,
        'window.RewardsNudge._state is how `npm run probe:mobile-cta` tells "suppressed" apart from '
        + '"has not mounted yet" — two states that look identical from the outside');
});

// ═══════════════════════════════════════════════════════════════════════════
// §5 the post-purchase surface — one ask, one vocabulary
// ═══════════════════════════════════════════════════════════════════════════

test('§5 the order-confirmation page has exactly ONE account prompt', () => {
    /* The handoff asked for the nudge here too. It is deliberately absent: this
     * page already carries a guest-gated #create-account-prompt, and the nudge
     * would bail anyway because .site-header--checkout has no Account link to
     * anchor to. */
    assert.match(CONFIRMATION_HTML, /id="create-account-prompt"/,
        'the existing post-purchase account ask must stay');
    /* Strip HTML comments first: the page now carries a comment EXPLAINING why
     * the nudge is absent, and it names the file. Without this the assertion
     * would fail on the prose justifying it — the mirror image of an assertion
     * that passes because of the comment describing it (ERR-253's family). */
    const confirmationMarkup = CONFIRMATION_HTML.replace(/<!--[\s\S]*?-->/g, '');
    assert.doesNotMatch(confirmationMarkup, /rewards-nudge\.js/,
        'the rewards nudge must NOT be added to this page — two account prompts on one page is not '
        + 'twice the conversion, and the nudge cannot anchor here in any case');
    assert.doesNotMatch(confirmationMarkup, /a class="header-actions__item" href="\/account"/,
        'if this page ever grows an Account link in its header, revisit the line above');
});

test('§5 the loyalty claim is identical on all three surfaces', () => {
    /* The ads account was suspended for misrepresentation in May 2026. A rate
     * change that lands on two of three surfaces is a false claim on the third. */
    const CLAIMS = ['1 point for every $1', 'excluding shipping', '100 points = $1'];
    for (const claim of CLAIMS) {
        assert.ok(NUDGE_SRC.includes(claim), `js/rewards-nudge.js must state "${claim}"`);
        assert.ok(CONFIRMATION_HTML.includes(claim),
            `html/order-confirmation.html must state "${claim}" — it is the mobile buying path's only `
            + 'account ask now, so it has to carry the offer the nudge used to');
        assert.ok(LOYALTY_HTML.includes(claim), `html/account/loyalty.html must state "${claim}"`);
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// §6 the surfaces the fix must NOT have touched
// ═══════════════════════════════════════════════════════════════════════════

test('§6 the PDP still ships both Add-to-Cart controls', () => {
    assert.match(PDP_HTML, /id="add-to-cart-btn"/, 'the inline button');
    assert.match(PDP_HTML, /<div class="sticky-atc" id="sticky-atc"/, 'the sticky bar');
    assert.match(PDP_HTML, /id="sticky-atc-btn"/, 'the sticky button');
    assert.match(PDP_HTML, /rewards-nudge\.js/,
        'the nudge script must STILL load on the PDP. The fix is a runtime gate, not a removed '
        + 'script tag: the post-add trigger has to be armed, and it cannot arm if the file is absent.');
});

test('§6 the consent-banner lift is untouched (ERR-238)', () => {
    /* The handoff reported this as broken. It is not — its own numbers show the
     * lift applied, to a bar that was deliberately hidden. Nothing here changed
     * it, and this test exists so nothing here ever does by accident. */
    const components = stripComments(read('css', 'components.css'));
    assert.match(components, /body\.has-consent-banner \.sticky-atc,?[\s\S]{0,120}bottom: var\(--consent-banner-height/,
        '.sticky-atc must still be lifted clear of the consent banner');
});
