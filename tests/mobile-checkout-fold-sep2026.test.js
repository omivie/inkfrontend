/**
 * The mobile checkout form was four screens below the fold (Sep 2026)
 * ===================================================================
 * ERR-224
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Mobile converts at 1.65% against desktop's 9.35%, and mobile is 64% of paid
 * search traffic — currently excluded at -100% in Google Ads because it has
 * never paid for itself. Mobile clicks cost $1.24 against desktop's $3.58, so
 * mobile needs roughly 4.4% to be profitable; it does not need to match
 * desktop. Measured on /checkout at 390x844 with 8 x CLC37BK:
 *
 *     97px  "Checkout" heading
 *    180px  .checkout-progress     <- 400px tall to render 52px of step pills
 *    596px  .checkout-sidebar      <- Order Summary, 858px, renders FIRST
 *   1621px  input[name="email"]    <- the first field anyone must fill
 *
 * Two causes, and neither was a fixed height someone tuned for desktop.
 *
 * 1. FLEX-BASIS IS MAIN-AXIS, AND THE MAIN AXIS FLIPS.
 *    `.checkout-progress--compact` declares `flex: 0 1 400px` beside
 *    `max-width: 400px` — and that pairing is the proof of intent: the author
 *    meant "at most 400px WIDE", which is exactly what flex-basis means in the
 *    desktop row. The <=768px block turns the header into `flex-direction:
 *    column`, so the same declaration became a 400px HEIGHT, and `max-width`
 *    cannot catch it because max-width is not a height. Same family as
 *    ERR-217's `transform: translateY(0)` is not `none`: a property whose
 *    meaning depends on a context declared somewhere else.
 *
 * 2. THE SUMMARY IS FIRST ON PURPOSE. `.checkout-sidebar { order: -1 }` is an
 *    explicit rule, not an accident of a collapsing grid — someone decided a
 *    shopper should see what they are paying before they type. That intent is
 *    right and is preserved: the summary stays first and COLLAPSES to a row
 *    carrying its total, rather than being reordered away.
 *
 * And one found while verifying: `.checkout-sidebar` had `min-width: auto`
 * (the grid default) while its sibling `.checkout-form-wrapper` already had
 * `min-width: 0`. One grid child got the fix and the other did not, so the
 * sidebar's 390px min-content forced the mobile column past its 358px
 * container and the page ran 16px off-screen, clipping the price.
 *
 * Run: node --test tests/mobile-checkout-fold-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PAGES = read('inkcartridges/css/pages.css');
const COMPACT = read('inkcartridges/css/checkout-compact.css');
const HTML = read('inkcartridges/html/checkout.html');
const JS = read('inkcartridges/js/checkout-page.js');
const NUDGE = read('inkcartridges/js/rewards-nudge.js');
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The balanced `{ … }` block that follows `marker`. */
function blockAfter(src, marker, from = 0) {
    const start = src.indexOf(marker, from);
    assert.ok(start >= 0, `could not locate ${marker}`);
    let depth = 0, i = src.indexOf('{', start);
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (!depth) return src.slice(start, i + 1); }
    }
    throw new Error(`unbalanced block after ${marker}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. The 400px that was never a height
// ═══════════════════════════════════════════════════════════════════════════

test('§1 the desktop rule still declares the basis AND the max-width together', () => {
    // Both are load-bearing and they are the pair that explains the bug. If
    // someone deletes max-width the intent stops being legible; if they delete
    // the basis the desktop bar stops being 400px wide.
    const rule = blockAfter(PAGES, '.checkout-progress--compact {');
    assert.match(rule, /flex:\s*0 1 400px/);
    assert.match(rule, /max-width:\s*400px/);
});

test('§1 the mobile column block resets flex-basis', () => {
    // This is the whole fix. Without it the bar is 400px TALL to draw 52px.
    const mobile = PAGES.slice(PAGES.indexOf('@media (max-width: 768px)', PAGES.indexOf('.checkout-progress--compact')));
    const rule = blockAfter(mobile, '.checkout-progress--compact {');
    assert.match(rule, /flex-basis:\s*auto/,
        'flex-basis sizes the MAIN axis, and this block makes the main axis vertical');
    // width/max-width say what it does horizontally and must stay.
    assert.match(rule, /width:\s*100%/);
    assert.match(rule, /max-width:\s*100%/);
});

test('§1 the block that flips the axis is still the one being compensated for', () => {
    // If .cart-page__header stops becoming a column, the reset is harmless —
    // but if it moves to a different breakpoint the reset must move with it.
    const mobile = PAGES.slice(PAGES.indexOf('@media (max-width: 768px)', PAGES.indexOf('.checkout-progress--compact')));
    const hdr = blockAfter(mobile, '.cart-page__header {');
    assert.match(hdr, /flex-direction:\s*column/,
        'the reset above exists because THIS rule makes flex-basis mean height');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The summary stays first, and collapses
// ═══════════════════════════════════════════════════════════════════════════

test('§2 the sidebar is still deliberately first on mobile', () => {
    // Preserved on purpose: a shopper should see what they are paying before
    // they type. The fix is its SIZE, not its position — do not "fix" this by
    // reordering, which throws the reassurance away.
    assert.match(COMPACT, /@media \(max-width: 1024px\)\s*\{\s*\.checkout-sidebar\s*\{\s*order:\s*-1;/);
});

test('§2 the disclosure markup is wired for assistive tech', () => {
    assert.match(HTML, /id="checkout-summary-toggle"/);
    assert.match(HTML, /aria-controls="checkout-summary-inner"/);
    assert.match(HTML, /id="checkout-summary-inner"/);
    assert.match(HTML, /aria-expanded="false"/);
    // The toggle must be a real button, not a div with a click handler.
    assert.match(HTML, /<button type="button" class="checkout-summary__toggle"/);
});

test('§2 the toggle is hidden by default and only appears on mobile', () => {
    // A desktop shopper must never see it, because on desktop the summary is a
    // side column that costs no vertical space.
    const base = blockAfter(COMPACT, '.checkout-summary__toggle {');
    assert.match(base, /display:\s*none/, 'hidden by default; the media query opts it IN');
    const mobile = COMPACT.slice(COMPACT.indexOf('MOBILE ORDER-SUMMARY DISCLOSURE'));
    assert.match(mobile, /@media \(max-width: 1024px\)/);
    // Slice from the media query, or this finds the display:none rule above it.
    const inMq = mobile.slice(mobile.indexOf('@media (max-width: 1024px)'));
    assert.match(blockAfter(inMq, '.checkout-summary__toggle {'), /display:\s*flex/);
});

test('§2 collapsing removes the content from layout, not just from view', () => {
    // height:0 or visibility:hidden would leave the 858px in the flow and fix
    // nothing at all — the entire point is that it stops occupying space.
    const mobile = COMPACT.slice(COMPACT.indexOf('MOBILE ORDER-SUMMARY DISCLOSURE'));
    const rule = blockAfter(mobile, '.checkout-summary.is-collapsed .checkout-summary__inner {');
    assert.match(rule, /display:\s*none/);
});

test('§2 the collapsed rule is scoped INSIDE the mobile media query', () => {
    // If it leaked to desktop, a stale `is-collapsed` class would hide the
    // summary on a viewport whose toggle is display:none — unrecoverable.
    const mobile = COMPACT.slice(COMPACT.indexOf('MOBILE ORDER-SUMMARY DISCLOSURE'));
    const mq = mobile.indexOf('@media (max-width: 1024px)');
    const collapsed = mobile.indexOf('.checkout-summary.is-collapsed');
    assert.ok(mq >= 0 && collapsed > mq, 'the collapsed rule must sit inside the mobile block');
});

test('§2 the touch target clears 44px', () => {
    const mobile = COMPACT.slice(COMPACT.indexOf('MOBILE ORDER-SUMMARY DISCLOSURE'));
    const rule = blockAfter(mobile, '.checkout-summary__toggle {', mobile.indexOf('@media'));
    const m = rule.match(/min-height:\s*(\d+)px/);
    assert.ok(m && Number(m[1]) >= 44, `min-height must be >= 44px, found ${m && m[1]}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The behaviour, and the state a desktop shopper must never reach
// ═══════════════════════════════════════════════════════════════════════════

test('§3 setupSummaryDisclosure is actually called from init', () => {
    // ERR-194: a function nobody calls is the same as a function that does not
    // exist, and it looks correct in review either way.
    assert.match(codeOnly(JS), /this\.setupSummaryDisclosure\(\);/);
    assert.match(JS, /setupSummaryDisclosure\(\)\s*\{/);
});

test('§3 the breakpoint is re-checked on change, not only at load', () => {
    // Collapse on a phone, rotate to a width above 1024, and the toggle is
    // display:none — so a stuck collapsed state would leave the summary gone
    // with no control to bring it back.
    const fn = blockAfter(JS, 'setupSummaryDisclosure() {');
    assert.match(fn, /matchMedia/);
    // The PRIMARY listener specifically. Accepting the resize fallback as an
    // alternative made this assertion pass with the primary deleted — and the
    // fallback only runs from a catch, i.e. on a browser where addEventListener
    // on a MediaQueryList throws. On every current browser that is never.
    assert.match(fn, /matchMedia\(MOBILE\)\.addEventListener\('change', applyBreakpoint\)/,
        'a viewport that crosses the breakpoint must re-apply the rule');
    // And the legacy fallback still has to be there, in its catch.
    assert.match(fn, /catch \(_\) \{[\s\S]{0,120}addEventListener\('resize', applyBreakpoint\)/,
        'older browsers throw on MediaQueryList.addEventListener');
});

test('§3 the total is MIRRORED from #checkout-total, never recomputed', () => {
    // That element is written from four places in this file as pricing
    // resolves. A fifth place computing its own figure is how two numbers on
    // one screen start disagreeing (ERR-113).
    const fn = codeOnly(blockAfter(JS, 'setupSummaryDisclosure() {'));
    assert.match(fn, /getElementById\('checkout-total'\)/);
    assert.match(fn, /MutationObserver/, 'observe the one element rather than patch four call sites');
    assert.doesNotMatch(fn, /formatPrice|calculateGST|\* 1\.15|this\.totals/,
        'this function must not do arithmetic on money');
});

test('§3 an unresolved total shows nothing, never $0.00', () => {
    const fn = blockAfter(JS, 'setupSummaryDisclosure() {');
    assert.doesNotMatch(fn, /\$0\.00/, 'absence is not zero — ERR-063/068');
    const mobile = COMPACT.slice(COMPACT.indexOf('MOBILE ORDER-SUMMARY DISCLOSURE'));
    assert.match(mobile, /\.checkout-summary__toggle-total:empty\s*\{\s*display:\s*none/,
        'and an empty label must not render as an empty pill');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The grid child that never got its sibling's fix
// ═══════════════════════════════════════════════════════════════════════════

test('§4 .checkout-sidebar can shrink below its min-content', () => {
    // codeOnly: the comment inside this very rule quotes "min-width: 0" while
    // explaining it, so a raw match passes with the declaration deleted. Third
    // time this shape has bitten in one session (see the X-Session-Id and the
    // /1.15 bans in ads-add-to-cart-conversion-sep2026).
    const rule = codeOnly(blockAfter(COMPACT, '.checkout-sidebar {'));
    assert.match(rule, /min-width:\s*0/,
        'a grid child defaults to min-width:auto; its 390px min-content forced the ' +
        '358px mobile column 16px off-screen, clipping the price');
});

test('§4 and its sibling still has the same fix', () => {
    // The pair is the point: one of them had it and the other did not.
    const all = codeOnly(PAGES + COMPACT + read('inkcartridges/css/layout.css'));
    assert.match(all, /\.checkout-form-wrapper[^}]*min-width:\s*0/s,
        'if this ever disappears the same overflow returns from the other side');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. The nudge no longer interrupts before anything has been seen
// ═══════════════════════════════════════════════════════════════════════════

test('§5 the rewards nudge waits for a scroll', () => {
    // Measured at 390x844 on /ink-cartridges: on a 3s timer it covered 27.5% of
    // the first screen with ZERO product cards rendered.
    assert.match(NUDGE, /trigger:\s*'scroll'/);
    assert.match(NUDGE, /scrollThresholdPx:\s*\d+/);
    assert.match(NUDGE, /function scheduleByTrigger\(/);
});

test('§5 delayMs is a floor in BOTH modes, never the whole condition', () => {
    const fn = blockAfter(NUDGE, 'function scheduleByTrigger(');
    assert.match(fn, /CAMPAIGN\.delayMs/);
    assert.match(fn, /floorPassed/, 'the dwell floor still applies before a scroll can fire it');
    assert.match(fn, /scrolledEnough/);
});

test('§5 there is deliberately NO timer fallback in scroll mode', () => {
    // A visitor who never scrolled has not looked at anything. Showing them the
    // nudge anyway is precisely the behaviour being replaced, so a "fallback"
    // here would quietly restore the bug.
    const fn = blockAfter(NUDGE, 'function scheduleByTrigger(');
    // Everything after the non-scroll early return is the scroll path.
    const guard = fn.indexOf("CAMPAIGN.trigger !== 'scroll'");
    const scrollPath = fn.slice(fn.indexOf('}', fn.indexOf('return;', guard)));
    assert.doesNotMatch(scrollPath, /setTimeout\(tryShow/,
        'in scroll mode nothing may call tryShow on a timer — that IS the old behaviour');
    // The one timer on this path is the dwell floor, and it must not show anything itself.
    const timers = (scrollPath.match(/setTimeout\(/g) || []).length;
    assert.equal(timers, 1, `expected exactly one setTimeout (the dwell floor), found ${timers}`);
    assert.match(scrollPath, /floorPassed = true/, 'and that timer only lifts the floor');
});

test('§5 the listener is passive and unhooks itself', () => {
    const fn = blockAfter(NUDGE, 'function scheduleByTrigger(');
    assert.match(fn, /\{ passive: true \}/, 'never block scrolling for an ad');
    assert.match(fn, /removeEventListener\('scroll', attempt\)/);
});

test('§5 the timer mode still works for anything configured to use it', () => {
    const fn = blockAfter(NUDGE, 'function scheduleByTrigger(');
    assert.match(fn, /if \(CAMPAIGN\.trigger !== 'scroll'\)[\s\S]{0,120}setTimeout\(tryShow, CAMPAIGN\.delayMs\)/);
});

test('§5 the mid-funnel skip is untouched', () => {
    assert.match(NUDGE, /skipPaths:\s*\['\/cart'\]/, 'never interrupt a shopper mid-funnel');
});
