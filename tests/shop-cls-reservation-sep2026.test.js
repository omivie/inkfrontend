/**
 * The shop family did not hold its own height (Sep 2026)
 * ======================================================
 *
 * ERR-276 · backend handoff `mobile-cta-occlusion-and-seo-FE-handoff-sep2026.md` §6
 *
 * WHAT WAS WRONG
 * --------------
 * Measured on a Pixel-5 profile at 4x CPU throttle and ~1.6Mbps — a mid-range
 * Android on 4G, which is the shopper whose conversion rate this work exists to
 * fix, not a laptop on office wifi:
 *
 *   route              before    after
 *   /ink-cartridges    0.679     0.007
 *   /toner-cartridges  0.674     0.007
 *   /ribbons           0.607     0.001
 *   /shop              0.089     0.001
 *
 * against Google's 0.1 "good" threshold. TWO separate causes, and the handoff
 * named neither precisely — it asked us to "reserve height on
 * .shop-section-card", which is one level below where the space was actually
 * being lost:
 *
 *   1. THE EMPTY LEVEL SHELL. #level-brands shipped VISIBLE and empty while
 *      #drilldown-loading shipped HIDDEN, so the page painted ~317px of empty
 *      section cards, and then — once scripts ran — hideAllLevels() removed
 *      them and the loading block JUMPED UP into the gap. The skeleton was
 *      built to be the reservation and was never on screen when it mattered.
 *      The other three levels already shipped `hidden`; the brands level was
 *      the odd one out.
 *
 *   2. THE SHELF OPENING INTO A PAGE ALREADY ON SCREEN. #popular-row sits ABOVE
 *      the brand picker (ERR-236 put it there deliberately) and was un-hidden
 *      only once /api/products/popular answered. renderBrands does not await
 *      it and loadBrands reveals the level as soon as renderBrands returns, so
 *      a 1,140px shelf opened on top of a page the shopper was looking at and
 *      pushed the brand card off the bottom of the viewport.
 *
 * WHY A SINGLE MEASUREMENT NEARLY SHIPPED THE WRONG ANSWER
 * --------------------------------------------------------
 * Cause 2 is a RACE. With /api/products/popular warm, the shelf landed before
 * the level was revealed and /ink-cartridges measured 0.007 — good, and pure
 * luck. The same page on a cold cache measured 0.53. The first fix was declared
 * done on the lucky number; `npm run probe:shop-cls` caught it on the next run.
 * A measurement taken once is a constant with a good alibi (ERR-233).
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THESE TESTS
 * -------------------------------------------------
 * Every part of this fix looks like tidiness and reads like it can be undone
 * safely:
 *   - `hidden` on #level-brands looks redundant (JS un-hides it anyway) — §1
 *   - a VISIBLE #drilldown-loading looks like a bug, because every other
 *     loading block on the site ships hidden — §1
 *   - `section.hidden = false` before a fetch looks premature — §3
 *   - four empty divs in the markup look like leftovers — §2
 *   - the <noscript> block looks like dead weight — §4
 * None of them has a visible symptom when removed: the page still works, it
 * just shifts again, and layout shift has no error message.
 *
 * These are SOURCE CONTRACTS. They cannot prove a box is the size it claims —
 * that is `npm run probe:shop-cls`, which measures real CLS at a throttled
 * phone profile and refuses to score a page that never rendered.
 *
 * Run: node --test tests/shop-cls-reservation-sep2026.test.js
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

const SHOP_HTML = read('html', 'shop.html');
const RIBBONS_HTML = read('html', 'ribbons.html');
const SHOP_JS = stripComments(read('js', 'shop-page.js'));
const PAGES_CSS = stripComments(read('css', 'pages.css'));

/** Markup only — a comment that names a tag is not a tag (the ERR-253 family). */
const markupOnly = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

/** The opening tag for an element carrying this id, comments stripped. */
function openTag(html, id) {
    const m = markupOnly(html).match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`));
    return m ? m[0] : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// §1 the skeleton is on screen before any script runs
// ═══════════════════════════════════════════════════════════════════════════

test('§1 all four drilldown levels ship hidden — including brands', () => {
    /* The brands level was the only one that did not, and that asymmetry is the
     * whole of cause 1: an empty shell painted, then vanished. */
    for (const id of ['level-brands', 'level-categories', 'level-codes', 'level-products']) {
        const tag = openTag(SHOP_HTML, id);
        assert.ok(tag, `#${id} must exist in html/shop.html`);
        assert.match(tag, /\bhidden\b/,
            `#${id} must ship hidden. If the brands level paints its empty section cards `
            + 'before scripts run, hideAllLevels() then removes ~317px from under the loading '
            + 'block and everything below jumps up. shop-page.js#loadBrands sets '
            + 'levelBrands.hidden = false, so nothing is lost by shipping it hidden.');
    }
    assert.match(openTag(RIBBONS_HTML, 'level-brands'), /\bhidden\b/,
        '/ribbons is a different document with the same structure and needed the same fix');
});

test('§1 the loading block and the brands skeleton ship VISIBLE', () => {
    /* The inverse of §1 above, and the half that does the reserving. This looks
     * wrong next to every other loading state on the site, which is exactly why
     * it needs a test rather than a comment. */
    for (const [name, html] of [['shop.html', SHOP_HTML], ['ribbons.html', RIBBONS_HTML]]) {
        const loading = openTag(html, 'drilldown-loading');
        assert.ok(loading, `#drilldown-loading must exist in ${name}`);
        assert.doesNotMatch(loading, /\bhidden\b/,
            `#drilldown-loading must NOT ship hidden in ${name} — it is the only thing on the `
            + 'page that can hold the drilldown\'s height before scripts run, and under a 4x CPU '
            + 'throttle DOMContentLoaded does not fire until ~5s.');
        const skeleton = openTag(html, 'skeleton-brands');
        assert.doesNotMatch(skeleton, /\bhidden\b/,
            `#skeleton-brands must NOT ship hidden in ${name} — an invisible skeleton reserves nothing`);
    }
});

test('§1 the brand skeleton is the height of the tile it stands in for', () => {
    /* The comment above this rule claimed "matched 1:1 to the real
     * .drilldown-box tiles (brand 56)". It had stopped being true: inside a
     * .shop-section-card the real tile is 80px, and 84px under 768. A skeleton
     * that under-reserves by 24px a row is a reservation that still shifts. */
    const skel = PAGES_CSS.match(/\.skeleton--brand-box\s*\{[^}]*\}/);
    assert.ok(skel, '.skeleton--brand-box must exist');
    const real = PAGES_CSS.match(/\.shop-section-card \.drilldown-box--brand\s*\{[^}]*min-height:\s*(\d+)px/);
    assert.ok(real, 'the real tile must declare a min-height');
    assert.match(skel[0], new RegExp(`height:\\s*${real[1]}px`),
        `the skeleton tile must be ${real[1]}px, matching .shop-section-card .drilldown-box--brand`);
});

// ═══════════════════════════════════════════════════════════════════════════
// §2 the shelf's own height
// ═══════════════════════════════════════════════════════════════════════════

test('§2 both shelves ship placeholders, one per row the shelf will render', () => {
    // Each shelf reads ITS OWN limit: /ink-cartridges and /toner-cartridges show
    // 8 since the conversion handoff (2026-09-23 D-P0-4); /ribbons still shows 4.
    const limitOf = (src) => Number((src.match(/POPULAR_ROW_LIMIT:\s*(\d+)/) || [])[1]);
    const RIBBONS_JS = fs.readFileSync(path.join(__dirname, '..', 'inkcartridges', 'js', 'ribbons-page.js'), 'utf8');
    assert.equal(limitOf(SHOP_JS), 8, 'shop POPULAR_ROW_LIMIT');
    assert.equal(limitOf(RIBBONS_JS), 4, 'ribbons POPULAR_ROW_LIMIT');
    for (const [name, html, LIMIT] of [['shop.html', SHOP_HTML, limitOf(SHOP_JS)], ['ribbons.html', RIBBONS_HTML, limitOf(RIBBONS_JS)]]) {
        const count = (markupOnly(html).match(/class="product-card product-card--placeholder"/g) || []).length;
        assert.equal(count, LIMIT,
            `${name} must ship exactly ${LIMIT} placeholders — the same number of cards the shelf `
            + 'renders, so the reserved row count matches the real one at every breakpoint');
    }
});

test('§2 the placeholders are inert', () => {
    for (const html of [SHOP_HTML, RIBBONS_HTML]) {
        const tags = markupOnly(html).match(/<div class="product-card product-card--placeholder"[^>]*>/g) || [];
        for (const t of tags) {
            assert.match(t, /aria-hidden="true"/,
                'a placeholder must be hidden from assistive technology — it is a box, not a product');
        }
    }
    const rule = PAGES_CSS.match(/\.product-card--placeholder\s*\{[^}]*\}/);
    assert.ok(rule, '.product-card--placeholder must be styled');
    assert.match(rule[0], /min-height:\s*\d+px/, 'it must reserve a height — that is its whole job');
    assert.match(rule[0], /pointer-events:\s*none/, 'and it must never swallow a tap');
    assert.match(PAGES_CSS, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.product-card--placeholder\s*\{\s*animation:\s*none/,
        'the shimmer must respect prefers-reduced-motion');
});

test('§2 only /ribbons ships its shelf visible', () => {
    /* The asymmetry is deliberate and is the easiest thing here to "tidy up".
     * /ribbons is single-category, so its shelf is unconditional and its height
     * can be claimed at parse. html/shop.html serves /shop as well, which has
     * no shelf at all — reserving 1,140px there would trade two good pages for
     * one bad one. */
    assert.doesNotMatch(openTag(RIBBONS_HTML, 'popular-row'), /\bhidden\b/,
        '/ribbons shelf is unconditional and must ship visible');
    assert.match(openTag(SHOP_HTML, 'popular-row'), /\bhidden\b/,
        'html/shop.html also serves /shop, which has no shelf — this one must stay hidden and be '
        + 'un-hidden by shop-page.js once it knows the route has one');
});

// ═══════════════════════════════════════════════════════════════════════════
// §3 the ordering that makes the reservation land in time
// ═══════════════════════════════════════════════════════════════════════════

test('§3 renderPopularRow claims its height BEFORE it awaits the fetch', () => {
    /* This is cause 2, and the assertion is about ORDER, not presence. Moving
     * `section.hidden = false` back below the await restores the defect exactly
     * and changes nothing else about the function. */
    const fn = SHOP_JS.match(/async renderPopularRow\(category, label\) \{[\s\S]*?\n        \},/);
    assert.ok(fn, 'renderPopularRow must exist');
    const body = fn[0];
    const reveal = body.indexOf('section.hidden = false;');
    const await_ = body.indexOf('await API.getPopularProducts');
    assert.ok(reveal > -1, 'the shelf must be revealed somewhere in this function');
    assert.ok(await_ > -1, 'the fetch must still be awaited');
    assert.ok(reveal < await_,
        'the shelf must be un-hidden BEFORE the fetch is awaited. renderBrands does not await '
        + 'renderPopularRow and loadBrands reveals the level as soon as renderBrands returns, so '
        + 'a reveal after the await opens a 1,140px section on top of a page the shopper is '
        + 'already looking at — measured CLS 0.53 on a cold cache, 0.007 on a warm one.');
});

test('§3 a failed read still collapses the shelf rather than leaving it empty', () => {
    /* The reservation must not turn a missing shelf into an empty one. ERR-193
     * printed empty-shelf copy on 63 brand pages for 44 hours. */
    const fn = SHOP_JS.match(/async renderPopularRow\(category, label\) \{[\s\S]*?\n        \},/)[0];
    assert.match(fn, /const hide = \(\) => \{ section\.hidden = true; grid\.innerHTML = ''; \};/,
        'hide() must clear the grid as well as the section, so the placeholders cannot survive a failure');
    assert.ok((fn.match(/hide\(\);/g) || []).length >= 3,
        'every early return after the reveal must collapse the section: no category, no api mapping, '
        + 'and an empty or unreadable response');
});

// ═══════════════════════════════════════════════════════════════════════════
// §4 without scripts there is no loading, so there must be no skeleton
// ═══════════════════════════════════════════════════════════════════════════

test('§4 a no-JS visitor gets the content, not a skeleton that never resolves', () => {
    for (const [name, html] of [['shop.html', SHOP_HTML], ['ribbons.html', RIBBONS_HTML]]) {
        const ns = html.match(/<noscript>[\s\S]*?<\/noscript>/);
        assert.ok(ns, `${name} must carry a <noscript> fallback`);
        assert.match(ns[0], /#drilldown-loading\s*\{\s*display:\s*none;?\s*\}/,
            'the skeleton must be hidden without scripts — nothing will ever resolve it');
        assert.match(ns[0], /#level-brands\[hidden\]\s*\{\s*display:\s*block;?\s*\}/,
            'and the level it is standing in for must be shown instead');
        assert.doesNotMatch(ns[0], /<script/,
            'an inline <script> is refused by our CSP and is not needed here (ERR-230); '
            + 'inline <style> is allowed by style-src');
    }
});
