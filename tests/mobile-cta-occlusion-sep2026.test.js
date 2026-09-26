/**
 * The rewards nudge covered Add to Cart on every phone (Sep 2026)
 * ===============================================================
 *
 * ════ SUPERSEDED 2026-09-27: THE NUDGE IS RETIRED ════
 * ERR-276 gated it off the phone buying path; ERR-280 moved it in flow below
 * the fold on phones. On 2026-09-23 the backend measured it still covering the
 * desktop search box and PDP titles, on 35 of 58 paid sessions, for 1 click in
 * 30 days (conversion handoff D-P0-1), and the owner decided to remove the
 * overlay entirely. js/rewards-nudge.js is DELETED; the programme facts are
 * now inline (value strip, PDP value lines, cart/checkout loyalty lines).
 * What this file still pins is what OUTLIVED the module: the add-to-cart event
 * cart.js announces, the ONE post-purchase account ask, the loyalty wording
 * shared by the surfaces that remain, and the PDP controls. §0 pins the
 * retirement itself so the overlay cannot quietly come back.
 *
 * The history below is kept because it is why the retirement happened.
 *
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
 * Run: node --test tests/mobile-cta-occlusion-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const read = (...p) => fs.readFileSync(path.join(INK, ...p), 'utf8');

const CART_CODE = stripComments(read('js', 'cart.js'));
const PDP_HTML = read('html', 'product', 'index.html');
const CONFIRMATION_HTML = read('html', 'order-confirmation.html');
const LOYALTY_HTML = read('html', 'account', 'loyalty.html');

// ═══════════════════════════════════════════════════════════════════════════
// §0 the overlay is retired, everywhere, and cannot come back quietly
// ═══════════════════════════════════════════════════════════════════════════

function htmlFiles(dir = INK) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const f = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...htmlFiles(f));
        else if (e.name.endsWith('.html')) out.push(f);
    }
    return out;
}

test('§0 js/rewards-nudge.js is gone and no page loads it', () => {
    assert.ok(!fs.existsSync(path.join(INK, 'js', 'rewards-nudge.js')), 'the module file must not exist');
    const loaders = htmlFiles().filter((f) => /\/js\/rewards-nudge\.js/.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(loaders.map((f) => path.relative(INK, f)), [], 'no page may load the retired nudge');
});

test('§0 no stylesheet still styles a .rewards-nudge', () => {
    for (const css of ['components.css', 'layout.css', 'pages.css']) {
        assert.doesNotMatch(stripComments(read('css', css)), /\.rewards-nudge/, `${css} still styles the retired overlay`);
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// §4 the add-to-cart moment is still announced (its first listener retired)
// ═══════════════════════════════════════════════════════════════════════════

test('§4 cart.js still announces cart:item-added', () => {
    assert.match(CART_CODE, /new CustomEvent\('cart:item-added'/,
        'the one place "the shopper just added something" is announced — keep it for inline surfaces');
});

test('§4 the dispatch is OUTSIDE the silent guard', () => {
    /* `product.silent` suppresses TOASTS for callers that add several lines in
     * one gesture (the ?add=SKU:QTY reorder link fires up to twelve). A silent
     * add is still a real add. */
    const at = CART_CODE.indexOf("new CustomEvent('cart:item-added'");
    assert.ok(at > -1, 'the dispatch must exist');
    const preceding = CART_CODE.slice(Math.max(0, at - 600), at);
    assert.doesNotMatch(preceding, /if \(typeof showToast === 'function' && !product\.silent\) \{[^}]*$/,
        'the dispatch must not be nested inside the !product.silent toast guard');
    assert.match(CART_CODE.slice(at, at + 400), /silent: !!product\.silent/,
        'the detail must carry `silent` so a listener can still tell');
});

// ═══════════════════════════════════════════════════════════════════════════
// §5 the post-purchase surface — one ask, one vocabulary
// ═══════════════════════════════════════════════════════════════════════════

test('§5 the order-confirmation page has exactly ONE account prompt', () => {
    assert.match(CONFIRMATION_HTML, /id="create-account-prompt"/,
        'the existing post-purchase account ask must stay');
    assert.match(CONFIRMATION_HTML, /id="create-account-points"/,
        'the guest points line (renderGuestPointsLine) lives inside that one prompt');
    assert.equal((CONFIRMATION_HTML.match(/id="create-account-prompt"/g) || []).length, 1);
});

test('§5 the loyalty claim is identical on both remaining surfaces', () => {
    /* The ads account was suspended for misrepresentation in May 2026. A rate
     * change that lands on one surface only is a false claim on the other. */
    const CLAIMS = ['1 point for every $1', 'excluding shipping', '100 points = $1'];
    for (const claim of CLAIMS) {
        assert.ok(CONFIRMATION_HTML.includes(claim), `html/order-confirmation.html must state "${claim}"`);
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
});

test('§6 the consent-banner lift is untouched (ERR-238)', () => {
    const components = stripComments(read('css', 'components.css'));
    assert.match(components, /body\.has-consent-banner \.sticky-atc,?[\s\S]{0,120}bottom: var\(--consent-banner-height/,
        '.sticky-atc must still be lifted clear of the consent banner');
});
